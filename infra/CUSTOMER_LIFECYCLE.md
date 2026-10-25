# Contacts, leads and confirmed customers

Imported contacts stay in the legacy `customers` collection/API. The frontend Contacts page is `/contacts`. They become linked leads through the existing Interested → Convert to lead action.

Changing a lead to CONVERTED now upserts its customer snapshot in `confirmed_customers` in the same transaction as the status event, target evidence and audit records. A unique `leadId` index guarantees one customer per lead. Conversion captures name, contact details, requirements, exact decimal project value, confirmation date and confirmer. It does not imply an invoice, payment, signed contract or installation record.

The frontend `/customers` page reads `/api/v1/sales-customers`. Customers have a source-lead link; lead details have a customer link. Customer list/detail queries use the current source lead's `leads:read` scope before pagination. Current lead assignment and branch determine visibility. No additional broad employee-directory grants are required. Customers cannot be created or changed directly through this read-only API.

Reopening a converted lead requires the existing `leads:reopen` authority. Its customer becomes REVIEW_REQUIRED. Re-conversion confirms the same customer, refreshes the commercial snapshot and retains its original first-conversion timestamp. Existing workflow rules still govern status transitions.

## Existing installation

From the backend directory, run:

```powershell
npm run db:backfill:customers
```

The command creates the new collection/indexes and reconstructs missing customers for currently converted leads. It uses the last conversion event's actor/date where available, audits each customer, and fences concurrent lead changes by advancing the lead revision. It is safe to rerun and does not recreate existing customers or change their confirmation dates. Refresh open lead forms after running it. Then restart the backend and refresh the frontend.

New installations also create the collection/indexes through `npm run db:indexes:commercial`.
