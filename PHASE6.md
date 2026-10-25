# Phase 6: calls, daily reports and site visits

Phase 6 implements individual telecaller calls, derived daily summaries, separate sales visits with private photographs/GPS, scoped reviews and append-only report history. All endpoints use `/api/v1`, live bearer authentication and `Cache-Control: no-store`. See development Swagger for exact DTOs. Targets and dashboards remain Phases 7 and 8.

## Setup and upgrade

```sh
npm ci
npm run db:indexes:reports
npm run check
```

The migration creates prerequisite collections/indexes and the reporting collections. It preserves existing role grants. New installations already have the default reporting grants and customer/lead receive-assignment capabilities. Installations upgrading from before Phase 5 should follow PHASE5.md, including the separate reviewed capability rollout and creation-policy reapproval. Custom roles need explicit grants; runtime authorization never switches on role names.

Use `node dist/scripts/report-indexes.js` inside the runtime image. No additional environment variables or scheduled reporting worker are required. Photo operations require AWS_REGION and S3_BUCKET and the versioned private bucket protections from Phase 4. Deploy the updated `infra/private-photos.yaml` policies, which add `sunvika/site-visits/*` to runtime upload/download and separate orphan cleanup permissions. Do not give the API worker deletion permissions. No deployment bucket/database or real account was provisioned during local implementation.

## Explicit business defaults

Calls and visits are employee-submitted evidence. GPS, timestamps and photos do not establish physical presence or prove a telephone call happened. Every submission starts PENDING; another scoped reviewer can approve/reject or return it to PENDING, providing remarks and the current revision. Reviewer approval is the default definition of verified activity for the later target phase. An alternative is independent telephony/provider verification; that requires a separate integration and policy. Daily totals show submitted activity separately from approved calls and approved duration. There are no client-entered daily totals, and calls are never counted as lead conversions.

The backend accepts call intervals within the preceding seven days, with ordered non-future timestamps and a maximum four-hour duration. It derives whole seconds from the interval; clients cannot send duration or employee IDs. Positive-length calls may not overlap the employee's existing calls, even across customers. Identical intervals cannot be inserted twice, including zero-length intervals. Zero-duration attempts remain valid for unanswered/busy calls; approval determines whether they count as verified work. A stricter provider-only rule or shorter submission window can be adopted later without changing submitted evidence.

Visit start/completion use server UTC time. Completion must occur within 24 hours, with one to five distinct confirmed photos. One employee can have only one OPEN visit for a particular lead, while completed visits remain separate immutable submissions. A client capture older than five minutes or more than one minute ahead is flagged; missing accuracy or accuracy above 100 metres is also flagged. Flagged submissions remain PENDING until review. These are evidence-quality signals, not automatic attendance or geofence decisions. Field visits do not apply an office geofence. Raw start GPS and capture time are preserved separately from completion evidence.

Follow-ups, when supplied, must be future instants within 366 days. Report revisions protect completion and review. Submitted call/visit fields have no edit/delete endpoint; subsequent reviews append history without replacing submission evidence. Open visits that exceed 24 hours or lose their assignment cannot accept new photos or completion and do not count as completed/approved work. Starting a new visit after the window atomically marks the previous open visit EXPIRED and appends history, preserving all its evidence. A lost-assignment visit remains historical OPEN until eligible again or superseded after expiry. Operational cancellation/correction is a future explicit workflow rather than an implicit overwrite.

## Authorization and historical attribution

Call creation requires reports:create, customers:read, the customers:receive_assignment capability, active employment, the current canonical customer assignment and membership in the active record branch. Visit start/photo issuance/confirmation/completion use the corresponding leads:read and leads:receive_assignment checks and the current canonical lead assignedTo. Historical salesExecutiveId never authorizes a submission. Managers with review grants cannot submit on behalf of subordinates. Photos also require files:upload for issuance/confirmation.

