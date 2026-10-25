# BDO and MH permission parity

New installations seed identical permission grants and data scopes for BDO and MH.
Both roles include `leads:import`, `imports:create`, `imports:confirm`, and
`imports:read` within `REPORTING_SUBTREE`.

For an existing installation, preview the difference against the currently saved
MH role with `npm run align:bdo-permissions`. Apply it with
`npm run align:bdo-permissions -- --apply`.

The command requires an initialized active bootstrap administrator. It copies
the current MH grants exactly, increments the BDO role revision, records an audit
event, and refreshes previously valid creation-policy revisions in a transaction.
Already stale policies remain pending administrator review. Repeating the command
when grants match makes no changes.

Role names, reporting relationships, branch assignments and permitted subordinate
role types remain governed by the existing organization and creation policies.
Equal permission templates apply to each manager's own authorized hierarchy;
they do not give BDO access to unrelated MH teams. Sign out and sign in again to
refresh the frontend permission-based navigation after applying the update.
