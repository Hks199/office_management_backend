# RBAC and hierarchy authorization

Phase 2 implements authentication, controlled permissions, system/custom roles, creation-policy administration and centralized scope predicates. Phase 3 now implements employee/branch/location APIs and serialized hierarchy mutations.

## Permission evaluation

Phase 9 GET /operations/metrics requires current settings:manage ALL through the same OrganizationAccess fences and active session/role checks as administration. There is no MD-name bypass or new broadly granted action. Authorization runs before collection and again before publication; monitoring exposes process counters and queue status/age only. Shared quotas are infrastructure controls and never grant resource access. See PHASE9.md.

Authenticate a JWT with fixed algorithm/issuer/audience and load the active user, active role and live session. Find grants for the exact controlled registry action. Map each grant's scope through the resource adapter, then combine with OR. Intersect the result with validated client filters using AND. Deny if no grants, an unsupported resource/scope combination, or an inactive reference exists. There is no implicit MD bypass.

| Scope | Users | Employee-owned attendance/reports/targets | Leads / customers |
|---|---|---|---|
| SELF | `_id = actorId` | employeeId (salesExecutiveId for visits) = actorId | createdBy = actorId only when the action explicitly supports SELF |
| DIRECT_REPORTS | reportingManagerId = actorId | employeeId in current direct reports | assignedTo in current direct reports |
| REPORTING_SUBTREE | _id in current descendants | employeeId in current descendants | assignedTo in current descendants |
| BRANCH | branchId = actor primary branch | immutable record branchId = actor branch | record branchId = actor branch |
| ASSIGNED | unsupported | unsupported unless resource has explicit assignee semantics | assignedTo = actorId |
| ALL | any in this company | any in this company | any in this company |

SELF is a separate grant; subtree does not silently include the actor. Unassigned leads in a branch require a BRANCH/ALL grant; subtree cannot infer ownership from creator. File scope follows attached parent authorization; unattached intents are owner-only. Locations/reference values are authenticated read-only for ordinary staff. Audit read is a separate action; it cannot be inferred from employee read. Notification scope is SELF.

For individual resources query `{$and:[{_id},scopePredicate]}`; return generic 404 for absent or inaccessible records. For writes recheck scope/current revision inside the transaction to avoid hierarchy-change races. Permission changes apply on the next request because roles are reloaded. Long-running jobs reauthorize at execution and commit, including after hierarchy revisions.

## Implemented seed matrix

Legend: A=ALL, T=REPORTING_SUBTREE, B=BRANCH, S=SELF, X=ASSIGNED, —=denied. Multiple values mean explicit grants, not implicit inheritance. This policy is seeded during secure bootstrap. Existing grants are preserved by subsequent role seed runs. SEX is the normalized code for the SEx role.

| Action group | MD | BDO | MH | BH | SEx | TC |
|---|---|---|---|---|---|---|
| users:read | A | T,S | T,S | B,S | S | S |
| users:create/update/deactivate | A | T | T | B | — | — |
| hierarchy:read | A | T,S | T,S | B,S | S | S |
| users:change_manager/transfer | A | T | T | B (same branch) | — | — |
| roles/permissions:read | A | — | — | — | — | — |
| roles:create/update/delete/assign | A | — | — | — | — | — |
| permissions:assign/delegate_sensitive; policies:manage | A | — | — | — | — | — |
| branches:create/update | A | — | — | B (profile only) | — | — |
| branches:read | A | T | T | B | B | B |
| attendance:create | S | S | S | S | S | S |
| attendance:read | A | T,S | T,S | B,S | S | S |
| attendance:review/correct | A | T | T | B | — | — |
| customers:read | A | T | T | B | — | X |
| customers:assign | A | T | T | B | — | — |
| leads:import; imports:create/confirm/read | A | — | T | — | — | — |
| leads:create | A | T | T | B | X (authorized parent) | X (customer conversion) |
| leads:read/update | A | T | T | B | X | S,X |
| leads:assign | A | T | T | B | — | — |
| leads:propose_assignment | A | T | T | B | — | S,X |
| leads:reopen | A | — | — | — | — | — |
| reports:create | S | S | S | S | S | S |
| reports:read | A | T,S | T,S | B,S | S | S |
| reports:review | A | T | T | B | — | — |
| targets:create/update | A | T | T | B | — | — |
| targets:read | A | T,S | T,S | B,S | S | S |
| dashboard:read | A | T,S | T,S | B,S | S | S |
| leads:export; dashboard:export | A | — | — | — | — | — |
| files:upload/read | parent/owner | parent/owner | parent/owner | parent/owner | parent/owner | parent/owner |
| activity_logs:read | A | — | — | — | — | — |
| locations:read | A | A | A | A | A | A |
| locations:manage; settings:manage | A | — | — | — | — | — |
| notifications:read/update | S | S | S | S | S | S |

