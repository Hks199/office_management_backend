# Branch lead routing

The flow is Contact → Lead routed to receiving branch → Branch head/authorized senior assigns a local Sales Executive → Executive progresses the lead → Converted lead creates a Customer.

Telecallers select the receiving branch when converting their assigned interested contact, or creating a lead. Branch options show branch name, code and office district/state. Select the branch serving the lead's site address manually; branch office locations are not configured service-area boundaries, so the application does not guess a branch from free-text addresses. Contact ownership and import branch remain intact when the lead is sent to another branch.

Unassigned leads appear as **Awaiting assignment** in Leads. The Assignment filter provides an unassigned queue. The receiving branch's Branch Head can read/assign its leads. An authorized manager with a reporting scope that includes that Branch Head also has lead authority over the managed branch, including its unassigned queue. Unrelated branches cannot access the lead. This extension applies only to lead authorization, not employee or contact directories.

The assignment selector `/leads/:id/assignees` returns only active Sales Executives in the lead's current branch who have the required receive/read permissions and are within the actor's assignment authority. Submission repeats those checks inside the transaction. Telecallers cannot assign executives, propose executive assignments, or update sales stages. They retain read access to their own leads and can use Route to branch to correct an unassigned open lead's destination. Assigned and terminal leads cannot be rerouted this way. Final customer conversion requires an assigned executive.

## Sales Executive status choices

The currently assigned executive with lead receive/update authority can choose any different status on an active assigned lead, including skipping stages, returning to earlier stages, and leaving On Hold for a different stage. The UI shows the complete status list and disables the current status. Supervisor updates continue to follow the lead's pinned workflow. Converted, Lost and Not Interested leads still require scoped reopen authority; reopening returns to Contacted. Conversion requires an assigned executive and atomically records the confirmed customer and target evidence. Revisions, reasons and immutable history remain enforced; status audits identify assigned-executive selection separately from workflow updates. Existing lead statuses and assignments are not rewritten by this change.

## Existing installations

Where an official branch head is configured, ancestor authority follows that head. For older branches without an official head assignment, the active BH's primary branch is used. Creating another BH in a branch with a different official head does not give that BH's ancestors authority over the branch.

```powershell
npm run enable:lead-routing
```

This idempotent audited migration registers `leads:route`, adds SELF routing to the system TC role and ALL routing to the system MD role, removes lead update/assignment/proposal rights from the system TC role, and creates the branch-queue index. Other roles retain their existing grants. Custom roles are not silently changed. Restart the backend and sign in again to refresh frontend permissions.

The legacy contact conversion API still accepts omission of `branchId` and uses the contact's original branch for compatibility. The UI requires a receiving branch explicitly. Existing lead assignments are preserved. New role installations receive these defaults from the role seed.
