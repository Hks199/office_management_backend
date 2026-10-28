"""Deployment configuration tests use synthetic values, never the local .env."""
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest

import render_env

ROOT = Path(__file__).resolve().parents[2]


def fixture():
    return {
        "MONGODB_URI": "mongodb://runtime:synthetic@mongo.invalid/office?replicaSet=rs0&tls=true",
        "JWT_SECRET": "synthetic-test-signing-value-" * 3,
        "TOKEN_ENCRYPTION_KEY": "ab" * 32,
        "CORS_ORIGINS": "https://sunvika.example.com",
        "CREDENTIAL_UI_ORIGIN": "https://sunvika.example.com",
        "AWS_REGION": "ap-south-2",
        "S3_BUCKET": "synthetic-private-media",
    }


class EnvironmentTests(unittest.TestCase):
    def test_missing_settings_fail_before_creating_files(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "private"
            with self.assertRaisesRegex(ValueError, "Missing GitHub secrets/variables: MONGODB_URI"):
                render_env.render({}, output)
            self.assertFalse(output.exists())

    def test_defaults_and_whitelist(self):
        environment = fixture()
        environment.update(EC2_SSH_KEY="must-not-be-copied", UNKNOWN="ignored")
        values = render_env.configuration(environment)
        self.assertNotIn("EC2_SSH_KEY", values)
        self.assertNotIn("UNKNOWN", values)
        self.assertEqual(values["TRUST_PROXY_HOPS"], "1")
        self.assertEqual(values["CREDENTIAL_DELIVERY_ENABLED"], "false")

    def test_migration_uses_matching_settings_and_optional_identity(self):
        environment = fixture()
        environment.update(
            RUN_INDEX_MIGRATION="true",
            MIGRATION_MONGODB_URI="mongodb://migration:synthetic@mongo.invalid/office?tls=true",
        )
        with tempfile.TemporaryDirectory() as temp:
            render_env.render(environment, temp)
            runtime = Path(temp, "backend.env").read_text(encoding="utf-8")
            migration = Path(temp, "migrate.env").read_text(encoding="utf-8")
            expected = render_env.configuration(environment)
            expected["MONGODB_URI"] = environment["MIGRATION_MONGODB_URI"]
            self.assertEqual(migration, render_env.encode(expected))
            self.assertNotIn("migration:synthetic", runtime)
            self.assertNotIn("MIGRATION_MONGODB_URI=", migration)

    def test_migration_can_use_runtime_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            environment = fixture()
            environment["RUN_INDEX_MIGRATION"] = "true"
            render_env.render(environment, temp)
            self.assertEqual(
                Path(temp, "backend.env").read_bytes(),
                Path(temp, "migrate.env").read_bytes(),
            )

    def test_disabled_migration_does_not_write_migration_credentials(self):
        with tempfile.TemporaryDirectory() as temp:
            environment = fixture()
            environment["MIGRATION_MONGODB_URI"] = "unused"
            render_env.render(environment, temp)
            self.assertFalse(Path(temp, "migrate.env").exists())

    def test_injection_error_names_only_the_setting(self):
        for key in ("SMTP_PASSWORD", "MONGODB_URI", "MIGRATION_MONGODB_URI"):
            environment = fixture()
            environment.update(RUN_INDEX_MIGRATION="true")
            environment[key] = "do-not-log-this\nEVIL=injected"
            with tempfile.TemporaryDirectory() as temp:
                with self.assertRaises(ValueError) as error:
                    render_env.render(environment, temp)
                self.assertEqual(str(error.exception), "Setting must be a single line: " + key)
                self.assertEqual(list(Path(temp).iterdir()), [])

    def test_invalid_encryption_key_reports_no_value(self):
        environment = fixture()
        environment["TOKEN_ENCRYPTION_KEY"] = "do-not-log"
        with self.assertRaisesRegex(ValueError, "^TOKEN_ENCRYPTION_KEY must contain 64 hexadecimal characters$"):
            render_env.configuration(environment)

    def test_partial_write_failure_removes_new_files_preserves_existing(self):
        with tempfile.TemporaryDirectory() as temp:
            Path(temp, "migrate.env").write_text("existing", encoding="utf-8")
            environment = fixture()
            environment["RUN_INDEX_MIGRATION"] = "true"
            with self.assertRaises(FileExistsError):
                render_env.render(environment, temp)
            self.assertFalse(Path(temp, "backend.env").exists())
            self.assertEqual(Path(temp, "migrate.env").read_text(encoding="utf-8"), "existing")

    @unittest.skipIf(os.name == "nt", "POSIX permissions are verified on Linux")
    def test_files_are_private(self):
        with tempfile.TemporaryDirectory() as temp:
            destination = Path(temp) / "private"
            render_env.render(fixture(), destination)
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((destination / "backend.env").stat().st_mode), 0o600)

    def test_workflow_maps_every_supported_key_explicitly(self):
        workflow = (ROOT / ".github/workflows/deploy.yaml").read_text(encoding="utf-8")
        for key in (*render_env.KEYS, "MIGRATION_MONGODB_URI"):
            self.assertIn(key + ": ${{ secrets." + key + " || vars." + key + " }}", workflow)

    @unittest.skipUnless(shutil.which("docker"), "Docker Compose CLI is unavailable")
    def test_special_characters_round_trip_through_real_compose(self):
        environment = fixture()
        special = "literal$NAME${NAME}$$ # 'quote' \"double\" \\tab\tbackslash\\"
        environment["JWT_SECRET"] = special
        environment["SMTP_PASSWORD"] = " password $with#quotes'\" and\\slashes\\ "
        with tempfile.TemporaryDirectory() as temp:
            render_env.render(environment, temp)
            command = [
                "docker", "compose", "--env-file", str(Path(temp, "backend.env")),
                "--file", str(ROOT / "docker-compose.production.yml"), "config",
            ]
            process_env = dict(os.environ)
            for key in (*render_env.KEYS, "API_IMAGE", "COMPOSE_ENV_FILES", "COMPOSE_FILE"):
                process_env.pop(key, None)
            process_env["COMPOSE_DISABLE_ENV_FILE"] = "1"
            resolved = subprocess.run(command + ["--environment"], env=process_env, capture_output=True, text=True)
            self.assertEqual(resolved.returncode, 0, "Compose could not parse the synthetic environment")
            parsed = dict(line.split("=", 1) for line in resolved.stdout.splitlines() if "=" in line)
            for key, value in render_env.configuration(environment).items():
                self.assertEqual(parsed[key], value, key)
            resolved = subprocess.run(command + ["--format", "json"], env=process_env, capture_output=True, text=True)
            self.assertEqual(resolved.returncode, 0, "Compose could not resolve the production configuration")
            container_env = json.loads(resolved.stdout)["services"]["api"]["environment"]
            # Compose escapes dollars in serialized config so it can be read again.
            self.assertEqual(container_env["JWT_SECRET"].replace("$$", "$"), special)
            self.assertEqual(container_env["SMTP_PASSWORD"].replace("$$", "$"), environment["SMTP_PASSWORD"])


if __name__ == "__main__":
    unittest.main()