Branches do not have employee ownership; T for branches resolves the distinct branches of visible descendants and returns public branch fields only. Profile edits and head/location/geofence changes use separate DTOs and sensitive permissions. `dashboard:read` is necessary but each data source also requires its source read grant; denied metrics are omitted, not replaced with global totals. `reports:create` requires a role capability matching the report kind; managers cannot forge another employee's activity.

## Delegation and hierarchy rules

Default creation policies: MD → BDO/MH/BH/SEx/TC; BDO → MH/BH/SEx/TC; MH → BH/SEx/TC; BH → SEx/TC. No default policy allows creation of MD. MD bootstrap is an internal one-time command with no public endpoint. Custom roles require an explicit creation policy and allowed manager-role relationship; no rank number determines authorization.

Creating a user needs `users:create`, an active target-role policy, a valid active manager and branch in scope, and an explicit administrator-approved role template whose approval snapshots still match creator/target revisions. Sensitive or company-wide template grants require sensitive delegation. BDO/MH/BH may use approved subordinate role templates without `roles:assign`; arbitrary role reassignment requires `roles:assign` plus all creation checks. Sensitive permissions (`roles:*`, `permissions:assign`, `policies:manage`, `settings:manage`, ALL grants) require an explicit sensitive-delegation capability. Protect the last active administrator from removal/deactivation. Role changes are validated against all active holders and affected creation policies.

Manager changes reject self-reference, inactive managers, cycles, excessive depth, disallowed reporting roles and unauthorized cross-branch edges. Cross-branch relationships default-deny except explicitly configured company-wide supervising roles. Both old and new employee/manager/branch scopes must be authorized. Transfers retain historical attribution, revoke/refresh sessions as necessary and invalidate organization-dependent caches. The singleton organization revision prevents concurrent cycle creation. Reassign branch head and dependent work deliberately; never silently move leads or historical records along with an employee.

## Mandatory security tests by phase

Test each action against SELF, peer, direct report, deep descendant, unrelated subtree, same-branch non-descendant, and other branch; assert both collection filtering and individual writes. Test role grant removal during a live session, deactivated users, stale hierarchy, concurrent reciprocal manager changes, forged identity/branch filters, and sensitive role assignment. Every export/aggregate must have the same visibility boundary as its source list. These are future acceptance tests, not Phase 1 claims.

## Phase 2 enforcement details

Role/policy administration accepts only ALL grants for its exact action; action middleware is followed by service-level enforcement. Writes serialize through security_state, reload the active actor/session/role in the transaction and recheck delegation. A grant cannot exceed the actor's own matching capability; sensitive permissions and ALL grants additionally require permissions:delegate_sensitive. MD's required administrator core grants and every system role's active state are protected. Referenced roles cannot be archived. Audit and business changes share the transaction.

ScopeService implements explicit owner, branch, assignee and hierarchy fields. Direct/subtree predicates query current users; subtree traversal rejects cycles/root reentry and excessive depth. Historical employees remain within their current reporting relationship even when inactive. Queries combine scope and client filters with AND; no user role name grants access. Missing adapter fields fail closed. Branch-wide access is distinct from subtree access. File parent and branch-specific adapters will be wired with those modules; the foundation does not invent parent access.

Scope middleware returns a query predicate, never an automatic write authorization. Future services must query individual resources through that predicate and repeat mutation checks in transactions. Phase 3 now implements manager-cycle prevention, employee role assignment and last-active-administrator safeguards. The root MD role security cannot be removed in Phase 2.

