"""Image identity tests use synthetic archives and mocked Docker, never app settings."""
import hashlib
import io
import json
import subprocess
import sys
import tempfile
from pathlib import Path
import tarfile
import unittest
from unittest import mock

import image_identity


TAG = "sunvika-office-api:" + "a" * 40 + "-123-1"
NATIVE_ID = "sha256:" + "b" * 64
RAW_CONFIG = b'{ "os": "linux", "architecture": "amd64", "rootfs": {"type":"layers", "diff_ids":[]}, "config": {"Env":["SYNTHETIC=yes"]} }\n'
CONFIG_SHA = "sha256:" + hashlib.sha256(RAW_CONFIG).hexdigest()
CONFIG_PATH = "blobs/sha256/" + CONFIG_SHA.split(":", 1)[1]


class ForwardOnly:
    """A pipe-like reader that makes accidental seeks fail immediately."""

    def __init__(self, data):
        self.source = io.BytesIO(data)
        self.read_bytes = 0

    def read(self, size=-1):
        value = self.source.read(size)
        self.read_bytes += len(value)
        return value

    def seek(self, *args):
        raise AssertionError("Image archives must support non-seekable Docker output")


def manifest(config_path=CONFIG_PATH, tags=None):
    return [{"Config": config_path, "RepoTags": [TAG] if tags is None else tags,
             "Layers": ["layers/synthetic.tar"]}]


