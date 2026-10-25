# Configure the existing sunvika-media bucket

Backend `.env` uses `AWS_REGION=ap-south-2` and `S3_BUCKET=sunvika-media`.
The AWS SDK reads backend-only `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
through its default credential provider. Production may use an IAM workload role
instead. Do not put credentials in frontend variables or source-controlled files.

This shared storage is used for attendance photos, site-visit photos, customer
imports, lead exports and dashboard exports. No separate credentials are needed
in these modules. Excel worksheets are converted to CSV before private upload.

## Access verification

The supplied credentials authenticated successfully through AWS STS. S3 confirmed
the bucket region as `ap-south-2`. The latest checks confirmed that versioning is
Enabled, all four public-access blocks are enabled, and default encryption is
AES256. CORS is now configured for http://localhost:5173 with POST, GET and HEAD.
No live files were uploaded, downloaded or deleted during these checks.

File verification still fails:
HeadObject returns HTTP 403 and GetObject reports an **explicit Deny in an IAM
identity policy** for the configured backend identity. The policy list supplied
by the administrator identifies **AWSCompromisedKeyQuarantineV3**. This AWS-managed
quarantine policy explicitly denies s3:GetObject and s3:PutBucketCors, among other
actions. Adding another Allow policy cannot override it.
Do not remove or weaken the quarantine policy as an upload workaround. Follow the
instructions in the AWS security support case for this account. A separate trusted
administrator must deactivate the exposed key, review CloudTrail and account
activity, and complete credential rotation and incident recovery. Update replacement
credentials locally in the backend environment, never in chat. Rotating credentials
alone does not lift a quarantine policy attached to the IAM user; restore access
only after the AWS recovery process authorizes it.
The current credentials are denied ListUserPolicies and ListAttachedUserPolicies,
so the denying policy document could not be inspected automatically.

Official AWS quarantine guidance:
https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AWSCompromisedKeyQuarantineV3.html

After recovery, an AWS administrator must grant the backend identity access to this bucket.
Use `sunvika-media-runtime-policy.json` as the identity policy. It permits only
bucket inspection and read/write access under the four application prefixes.
It does not grant access to other buckets, IAM administration, bucket deletion
or object deletion. An identity policy cannot override an explicit denial in a
bucket policy, organization policy or permissions boundary; cross-account access
also requires permission from the bucket owner.

## Required bucket settings

In the S3 console for **sunvika-media**, verify:

- Region: **ap-south-2**.
- Versioning: **Enabled**.
- Default encryption: **SSE-S3 (AES256)**, matching application uploads.
- All four Block Public Access settings: **Enabled**.
- CORS: paste `sunvika-media-cors-console.json` into the S3 console editor. The
  `sunvika-media-cors.json` file wraps the same rules for AWS CLI/SDK use and must
  not be pasted directly into the console. Both use the backend's configured
  frontend origins. Regenerate/edit the allowed origins when deploying to a new
  domain. CORS does not grant public read access to objects.

These configuration changes must be performed by an AWS administrator. The
runtime policy intentionally cannot change bucket settings. Keep any unrelated
existing CORS rules when adding application origins.

## Restart and process imports

Restart the backend after changing credentials or environment settings. There
are no AWS credentials to configure in the frontend.

After security recovery and local credential replacement, set
`COMMERCIAL_JOBS_ENABLED=true` and optionally `COMMERCIAL_JOBS_INTERVAL_MS=5000`
in backend `.env`, then restart the API. This starts automatic non-overlapping
customer validation, confirmed import commits and lead exports. It stops claiming
work during shutdown. Set the flag to false when using a separate scheduler.

Alternatively, schedule `npm run jobs:commercial` externally. Schedule
`npm run jobs:dashboards` separately for dashboard exports. Each CLI command
processes a bounded batch and exits; a single manual run does not provide
continuous processing.

Do not run the processor with exposed or quarantined credentials. Saving the
replacement keys locally is required; creating a key in AWS alone does not update
the backend environment.

Orphan-photo cleanup is separate. If enabled, use a cleanup identity with the
restricted list-versions/delete-version policy described in `private-photos.yaml`.
The runtime policy intentionally does not grant deletion permissions.

Rotate the credentials shared in chat in AWS IAM, then replace the local `.env`
values and restart the backend. Do not send replacement secrets through chat.