## Phase 3 authorization flow

Employee reads query users:read scope before pagination/count. Hierarchy reads additionally intersect hierarchy:read; an unauthorized explicit root returns 404. SELF remains independent from direct/subtree/branch scopes. Branch resources adapt BRANCH to their own _id and direct/subtree to distinct branches of visible reports. Branch lists do not expose employee lists or aggregate private totals.

For writes, refresh the actor/session/grants after acquiring the shared administration/hierarchy locks. Authorize the source record using the action-specific query predicate. Non-global managers must also have a current role-creation policy for the target's role, preventing a BH from editing a same-branch administrator or peer BH. Global users:create plus permissions:delegate_sensitive administrators may manage existing records, including custom roles, while reserved root placement and last-admin rules remain mandatory.

Creation needs users:create, a current creator/target approval snapshot, approved manager-role list, active role/branch/manager, an authorized destination and a valid manager-to-target edge policy. MD bootstrap is the only manager-less root and HTTP cannot create another MD. MD/BDO default roles allow no primary branch; custom roles require an explicit sensitive flag. Custom templates can delegate nonadministrative duties such as MH importing even where BDO lacks that action; exact actor-action subset delegation was rejected because it conflicts with the documented creation hierarchy. Administratively sensitive or ALL-scoped templates still require permissions:delegate_sensitive ALL.

Manager/branch changes must leave both source and destination authorized. Subtree/direct-report destination branches are limited to currently visible team branches plus the actor's own branch; initial new-branch placement is a global administrator action. BRANCH grants require the new manager in the actor's branch. Cross-branch reporting additionally requires explicit manager-to-target role policy. Policy edits cannot remove active reporting edges or required cross-branch authority.

roles:assign ALL is required for role changes, followed by template, branch/manager, active child, branch-head and last-admin checks. Managers cannot use ordinary profile DTOs to set role, branch, manager, password, permissions or identity actor IDs. System role core protections remain enforced by the role service. All changes append an audit in the same transaction; failed audit insertion rolls back employee creation and invitation.

Last-administrator availability requires an active employee with completed password setup and an active role containing the core administrator grants. Pending invitations do not satisfy this safeguard.

## Phase 4 evidence authorization

attendance:create is SELF and always uses the bearer employee. attendance:read/review/correct use existing SELF, DIRECT_REPORTS, REPORTING_SUBTREE, BRANCH and ALL predicates with employeeId/branchId, applied before history queries or summary aggregation. No self review/correction is allowed. Branch-policy mutation requires branches:update ALL. Existing role grants are preserved.

Upload intents require files:upload plus attendance:create and always belong to the actor. Confirm/attach require owner/purpose/fresh state. Generic files/:id/download enforces files:read SELF/ALL plus parent attendance:read. Scoped reviewers obtain evidence through attendance/:id/photos/check-in or check-out with parent attendance:read; this does not expand their generic files:read SELF grant. No role name grants access implicitly.

## Phase 5 commercial enforcement

customers and leads adapt SELF to createdBy, ASSIGNED to canonical assignedTo, DIRECT_REPORTS/REPORTING_SUBTREE to current assignee IDs and BRANCH to immutable record branchId. Old salesExecutiveId never grants current assignment access. Customer/lead reads, writes, counts, histories and exports apply exact action scopes. Reassignment needs old source access plus an authorized prospective assignee/branch. Recipients must be ACTIVE, same branch, explicitly hold customers:receive_assignment SELF or leads:receive_assignment SELF, and have an assigned-work read capability. Fresh TC/SEX seeds receive these respective grants; existing/custom grants are preserved until explicit reviewed upgrade. The internal capability command audits default additions, increments role revisions and leaves affected creation policies stale for explicit reapproval.

Imports need both imports:create/confirm and leads:import for the destination branch. Confirm additionally requires customers:assign for the selected calling recipient. Direct/subtree import branches resolve current team-occupied branches. Job metadata uses creator/team/branch scopes plus own-creator access while the action remains granted; row reads also recheck branch. Worker execution reloads the persisted actor's live session/grants and rechecks source job visibility, branch, policy, recipient and destination each batch. Losing creator hierarchy while retaining branch/recipient access still stops delegated work.

