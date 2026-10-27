# Open an employee panel

From Employees, open an employee's details and select **Open employee panel**.
The button is available only when the server verifies the employee is active,
has a permitted non-administrator role, and belongs to the manager's current
downline. All reporting-manager relationships are considered. Same-branch peers
and ancestors do not qualify. A manager needs `users:open_panel` with ALL,
REPORTING_SUBTREE or DIRECT_REPORTS scope; even ALL still requires a reporting path.

The manager can perform the employee's ordinary work actions using the employee's
current role and data scope. A banner identifies the employee and real manager,
with **Return to my account**. Attendance capture, employee password/security
changes and nested panel switching are blocked. Business audit events identify
the real manager as actor and retain `actingAsEmployeeId` and `employeePanelId`.
Opening and closing panels also produce audit events. Background work retains
the ordinary job owner, with the manager's initiating action linked by its audit event.

The original manager bearer and refresh cookie are retained. The opaque panel
token is hashed in MongoDB, is held only in the current tab's memory, and is
never put in a URL or browser storage. It is bound to the manager's original
login family and expires within thirty minutes. Reloading the page returns to
the manager account. Normal refresh-token rotation within the original family
does not end a panel. Another manager or another login family cannot use it.

Every request checks current role and reporting access; transactional actor
checks repeat validation before writes. Parent logout, disabled accounts, role
or hierarchy changes, token expiry and explicit closing stop access. Panel
closure uses the manager's own session and remains possible after downline
access is removed. Client caches and in-flight queries are cleared on switching;
responses and retries from a previous identity are rejected.

For deployment, run `npm run enable:employee-panels`, restart the backend and
refresh the frontend. The command creates panel indexes and adds the default
permission to MD (ALL), BDO, MH and BH (REPORTING_SUBTREE). It audits role changes
and refreshes only currently approved creation-policy revisions. Disabled or
already stale policies are left for administrator review. Repeated runs do not
add duplicate grants. It does not open any employee panel or change assignments.
