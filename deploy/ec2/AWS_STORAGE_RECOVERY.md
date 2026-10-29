# Restore hosted S3 access

## What was found

The local backend environment contains AWS credential variables (their validity was not tested).
Previously, production Compose passed only AWS_REGION and S3_BUCKET. The deployment workflow
and environment renderer also omitted the credential variables, so local keys never reached
the hosted container. An instance without an accessible IAM role then has no credentials.
The same UI error can also mean an invalid signature or expired credentials; the running
server has not been inspected from this workspace.

The fix passes optional AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN
through GitHub secrets, the private generated backend.env, and production Compose.
Incomplete pairs and temporary keys without a token fail before deployment. Empty keys
preserve the SDK default credential chain for an EC2 IAM role. No credential values are
committed, printed, copied from the local environment, or sent to the frontend.

## Deploy the fix using the existing GitHub workflow

1. In the BACKEND repository, open Settings > Environments > production > Environment secrets.
2. Add AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY with the current valid replacement pair.
   For temporary credentials also add the matching AWS_SESSION_TOKEN; they must be refreshed
   before expiry. For long-lived credentials remove any stale AWS_SESSION_TOKEN secret.
   Do not reuse the exposed pair previously shared in chat. Do not add keys to Netlify,
   VITE_ variables, GitHub ordinary variables, or tracked files.
3. Set AWS_REGION=ap-south-2 and S3_BUCKET=sunvika-media in the backend production environment
   variables (or secrets). Keep the existing database, authentication, SMTP and frontend settings.
4. Commit and push these backend deployment changes to main. Wait for Backend checks to pass,
   then for Deploy office backend to EC2 to succeed. That workflow transfers the private
   environment and recreates the API container. Merely restarting the old container does not
   apply the changed Compose configuration. Do not upload the entire local .env to production.
5. Retry a fresh upload in the hosted application, then preview/confirm it. Attendance and
   site-visit photos and import/export workers use the same credential configuration.
6. If the error persists, inspect API/Docker logs for the AWS error name without sharing
   credential values. CredentialsProviderError means no usable provider; InvalidAccessKeyId,
   SignatureDoesNotMatch or ExpiredToken require correcting/renewing the credentials. An
   AccessDenied error instead requires checking the runtime IAM policy and any explicit Deny.

An EC2 instance role with the restricted infra/sunvika-media-runtime-policy.json permissions
is an alternative to static credentials. Leave all three credential secrets empty in that case
and ensure the API container can reach the instance metadata credential provider. Do not
change instance metadata security settings blindly; test the configured workload path.

## Check the running container without printing secrets

SSH to the existing deployment server using your configured trusted SSH access, then run:

```bash
cd /opt/sunvika-office
API_IMAGE="$(cat current/image.id)" docker compose --project-name sunvika-office \
  --env-file shared/backend.env --file current/compose.yaml exec -T api node -e '
for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "S3_BUCKET"]) {
  console.log(key + ": " + (process.env[key] ? "set" : "not set"));
}'
```

Blank key variables are expected with a working IAM role. A "set" result checks presence,
not validity or S3 authorization. Do not use docker inspect or compose config output in
shared screenshots: they can expose the full runtime environment. Only a successful
private upload and subsequent preview/confirmation validates the full hosted storage flow.

Local regression check: `python -m unittest discover -s deploy/ec2 -p test_render_env.py`.
These tests use synthetic credentials only; they do not contact AWS.

AWS SDK credential chain documentation:
https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html