Interested-customer conversion intersects customers:read with leads:create on the source, then writes the source link/lead/event/idempotency/audit atomically. Recommendation needs leads:propose_assignment and same-branch eligible sales target; it never silently assigns. TC's explicit lead SELF grant retains origin visibility, while pure assignee-subtree managers do not gain unassigned-lead access implicitly. Approval requires scoped leads:assign, valid proposal/lead revision/expiry, and current destination eligibility. Terminal reopen intersects leads:update and leads:reopen. settings:manage ALL controls immutable workflow versions/reference/duplicate settings, and cannot be inferred from branch leadership.

Exports intersect leads:export with leads:read at worker execution/publication. Download requires export owner, live grants, unexpired job and current visibility of every included lead. Previously issued S3 capability URLs remain usable until short expiry; export files are historical snapshots. See PHASE5.md for all limits and upgrade decisions.

## Phase 6 reporting enforcement

reports:create always records the authenticated employee, never a supplied employee ID. Calling additionally requires current customer assignment/read scope and customers:receive_assignment; visits require canonical assignedTo/read scope and leads:receive_assignment. Employees must be ACTIVE in the active parent branch; no role-code check substitutes for a capability. Photo issuance/confirmation also requires files:upload. Existing upgraded/custom roles need explicit capabilities, as described in PHASE5.md.

reports:read/review use employeeId ownership, historical branchId and current descendants for SELF/DIRECT_REPORTS/REPORTING_SUBTREE/BRANCH/ALL. A manager cannot approve their own report, review an OPEN visit or bypass expected revision. Parent reports:read authorizes attached evidence and report history. Lead/customer reassignment revokes submission eligibility but retains authorized historical report reads. Scope predicates precede list counts and daily aggregation. Lead stage/follow-up updates during visit completion additionally require current leads:update scope and permitted pinned workflow transitions. Details and example requests are in PHASE6.md.

## Phase 7 target authorization

Existing targets:create/read/update grants drive ALL/current-subtree/direct-report/BRANCH/SELF authorization. Create checks the current employee destination; update checks both saved target scope and current destination. Eligible recipients must be active in an active primary branch with the activity capability (customer receive, lead receive, or lead create). Branch/type/employee attribution is never supplied by a manager after creation. Ordinary employee defaults only allow personal target reads.

Progress additionally intersects reports:read; lead-based types also intersect leads:read against stored milestone createdBy/assignedTo/branch snapshots. This retains authorized personal historical credit after reassignment without exposing the current parent lead. Current descendants/actor branch still determine managerial visibility. Missing source grants fail 403; narrower source scope returns a marked authorized subtotal. Target-evidence approval requires reports:review plus snapshot lead visibility and forbids both credited employee and original performer from self verification. Legacy capture also requires current lead access. No new permissions or silent role upgrades were introduced. See PHASE7.md for default verification rules.

Milestone lead hierarchy scopes follow credited employeeId rather than an initially null lead assignee, so managers can verify/summarize their telecallers' generated-lead credit. This grants historical milestone metadata, while current parent-lead contact access still uses the original commercial scope adapter.

## Phase 8 dashboard enforcement

Every data source intersects dashboard:read with its existing source permission; exports additionally intersect dashboard:export. No role names authorize or shape access. SELF commercial work includes creator/current canonical assignment, then narrows to customer/lead source scope. Employee/attendance/report/target scopes use employee IDs; branch/subtree grants retain their existing historical-branch/current-hierarchy meanings. BDO/MH see descendants, BH sees branch data, and employee defaults see their own work. Broader source grants never widen a SELF dashboard, or vice versa.

Missing grants produce unavailable overview sections or 403 on dedicated endpoints. Role/manager/search dimensions resolve only visible employees; branch geography resolves only visible branches. Role labels are restricted to scoped employee IDs. Historical milestone source scopes preserve Phase 7 credit while current parent contact APIs retain independent assignment rules. Provisional attendance eligibility additionally requires active role attendance:create SELF. Calendar updates require settings:manage ALL plus visible dashboard/branch scope. Export job status is owner-only; live grants and regenerated same-asOf fingerprints block stale/revoked downloads/publication. See PHASE8.md.
