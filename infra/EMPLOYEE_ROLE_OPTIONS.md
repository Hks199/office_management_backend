# Empty employee role dropdown

Employee role options use the same active-role, creation-policy revision and
sensitive-delegation checks as employee creation. Changing either the creator
role or target role can make an existing creation policy require review. The
lookup must not bypass those checks or silently approve changed permissions.

The role-options response includes `meta.policyReviewRequired`. The form explains
this condition and links administrators to Creation policies. Review each affected
policy and save it to approve the current role revisions.

For the MD's existing active system-role policies, an operator can diagnose with
`npx tsx src/scripts/check-employee-role-options.ts`, preview with
`npm run repair:md-creation-policies`, then apply with
`npm run repair:md-creation-policies -- --apply`.

The repair requires an initialized active bootstrap MD administrator, checks that
manager roles are active, and updates only stale revision approvals for existing
active MD policies targeting BDO, MH, BH, SEX or TC. It records audit events and
does not create policies, enable disabled policies, alter reporting rules or
approve custom-role templates. Other creators' policies require separate review.
