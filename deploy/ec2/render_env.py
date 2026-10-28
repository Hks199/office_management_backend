#!/usr/bin/env python3
"""Render only supported GitHub deployment settings; never print their values."""
import argparse
import json
import os
from pathlib import Path
import re
import sys

REQUIRED = ["MONGODB_URI","JWT_SECRET","TOKEN_ENCRYPTION_KEY","CORS_ORIGINS","CREDENTIAL_UI_ORIGIN","AWS_REGION","S3_BUCKET"]
DEFAULTS = {
    "TRUST_PROXY_HOPS": "1",
    "LOG_LEVEL": "info",
    "RATE_LIMIT_MAX": "100",
    "RATE_LIMIT_WINDOW_MS": "60000",
    "MONGODB_MAX_POOL_SIZE": "20",
    "MONGODB_SERVER_SELECTION_TIMEOUT_MS": "5000",
    "MONGODB_WAIT_QUEUE_TIMEOUT_MS": "2000",
    "SLOW_QUERY_MS": "1000",
    "BODY_LIMIT_BYTES": "102400",
    "SHUTDOWN_TIMEOUT_MS": "10000",
    "JWT_ISSUER": "sunvika-office-api",
    "JWT_AUDIENCE": "sunvika-office-web",
    "ACCESS_TTL_SECONDS": "600",
    "REFRESH_TTL_DAYS": "7",
    "REFRESH_ABSOLUTE_DAYS": "30",
    "CREDENTIAL_DELIVERY_ENABLED": "false",
    "CREDENTIAL_DELIVERY_INTERVAL_MS": "5000",
    "COMMERCIAL_JOBS_ENABLED": "false",
    "COMMERCIAL_JOBS_INTERVAL_MS": "5000",
    "SMTP_HOST": "",
    "SMTP_PORT": "587",
    "SMTP_SECURE": "false",
    "SMTP_USER": "",
    "SMTP_PASSWORD": "",
    "MAIL_FROM": ""
}
KEYS = (*REQUIRED, *DEFAULTS)


def configuration(environment):
    missing = [key for key in REQUIRED if not environment.get(key, "").strip()]
    if missing:
        raise ValueError("Missing GitHub secrets/variables: " + ", ".join(missing))
    settings = {
        key: environment.get(key) or DEFAULTS.get(key, "")
        for key in KEYS
    }
    for key, value in settings.items():
        if any(character in value for character in ("\r", "\n", "\0")):
            raise ValueError("Setting must be a single line: " + key)
    if not 48 <= len(settings["JWT_SECRET"]) <= 512:
        raise ValueError("JWT_SECRET must contain 48 to 512 characters")
    if not re.fullmatch(r"[0-9a-fA-F]{64}", settings["TOKEN_ENCRYPTION_KEY"]):
        raise ValueError("TOKEN_ENCRYPTION_KEY must contain 64 hexadecimal characters")
    if settings["JWT_SECRET"] == settings["TOKEN_ENCRYPTION_KEY"]:
        raise ValueError("JWT_SECRET and TOKEN_ENCRYPTION_KEY must be independent")
    return settings


def encode(settings):
    # Compose expands $$ to a literal dollar in double-quoted dotenv values.
    # JSON quoting preserves quotes, backslashes, tabs, #, and surrounding spaces.
    return "".join(
        key + "=" + json.dumps(value.replace("$", "$$"), ensure_ascii=False) + "\n"
        for key, value in settings.items()
    )


def render(environment, output_dir):
    settings = configuration(environment)
    migrate = environment.get("RUN_INDEX_MIGRATION", "false")
    if migrate not in ("true", "false"):
        raise ValueError("RUN_INDEX_MIGRATION must be true or false")
    files = {"backend.env": settings}
    if migrate == "true":
        migration = dict(settings)
        migration["MONGODB_URI"] = environment.get("MIGRATION_MONGODB_URI") or settings["MONGODB_URI"]
        if any(character in migration["MONGODB_URI"] for character in ("\r", "\n", "\0")):
            raise ValueError("Setting must be a single line: MIGRATION_MONGODB_URI")
        files["migrate.env"] = migration

    output_dir = Path(output_dir)
    output_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    created = []
    try:
        for name, values in files.items():
            destination = output_dir / name
            descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            created.append(destination)
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
                stream.write(encode(values))
    except BaseException:
        for path in created:
            path.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        render(os.environ, args.output_dir)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 1
    except OSError:
        print("Unable to create private deployment environment files", file=sys.stderr)
        return 1
    print("Prepared private deployment environment from GitHub settings.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
