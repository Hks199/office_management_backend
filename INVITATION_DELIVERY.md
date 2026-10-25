# Automatic invitation delivery

Employee creation and password recovery queue encrypted credentials in MongoDB. The API now starts a delivery worker after connecting to MongoDB and binding HTTP. With SMTP configured, it immediately processes pending messages and repeats every five seconds. Keep the API running; no manual delivery command is needed for each employee.

## Configuration

Keep SMTP_HOST, MAIL_FROM and any SMTP_USER/SMTP_PASSWORD in the private backend environment. SMTP credentials must be paired. Port 587 requires STARTTLS; port 465 uses SMTP_SECURE=true. CREDENTIAL_UI_ORIGIN must match the frontend origin. Both Docker Compose configurations forward these settings.

- CREDENTIAL_DELIVERY_ENABLED defaults to true.
- CREDENTIAL_DELIVERY_INTERVAL_MS defaults to 5000 and accepts 1000–60000.
- Missing SMTP logs a startup warning and leaves jobs queued.
- Set CREDENTIAL_DELIVERY_ENABLED=false only if a separate scheduler runs the existing delivery command.

## Reliability and diagnosis

The worker uses the existing MongoDB outbox: atomic claims, two-minute leases, one-minute retry delay, and a maximum of five attempts. Multiple API instances cannot claim the same current lease. Batches do not overlap within an instance. Shutdown stops new claims and drains current work within the service shutdown deadline; a process interruption leaves durable jobs for recovery after the lease expires.

Logs and the restricted delivery collection retain safe error categories instead of raw SMTP errors. Investigate SMTP_AUTHENTICATION_FAILED, SMTP_CONNECTION_FAILED, SMTP_TIMEOUT, SMTP_REJECTED, TOKEN_DECRYPTION_FAILED or DELIVERY_FAILED without printing tokens, ciphertext, recipients or credentials. After correcting configuration, remaining eligible jobs retry automatically. For an expired or exhausted invitation, set INVITATION_EMPLOYEE_CODE in the restricted backend environment and run `npm run invite:reissue`; automatic delivery handles the replacement.

SENT confirms acceptance by SMTP, not inbox placement. Check the recipient spam folder and provider delivery records if a SENT message is missing. A crash after SMTP acceptance but before the database acknowledgement can duplicate a message; its setup token remains single-use.

## Verification on 2026-10-19

Worker tests cover immediate startup, non-overlapping batches, failure recovery, secret-free logs and shutdown. Runtime tests verify that background work drains before database disconnect. Isolated MongoDB integration tests verify automatic delivery, cancellation, safe SMTP error categories and concurrent lease claims using injected senders.

The full regression suite passed: 274 tests across 22 files. Lint, TypeScript checking, the production build and production Compose configuration validation also passed.

After the updated API restarted locally, the previously pending employee invitation changed to SENT with one attempt. The backend readiness endpoint returned ready. This live check confirms SMTP acceptance; recipient inbox placement was not inspected.
