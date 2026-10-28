#!/usr/bin/env python3
"""Verify a Docker archive's portable config digest and resolve its local image ID."""
import argparse
import hashlib
import json
from pathlib import PurePosixPath
import re
import subprocess
import sys
import tarfile

MAX_JSON_BYTES = 4 * 1024 * 1024
_SHA256 = re.compile(r"sha256:[0-9a-f]{64}")


def archive_identity(stream, expected_tag=None):
    """Read a save stream without extracting files or retaining image layers."""
    manifest = None
    configs = {}
    oversized = set()
    seen = set()
    with tarfile.open(fileobj=stream, mode="r|*") as archive:
        for member in archive:
            name = member.name
            if name in seen:
                raise ValueError("Duplicate image archive member")
            seen.add(name)
            if not member.isfile():
                continue
            is_manifest = name == "manifest.json"
            is_metadata = is_manifest or name.endswith(".json") or name.startswith("blobs/sha256/")
            if not is_metadata:
                continue
            if member.size > MAX_JSON_BYTES:
                if is_manifest:
                    raise ValueError("Image manifest is too large")
                oversized.add(name)
                continue
            source = archive.extractfile(member)
            if source is None:
                raise ValueError("Image archive metadata is unreadable")
            with source:
                raw = source.read(MAX_JSON_BYTES + 1)
            if len(raw) > MAX_JSON_BYTES:
                raise ValueError("Image archive metadata is too large")
            try:
                value = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                if is_manifest:
                    raise ValueError("Invalid image manifest JSON") from None
                continue
            if is_manifest:
                manifest = value
            elif isinstance(value, dict) and "rootfs" in value:
                configs[name] = {
                    "digest": "sha256:" + hashlib.sha256(raw).hexdigest(),
                    "os": value.get("os"),
                    "architecture": value.get("architecture"),
                    "rootfs": value.get("rootfs"),
                }

    if not isinstance(manifest, list) or len(manifest) != 1 or not isinstance(manifest[0], dict):
        raise ValueError("Expected one Docker image in the archive")
    entry = manifest[0]
    if expected_tag is not None and entry.get("RepoTags") != [expected_tag]:
        raise ValueError("Image archive does not contain the expected release tag")
    config_name = entry.get("Config")
    if not isinstance(config_name, str) or not config_name:
        raise ValueError("Image manifest has no config")
    path = PurePosixPath(config_name)
    if path.is_absolute() or ".." in path.parts or str(path) != config_name:
        raise ValueError("Invalid image config path")
    if config_name in oversized:
        raise ValueError("Image config is too large")
    config = configs.get(config_name)
    if config is None:
        raise ValueError("Image config is missing or invalid")
    if config["os"] != "linux" or config["architecture"] != "amd64":
        raise ValueError("Release image must target linux/amd64")
    rootfs = config["rootfs"]
    if (
        not isinstance(rootfs, dict)
        or rootfs.get("type") != "layers"
        or not isinstance(rootfs.get("diff_ids"), list)
        or any(not isinstance(item, str) or not _SHA256.fullmatch(item) for item in rootfs["diff_ids"])
    ):
        raise ValueError("Image config has invalid layer identities")
    return config["digest"]


def _inspect(reference):
    try:
        result = subprocess.run(
            ["docker", "image", "inspect", "--format", "{{json .}}", reference],
            check=True, capture_output=True, text=True,
        )
    except subprocess.CalledProcessError:
        raise ValueError("Could not inspect the loaded Docker image") from None
    try:
        metadata = json.loads(result.stdout)
    except ValueError:
        raise ValueError("Invalid Docker image inspection result") from None
    if not isinstance(metadata, dict) or not isinstance(metadata.get("Id"), str) or not _SHA256.fullmatch(metadata["Id"]):
        raise ValueError("Docker returned an invalid image ID")
    if metadata.get("Os") != "linux" or metadata.get("Architecture") != "amd64":
        raise ValueError("Loaded image must target linux/amd64")
    return metadata


def resolve_identity(tag, expected_config_sha):
    """Verify loaded content, then return an immutable ID understood by this daemon."""
    if not _SHA256.fullmatch(expected_config_sha):
        raise ValueError("Invalid expected image config digest")
    metadata = _inspect(tag)
    if not isinstance(metadata.get("RepoTags"), list) or tag not in metadata["RepoTags"]:
        raise ValueError("Loaded Docker image has the wrong release tag")
    local_id = metadata["Id"]
    export = subprocess.Popen(["docker", "image", "save", local_id], stdout=subprocess.PIPE)
    try:
        try:
            config_sha = archive_identity(export.stdout)
        finally:
            # Drain even when parsing fails. Docker must finish writing its tar
            # stream instead of failing with SIGPIPE after an early config match.
            while export.stdout.read(1024 * 1024):
                pass
    finally:
        export.stdout.close()
        returncode = export.wait()
    if returncode != 0:
        raise ValueError("Docker image export failed")
    if config_sha != expected_config_sha:
        raise ValueError("Loaded image config does not match the checked release")
    if _inspect(local_id)["Id"] != local_id:
        raise ValueError("Loaded Docker image ID changed during verification")
    return local_id


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    archive = commands.add_parser("archive")
    archive.add_argument("path")
    archive.add_argument("tag")
    resolve = commands.add_parser("resolve")
    resolve.add_argument("tag")
    resolve.add_argument("config_sha")
    args = parser.parse_args()
    try:
        if args.command == "archive":
            with open(args.path, "rb") as stream:
                result = archive_identity(stream, args.tag)
        else:
            result = resolve_identity(args.tag, args.config_sha)
    except (ValueError, OSError, subprocess.SubprocessError, tarfile.TarError) as error:
        print("Image verification failed: " + str(error), file=sys.stderr)
        return 1
    print(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
