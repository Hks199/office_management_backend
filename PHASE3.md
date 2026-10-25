# Phase 3: employees, hierarchy, branches and locations

Implemented under `/api/v1`. All endpoints require a live bearer session and the documented permission/scope. No public registration or plaintext password creation exists. Attendance/private files are implemented separately in [PHASE4.md](PHASE4.md).

Employee forms use GET `/employees/role-options` with `users:create` or GET `/employees/role-options/assignment` with `roles:assign ALL`. These endpoints return only `_id`, name, code and allowsNoBranch for approved active templates. They reuse mutation checks for active policies, matching role revisions and sensitive delegation; they exclude the MD role and unapproved templates. Pagination and name/code prefix search apply after eligibility filtering. Creating or assigning an employee still validates placement, branch, manager and current authorization. `/roles` remains restricted to role administration; employee creators do not need that permission just to populate a dropdown.

GET `/employees/manager-options?roleId=...` requires users:create and a current approved target template. It returns only manager IDs and labels containing name, employee code and role, with bounded pagination and literal prefix search. Candidates must be active, not exited, have an active allowed manager role and an active reporting-relationship policy. Creation scope applies, including the creator themselves. For MH creation specifically, a BDO may additionally select their active root MD; the mutation applies the same exception and preserves branch, role-policy and hierarchy validation. This exception does not expand employee reads, transfers, manager-change endpoints or other target roles.

## Upgrade and initialize

```sh
npm ci
npm run db:indexes:organization
npm run dev
```

For a fresh database, configure the independent secrets and bootstrap the MD as described in ENVIRONMENT_SETUP.md first. The migration creates branch/location collections and indexes, initializes missing policy approval revisions to zero and adds branch-less-role metadata. Modified legacy roles/policies require explicit review; it never repairs a graph or silently approves new privileges. Production uses an authenticated MongoDB replica set and an operational migration identity.

Create approved states, districts and blocks, then branches. MD, BDO and MH support `branchId:null` (None in the employee form); BH, SEX and TC require a primary branch. Existing uncustomized system roles receive this setting through `npm run db:indexes:organization`; customized role revisions retain their approved settings. Configure custom company-wide roles with `allowsNoBranch:true` using sensitive administration. No administrative geography is bundled or invented.

Employee creation uses `/employees/branch-options?roleId=...`, protected by users:create and a current approved template. It returns only active branch IDs, names and codes. Company-wide BDO and MH managers (null primary branch, allowsNoBranch) with REPORTING_SUBTREE creation authority and an EXPLICIT_SCOPE cross-branch reporting policy may select an active branch to establish their team. This creation-only exception still requires an authorized reporting manager and all role, branch and hierarchy checks. Other actors use their existing creation scope; SAME_BRANCH templates restrict options to their primary branch. Employee reads, transfers and the full branch directory retain their existing scopes. MD may alternatively assign a primary branch through the audited transfer API; assigned managers remain restricted to primary/reporting-team branches.

New default MH → BH/SEX/TC policies allow cross-branch reporting so a branch-less MH can supervise physical branch employees. The organization-index command upgrades only untouched active default MH policies (system role revisions and policy revisions zero, EXPLICIT_SCOPE, approved self-manager); it increments each migrated policy's revision once. Changed roles, customized policies, inactive policies and SAME_BRANCH restrictions are preserved. No employee branch assignments or permission grants are altered.

## Main endpoints

| Method and path | Purpose and permission |
|---|---|
| POST /employees | Create approved subordinate, queue invitation; users:create plus policy and destination scope |
| GET /employees; GET /employees/:id | Scoped profiles, list filters and counts; users:read |
| PATCH /employees/:id | Profile fields plus revision; users:update plus management policy |
| PATCH /employees/:id/status | Soft deactivate/reactivate; users:deactivate, revision, reason, isActive, employmentStatus |
| PATCH /employees/:id/manager | Atomic manager change; users:change_manager, revision, reason, reportingManagerId |
| PATCH /employees/:id/branch | Atomic branch/manager transfer; users:transfer, revision, reason, branchId, reportingManagerId |
| PATCH /employees/:id/role | Approved role reassignment; roles:assign ALL, revision, reason, roleId |
| GET /employees/hierarchy; GET /employees/downlines | Paginated flat graph; hierarchy:read intersected with users:read |
| POST /branches | Create branch with valid active location chain; branches:create ALL |
| GET /branches; GET /branches/:id | Scoped branch profiles; branches:read |
| PATCH /branches/:id | Scoped profile update; location/status changes need branches:update ALL |
| PATCH /branches/:id/head | Capability-based appointment/clear; branches:assign_head ALL, revision, reason, branchHeadId |
| GET /locations/states | Bounded state list; locations:read ALL |
| GET /locations/districts?stateId=... | Bounded district list under required state |
| GET /locations/blocks?districtId=... | Bounded block/tehsil list under required district |
| POST /locations/{states,districts,blocks} | Admin master creation; locations:manage ALL |
| PATCH /locations/{states,districts,blocks}/:id | Admin name/status change with revision; parents/codes immutable |

Employee and branch removal is soft deactivation through PATCH; hard DELETE is intentionally absent to retain references and history. Branch heads must be active, belong to that branch, and have branches:update BRANCH/ALL; the label BH is not the authorization check. Role edits that remove a current head's authority are rejected until reassignment.

## Requests and responses

Create an employee using IDs returned by role/branch/employee APIs:

