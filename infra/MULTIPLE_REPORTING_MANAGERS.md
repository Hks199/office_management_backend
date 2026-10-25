# Multiple reporting managers

Employee creation, Change manager and Transfer branch accept `reportingManagerIds`
with one to ten distinct employee IDs. The form displays employee names and codes
and allows multiple selection. Existing clients can still supply the single
`reportingManagerId`. When both fields are supplied, the single value must match
the first array value. Responses retain the first manager in the legacy field.

Each selected manager must pass the existing role-creation policy, active status,
branch/reporting relationship and actor destination checks. Changes are atomic
and audited. Self reporting, reporting cycles, inactive chains and chains beyond
twenty levels are rejected. Manager changes invalidate the employee's sessions.

All selected managers and their authorized ancestors gain role-scoped access to
the employee and descendants. Shared descendants are counted once. Existing
permissions still control which employee, attendance, report, contact, lead,
target and dashboard actions are available. A selected manager does not gain
access to other managers' unrelated teams. Removing a manager removes access
unless another authorized reporting path still connects them to that employee.

Existing single-manager rows work without a data migration. For deployment run
`npm run db:indexes:reporting-managers`, restart the backend and refresh the
frontend. The index command does not alter employee assignments. Use the normal
employee endpoints when changing relationships; direct database writes bypass
the application policy and cycle checks.