Reports use server-set employeeId and historical branchId snapshots. reports:read/review scopes support SELF, DIRECT_REPORTS, REPORTING_SUBTREE, BRANCH and ALL through the existing centralized scope service. Hierarchy scopes follow the current organization graph; branch scope uses the saved report branch. SELF retains the employee's historical reports after transfers. Every record read, count, daily aggregate, review and history request intersects scope before pagination/grouping. Historical report reads do not require a lead/customer to remain assigned, so reassignment does not erase reviewable evidence. Writes recheck live roles, sessions, hierarchy and assignments inside the same transaction as records, attachment and audits. Reviews cannot approve the reviewer's own work or an OPEN visit.

Call/start requests require a 16-100 character alphanumeric/underscore/hyphen Idempotency-Key. The durable unique key is stored on the report itself, without a TTL, and a canonical request hash prevents reuse for a different request. Concurrent retries return the same report; current eligibility and parent assignment are rechecked before replay. A replay returns HTTP 201 and the current report state. A new key with an overlapping call or an already OPEN lead visit returns 409. Repeating completion is a conflict/not-found rather than a second visit or a second lead transition.

## Call and daily APIs

```http
POST /api/v1/telecaller-reports/calls
Authorization: Bearer <access-token>
Idempotency-Key: call-device-unique-0001
Content-Type: application/json

{
  "customerId": "<assigned-customer-id>",
  "callStartedAt": "2026-10-17T08:00:00Z",
  "callEndedAt": "2026-10-17T08:02:10Z",
  "callOutcome": "INTERESTED",
  "customerInterest": "INTERESTED",
  "followUpAt": "2026-10-18T08:00:00Z",
  "remarks": "Customer requested a follow-up"
}
```

Use actual recent times. Outcomes: CONNECTED, NOT_ANSWERED, BUSY, SWITCHED_OFF, WRONG_NUMBER, CALLBACK_REQUESTED, INTERESTED, NOT_INTERESTED. Interest: UNKNOWN, INTERESTED, NOT_INTERESTED, UNDECIDED. Customer identity, mobile, address, branch and existing lead link are snapshotted server-side. convertedToLead indicates a lead link already existed at submission; it is not a conversion event. Call submission does not implicitly convert customers or alter lead workflow/status; use the existing authorized customer and lead APIs.

GET `/telecaller-reports/calls`, GET `/telecaller-reports/calls/:id`, GET `/telecaller-reports/calls/:id/history`, GET `/telecaller-reports/daily` and PATCH `/telecaller-reports/calls/:id/review` are implemented. Lists/daily accept employeeId, customerId, leadId, branchId, callOutcome, visitOutcome, reviewStatus, from, to, page, limit, sortOrder. Inapplicable outcome filters naturally produce an empty set. Dates are inclusive `YYYY-MM-DD` Kolkata business dates; the entire call duration belongs to its start date, including a call across midnight. Daily data is `{timezone:"Asia/Kolkata",days:[{_id:{date,employeeId},totalCalls,callDurationSeconds,approvedCalls,approvedDurationSeconds,interestedCalls,outcomeCounts}]}` with pagination metadata for date/employee groups. outcomeCounts includes every literal outcome, including zero counts. interestedCalls is a submitted interest count, not a verified conversion metric. No summary records are stored. History uses pagination; other query filters do not change its parent-authorized history.

## Visit and photo APIs

1. POST `/sales-reports/visits` with Idempotency-Key and `{leadId,location:{latitude,longitude,accuracyMeters?},clientCapturedAt}`. The response returns the new `_id`, revision 0, OPEN status, customer snapshots and evidence flags. Terminal/ON_HOLD leads cannot start or complete a visit.
2. POST `/sales-reports/visits/:id/photos/upload-intents` with `{filename:"site.jpg",contentType:"image/jpeg",size:12345,checksumSHA256:"<base64-sha256>"}`. Only safe JPG/JPEG, PNG and WebP names/types are allowed, 12 bytes through 5 MiB. The file is bound to that visit and owner. A maximum 20 outstanding image/CSV uploads per employee is enforced.
3. POST the returned fields directly to the private S3 URL with the file last. POST `/sales-reports/visits/:id/photos/:fileId/confirm`. Confirmation checks size, type, checksum, encryption, immutable non-null version and file signature using the existing bounded S3 adapter. Generic attendance confirmation cannot confirm visit uploads.
4. PATCH `/sales-reports/visits/:id/complete` with the current revision and fresh files:

```json
{
  "revision": 0,
  "photoFileIds": ["<confirmed-visit-photo-id>"],
  "location": {"latitude": 22.57, "longitude": 88.36, "accuracyMeters": 10},
  "clientCapturedAt": "2026-10-17T08:20:00Z",
  "discussionNotes": "Roof and customer requirements assessed",
  "customerInterest": "INTERESTED",
  "installationReadiness": "READY",
  "visitOutcome": "COMPLETED",
  "requiredCapacityKw": "6.50",
  "nextFollowUpAt": "2026-10-18T08:00:00Z"
}
```

Visit outcomes: COMPLETED, FOLLOW_UP_REQUIRED, CUSTOMER_UNAVAILABLE, NOT_INTERESTED. Readiness: UNKNOWN, READY, NOT_READY. Every outcome needs GPS, notes and photographs; choose the outcome reflecting what occurred. Capacity is a nonnegative decimal string, up to eight integer/two fractional digits. The current lead rate is snapshotted on completion and the estimated value is calculated in exact decimal arithmetic, rounded half-up to INR paise. The observation does not overwrite the lead's capacity/rate. Later lead edits cannot change historical visit valuation.

Completion changes a lead from SITE_VISIT_SCHEDULED to SITE_VISITED only for outcome COMPLETED, only if the pinned workflow permits that edge and the employee's current leads:update scope permits the lead. It never skips stages, regresses later stages, reopens terminal leads or bypasses hold. A supplied nextFollowUpAt updates the lead only with the same update authorization. Stage changes, revision increments, status history, photo attachment, report submission/history and audits commit atomically. Stage progression records submitted operational activity; approved target counting remains a separate later-phase rule.

GET `/sales-reports/visits`, GET `/sales-reports/visits/:id`, GET `/sales-reports/visits/:id/history` and PATCH `/sales-reports/visits/:id/review` are implemented. List filters match calls above; visitOutcome is the outcome field. Map clients receive normal latitude/longitude and a GeoJSON point with `[longitude,latitude]`; the point has a 2dsphere index. No geospatial search endpoint is exposed.

GET `/sales-reports/visits/:id/photos/:fileId/download` requires parent reports:read visibility and an attached file in that report. It returns a 60-second attachment URL tied to the verified S3 version; no raw storage metadata appears in list/detail/photo-confirm responses. The URL remains a capability until expiry. Uploads expire after five minutes. Attached evidence is retained; existing `cleanup:orphan-photos` removes expired unattached visit versions after 24 hours and safely retries failed deletions. Retention of attached customer evidence needs a deployment-approved policy; automatic deletion is intentionally absent.

Both review endpoints accept `{revision,reviewStatus:"APPROVED"|"REJECTED"|"PENDING",remarks:"Reason for decision"}`. Original evidence stays intact; remarks and before/after decisions are recorded in append-only report_history. Audit metadata contains IDs/revisions/statuses, not GPS, photos, mobile numbers or discussion text.

## Verification boundary

See VERIFICATION.md for actual lint, strict TypeScript, replica-set integration/security/race tests, OpenAPI validation, build and coverage results. Tests inject photo storage; existing S3 adapter tests verify provider commands/signature checks without real AWS. Real IAM/CORS, bucket deployment, device capture and browser-to-S3 uploads still need environment validation. No Phase 7 target or Phase 8 dashboard implementation is included.