def archive_bytes(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        for name, value in entries:
            member = tarfile.TarInfo(name)
            if isinstance(value, tarfile.TarInfo):
                archive.addfile(value)
            else:
                member.size = len(value)
                archive.addfile(member, io.BytesIO(value))
    return output.getvalue()


def fixture(raw_config=RAW_CONFIG, manifests=None, config_path=CONFIG_PATH, layer_last=False):
    selected = manifest(config_path) if manifests is None else manifests
    entries = [(config_path, raw_config), ("manifest.json", json.dumps(selected).encode())]
    layer = ("layers/synthetic.tar", b"x" * (96 * 1024 + 19))
    entries.append(layer) if layer_last else entries.insert(0, layer)
    return archive_bytes(entries)


class ArchiveIdentityTests(unittest.TestCase):
    def test_hashes_raw_config_without_reencoding_json(self):
        self.assertEqual(image_identity.archive_identity(io.BytesIO(fixture()), TAG), CONFIG_SHA)
        canonical = json.dumps(json.loads(RAW_CONFIG), sort_keys=True).encode()
        self.assertNotEqual(CONFIG_SHA, "sha256:" + hashlib.sha256(canonical).hexdigest())

    def test_streaming_config_before_manifest_and_layer_at_either_end(self):
        for layer_last in (False, True):
            with self.subTest(layer_last=layer_last):
                raw = fixture(layer_last=layer_last)
                stream = ForwardOnly(raw)
                self.assertEqual(image_identity.archive_identity(stream, TAG), CONFIG_SHA)
                self.assertGreater(stream.read_bytes, 96 * 1024)

    def test_streaming_manifest_before_config(self):
        raw = archive_bytes([
            ("manifest.json", json.dumps(manifest()).encode()),
            (CONFIG_PATH, RAW_CONFIG),
            ("layers/synthetic.tar", b"ignored-layer"),
        ])
        self.assertEqual(image_identity.archive_identity(ForwardOnly(raw), TAG), CONFIG_SHA)

    def test_optional_tag_allows_digest_only_export(self):
        raw = fixture(manifests=manifest(tags=[]))
        self.assertEqual(image_identity.archive_identity(ForwardOnly(raw)), CONFIG_SHA)

    def test_empty_rootfs_is_valid_scratch_image(self):
        self.assertEqual(image_identity.archive_identity(io.BytesIO(fixture()), TAG), CONFIG_SHA)

    def test_classic_docker_config_filename(self):
        classic_path = CONFIG_SHA.split(":", 1)[1] + ".json"
        self.assertEqual(image_identity.archive_identity(io.BytesIO(fixture(config_path=classic_path)), TAG), CONFIG_SHA)

    def test_missing_manifest_and_missing_config_fail(self):
        cases = [
            [(CONFIG_PATH, RAW_CONFIG)],
            [("manifest.json", json.dumps(manifest()).encode())],
        ]
        for entries in cases:
            with self.subTest(entries=[entry[0] for entry in entries]):
                with self.assertRaises(ValueError):
                    image_identity.archive_identity(io.BytesIO(archive_bytes(entries)), TAG)

    def test_multiple_or_empty_manifests_fail(self):
        for selected in ([], manifest() + manifest(), {}, None):
            with self.subTest(manifests=selected):
                raw = archive_bytes([(CONFIG_PATH, RAW_CONFIG), ("manifest.json", json.dumps(selected).encode())])
                with self.assertRaises(ValueError):
                    image_identity.archive_identity(io.BytesIO(raw), TAG)

    def test_unexpected_release_tag_is_rejected(self):
        for tags in ([], ["sunvika-office-api:other"], [TAG, "sunvika-office-api:other"], [TAG, TAG], TAG):
            with self.subTest(tags=tags):
                with self.assertRaises(ValueError):
                    image_identity.archive_identity(io.BytesIO(fixture(manifests=manifest(tags=tags))), TAG)

    def test_duplicate_manifest_or_config_is_rejected(self):
        base = [(CONFIG_PATH, RAW_CONFIG), ("manifest.json", json.dumps(manifest()).encode())]
        for duplicate in base:
            with self.subTest(duplicate=duplicate[0]):
                with self.assertRaises(ValueError):
                    image_identity.archive_identity(io.BytesIO(archive_bytes(base + [duplicate])), TAG)

    def test_unsafe_config_reference_is_rejected(self):
        for path in ("../config.json", "/config.json", "a/../../config.json", "", None):
            with self.subTest(path=path):
                raw = archive_bytes([("manifest.json", json.dumps(manifest(config_path=path)).encode()), (CONFIG_PATH, RAW_CONFIG)])
                with self.assertRaises(ValueError):
                    image_identity.archive_identity(io.BytesIO(raw), TAG)

    def test_config_symlink_cannot_substitute_for_regular_file(self):
        member = tarfile.TarInfo(CONFIG_PATH)
        member.type = tarfile.SYMTYPE
        member.linkname = "another-config"
        raw = archive_bytes([("manifest.json", json.dumps(manifest()).encode()), (CONFIG_PATH, member)])
        with self.assertRaises(ValueError):
            image_identity.archive_identity(io.BytesIO(raw), TAG)

    def test_malformed_json_is_rejected(self):
        for bad_name in (CONFIG_PATH, "manifest.json"):
            with self.subTest(member=bad_name):
                entries = [(CONFIG_PATH, RAW_CONFIG), ("manifest.json", json.dumps(manifest()).encode())]
                entries = [(name, b"{invalid-json" if name == bad_name else value) for name, value in entries]
                with self.assertRaises(ValueError):
                    image_identity.archive_identity(io.BytesIO(archive_bytes(entries)), TAG)

    def test_wrong_platform_is_rejected(self):
        for field, value in (("os", "windows"), ("architecture", "arm64")):
            with self.subTest(field=field):
                config = json.loads(RAW_CONFIG)
                config[field] = value
                with self.assertRaises(ValueError):
                    image_identity.archive_identity(io.BytesIO(fixture(raw_config=json.dumps(config).encode())), TAG)

    def test_invalid_rootfs_diff_ids_are_rejected(self):
        invalid = (None, {}, {"type": "layers", "diff_ids": "sha256:" + "a" * 64},
                   {"type": "layers", "diff_ids": ["not-a-digest"]},
                   {"type": "layers", "diff_ids": [None]})
        for rootfs in invalid:
            with self.subTest(rootfs=rootfs):
                config = json.loads(RAW_CONFIG)
                config["rootfs"] = rootfs
                with self.assertRaises(ValueError):
                    image_identity.archive_identity(io.BytesIO(fixture(raw_config=json.dumps(config).encode())), TAG)

    def test_valid_rootfs_diff_id_is_accepted(self):
        config = json.loads(RAW_CONFIG)
        config["rootfs"]["diff_ids"] = ["sha256:" + "d" * 64]
        raw_config = json.dumps(config).encode()
        expected = "sha256:" + hashlib.sha256(raw_config).hexdigest()
        self.assertEqual(image_identity.archive_identity(io.BytesIO(fixture(raw_config=raw_config)), TAG), expected)

    def test_oversized_config_json_is_rejected(self):
        config = json.loads(RAW_CONFIG)
        config["config"]["Labels"] = {"synthetic": "x" * (4 * 1024 * 1024)}
        with self.assertRaises(ValueError):
            image_identity.archive_identity(io.BytesIO(fixture(raw_config=json.dumps(config).encode())), TAG)


class TrackedExport(io.BytesIO):
    def __init__(self, payload):
        super().__init__(payload)
        self.payload_size = len(payload)
        self.final_position = None

    def close(self):
        if not self.closed:
            self.final_position = self.tell()
        super().close()

class ResolveIdentityTests(unittest.TestCase):
    def inspection(self, image_id=NATIVE_ID, **changes):
        data = {"Id": image_id, "Os": "linux", "Architecture": "amd64", "RepoTags": [TAG]}
        data.update(changes)
        return subprocess.CompletedProcess([], 0, stdout=json.dumps(data), stderr="")

    def exporter(self, payload=None, code=0):
        process = mock.Mock()
        process.stdout = TrackedExport(fixture(manifests=manifest(tags=[])) if payload is None else payload)
        process.wait.return_value = code
        process.returncode = code
        return process

    def resolve(self, inspections=None, exporter=None, expected=CONFIG_SHA):
        selected = [self.inspection(), self.inspection()] if inspections is None else inspections
        process = self.exporter() if exporter is None else exporter
        with mock.patch.object(image_identity.subprocess, "run", side_effect=selected) as inspect_call:
            with mock.patch.object(image_identity.subprocess, "Popen", return_value=process) as export_call:
                result = image_identity.resolve_identity(TAG, expected)
        return result, inspect_call, export_call, process

    def test_cross_store_ids_verify_config_and_return_host_native_id(self):
        self.assertNotEqual(NATIVE_ID, CONFIG_SHA)
        result, inspect_call, export_call, process = self.resolve()
        self.assertEqual(result, NATIVE_ID)
        self.assertEqual(inspect_call.call_count, 2)
        self.assertIn(NATIVE_ID, export_call.call_args.args[0])
        self.assertIn(NATIVE_ID, inspect_call.call_args_list[1].args[0])
        process.wait.assert_called_once()

    def test_classic_store_with_config_id_is_also_accepted(self):
        inspections = [self.inspection(CONFIG_SHA), self.inspection(CONFIG_SHA)]
        self.assertEqual(self.resolve(inspections=inspections)[0], CONFIG_SHA)

    def test_changed_content_is_rejected(self):
        config = json.loads(RAW_CONFIG)
        config["config"]["Env"] = ["SYNTHETIC=changed"]
        payload = fixture(raw_config=json.dumps(config).encode(), manifests=manifest(tags=[]))
        with self.assertRaises(ValueError):
            self.resolve(exporter=self.exporter(payload=payload))

    def test_wrong_platform_tag_or_invalid_id_is_rejected_before_export(self):
        changes = ({"Os": "windows"}, {"Architecture": "arm64"}, {"RepoTags": ["other:release"]},
                   {"RepoTags": None}, {"Id": "not-an-immutable-id"})
        for change in changes:
            with self.subTest(change=change):
                with mock.patch.object(image_identity.subprocess, "run", return_value=self.inspection(**change)):
                    with mock.patch.object(image_identity.subprocess, "Popen") as export_call:
                        with self.assertRaises(ValueError):
                            image_identity.resolve_identity(TAG, CONFIG_SHA)
                        export_call.assert_not_called()

    def test_nonzero_export_exit_rejects_otherwise_valid_archive(self):
        with self.assertRaises((ValueError, subprocess.SubprocessError)):
            self.resolve(exporter=self.exporter(code=17))

    def test_export_output_is_drained_even_when_archive_is_rejected(self):
        # Trailing bytes simulate a producer that must finish before wait().
        process = self.exporter(payload=fixture(raw_config=b"{}") + b"trailing-producer-output" * 4096)
        with self.assertRaises(ValueError):
            self.resolve(exporter=process)
        self.assertEqual(process.stdout.final_position, process.stdout.payload_size)
        process.wait.assert_called_once()

    def test_changed_native_id_during_recheck_is_rejected(self):
        inspections = [self.inspection(), self.inspection("sha256:" + "e" * 64)]
        with self.assertRaises(ValueError):
            self.resolve(inspections=inspections)

    def test_missing_native_id_on_recheck_propagates_failure(self):
        failure = subprocess.CalledProcessError(1, ["docker", "image", "inspect", NATIVE_ID])
        with self.assertRaises((ValueError, subprocess.SubprocessError)):
            self.resolve(inspections=[self.inspection(), failure])

    def test_invalid_expected_config_digest_is_rejected(self):
        with self.assertRaises(ValueError):
            self.resolve(expected="not-a-digest")

class ArchiveCommandTests(unittest.TestCase):
    def command(self, archive):
        with tempfile.TemporaryDirectory() as folder:
            archive_path = Path(folder, "synthetic-image.tar")
            archive_path.write_bytes(archive)
            return subprocess.run(
                [sys.executable, "-B", str(Path(image_identity.__file__)), "archive", str(archive_path), TAG],
                capture_output=True, text=True, check=False,
            )

    def test_archive_cli_prints_only_config_digest(self):
        result = self.command(fixture())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), CONFIG_SHA)
        self.assertEqual(result.stderr, "")

    def test_archive_cli_rejects_bad_config_without_printing_contents(self):
        marker = "synthetic-config-content-must-not-be-printed"
        raw = json.dumps({"os": marker, "architecture": "amd64", "rootfs": {"type": "layers", "diff_ids": []}}).encode()
        result = self.command(fixture(raw_config=raw))
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(marker, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "")

if __name__ == "__main__":
    unittest.main()