```http
POST /api/v1/employees
Authorization: Bearer <access-token>
Content-Type: application/json

{
  "employeeCode": "SV-0010",
  "firstName": "Example",
  "lastName": "Employee",
  "email": "employee@example.invalid",
  "mobileNumber": "+919876543210",
  "roleId": "<approved-role-id>",
  "branchId": "<active-branch-id>",
  "reportingManagerId": "<authorized-active-manager-id>",
  "dateOfJoining": "2026-10-17T00:00:00Z"
}
```

Returns 201 with `{success:true,message:"Employee created",data:{_id,...safeProfile,revision:0,invitationStatus:"PENDING"}}`. Neither password nor invitation token appears in the response. Email is normalized lowercase; employee code uppercase; E.164 mobile and email are company-unique. No client is allowed to supply passwordHash, permissions, authVersion, createdBy or actor identity. Use the SMTP worker for setup invitations.

Transfer request:

```json
{
  "revision": 0,
  "branchId": "<authorized-destination-branch-id>",
  "reportingManagerId": "<authorized-destination-manager-id>",
  "reason": "Approved office transfer"
}
```

Successful transfer increments revision, keeps the employee ID and historical records, records before/after attribution in append-only audit and revokes all affected employee sessions. It does not silently transfer leads, descendants or past attendance. Active child relationships must remain compatible; a current branch head must be reassigned first.

Status request uses `{revision,isActive,employmentStatus,reason}`. EXITED cannot be active. Active direct reports must be reassigned before manager deactivation. Bootstrap root manager/branch/role cannot change; last-active-administrator checks use effective grants, not MD/custom-role names. Ordinary profile edits cannot change organization fields. Contact changes invalidate sessions and outstanding recovery/setup links, replacing a pending invitation for an active employee without a password. Deactivation consumes credentials; reactivation of pending employees queues a new invitation.

## Filters and hierarchy behavior

Employee list filters: branchId, managerId, roleId, isActive, employmentStatus, department, search, startDate/endDate over createdAt, page, limit, sortBy, sortOrder. Sort fields: employeeCode, firstName, createdAt, dateOfJoining. Search is escaped literal prefix matching. Dates are valid calendar dates interpreted at UTC midnight or ISO timestamps with explicit Z/offset. Date ranges use `[start,end)` and reject reversed ranges and timezone-less timestamps. Pages have maximum 100 records, page maximum 10000; unknown filters/operators are rejected.

Hierarchy/downlines add rootId or managerId (mutually exclusive anchor), and depth 1-20. Default anchor is the actor. Hierarchy includes the root only where visible; downlines excludes it. Both return flat nodes with hierarchyDepth and pagination metadata. A page may omit a parent and must not be treated as a complete nested tree. The source employee read scope still applies before counting/pagination. A missing or invisible explicit root returns generic 404.

BH branch access includes authorized same-branch peers independently of reporting-subtree membership. BDO/MH subtree access excludes unrelated same-branch employees. Branch T/DIRECT_REPORTS scopes return distinct branches from the authorized reporting set; BRANCH compares the branch's own ID. Client branch/employee filters cannot widen those predicates.

## Policy defaults and explicit alternatives

Role-creation policies are administrator-approved templates, not role-name rankings. Their creator/target revision snapshots are server-derived. Any role revision makes affected creation/reassignment policies stale until reviewed and PUT with the current policy revision. This applies even to a role metadata edit and deliberately favors explicit review.

An approved subordinate template may contain nonadministrative work the creator does not perform, such as MH importing customers under a BDO. Requiring every target action on the creator would break that documented default hierarchy, so template approval is the delegation authority. Sensitive permissions and ALL-scoped data access (except global reference read) still require permissions:delegate_sensitive ALL. A branch-visible peer manager or administrator cannot be edited merely because the actor sees their profile.

Creation and transfers authorize the source and new manager/branch independently. Scoped managers may place staff only into their own branch or an already visible team branch, under an authorized manager. The first assignment into a new branch is a global administrator action. Separate active manager-to-target role policies control allowed reporting edges and cross-branch supervision. Existing active edges prevent destructive policy changes. Node cycles and reporting depth beyond 20 edges are rejected under a shared transaction lock, including concurrent reciprocal manager changes.

## Vetted location seed

Set LOCATION_SEED_FILE to your reviewed UTF-8 JSON file and run:

```sh
npm run seed:locations
```

Format illustration only; replace every code/name with vetted values:

```json
{
  "sourceVersion": "company-approved-source-version",
  "states": [{
    "code": "APPROVED_STATE_CODE",
    "name": "Name from approved source",
    "districts": [{
      "code": "APPROVED_DISTRICT_CODE",
      "name": "District name from approved source",
      "blocks": [{
        "code": "APPROVED_BLOCK_CODE",
        "name": "Block name from approved source",
        "kind": "BLOCK"
      }]
    }]
  }]
}
```

Limit: 5 MiB and 500 total state/district/block records per transaction. Matching records are reused; mismatching names/kinds, inactive references and invalid input reject the whole batch. Larger datasets need reviewed batches. No live geography service or external database is used by tests.

## Verification and limits

See VERIFICATION.md for actual checks. Integration tests use isolated real MongoDB replica sets and synthetic geography, covering employee policies, IDOR, branch/subtree separation, invitation/session invalidation, root/last-admin guards, revisions, concurrent cycles, depth, branch heads, location chains and audit rollback. Live SMTP, production DB privileges, Docker/ingress and actual reference datasets need environment validation. No production employee/branch was created by implementation tests.

Last-administrator availability requires an active employee with completed password setup and an active role containing the core administrator grants. Pending invitations do not satisfy this safeguard.
