# Phase 2.4 Group Request Workflow Report

## Scope

Phase 2.4 added a safe group-change and sub-agent request workflow. It did not implement payment gateways, payment webhooks, frontend compatibility aliases, group-based referral rates, referral reversal, wallet side effects, or referral side effects.

## Files Changed

Created:

- `src/modules/groupRequests/groupRequest.constants.js`
- `src/modules/groupRequests/groupRequest.model.js`
- `src/modules/groupRequests/groupRequest.validation.js`
- `src/modules/groupRequests/groupRequest.service.js`
- `src/modules/groupRequests/groupRequest.controller.js`
- `src/modules/groupRequests/groupRequest.routes.js`
- `src/tests/groupRequest.test.js`
- `docs/GROUP_REQUESTS_ARCHITECTURE.md`
- `docs/PHASE_2_4_REPORT.md`

Updated:

- `src/app.js`
- `src/modules/users/user.model.js`
- `src/modules/audit/audit.constants.js`
- `src/modules/notifications/notification.service.js`
- `src/tests/testHelpers.js`
- `docs/BASELINE_ARCHITECTURE.md`
- `docs/PHASE_2_FEATURE_TODO.md`

## Models Added or Updated

Added:

- `GroupChangeRequest`

Updated:

- `User` with business-level sub-agent fields:
  - `isSubAgent`
  - `subAgentStatus`
  - `subAgentApprovedAt`
  - `subAgentApprovedBy`

## Routes Added

Customer:

- `POST /api/me/group-change-requests`
- `GET /api/me/group-change-requests`
- `GET /api/me/group-change-requests/:id`
- `POST /api/me/group-change-requests/:id/cancel`

Admin:

- `GET /api/admin/group-change-requests`
- `GET /api/admin/group-change-requests/:id`
- `PATCH /api/admin/group-change-requests/:id/approve`
- `PATCH /api/admin/group-change-requests/:id/reject`

## Behavior

Customers can request group changes or sub-agent status, view only their own requests, and cancel only pending own requests.

Admins can view, approve, and reject requests. Supervisors can view/manage only when they have explicit `groupRequests.view` or `groupRequests.manage` permissions.

`GROUP_CHANGE` approval updates the user's group. `SUB_AGENT` approval marks the user as a sub-agent and optionally updates the user's group. Neither workflow changes roles, grants permissions, touches wallets, or triggers referral commissions.

## Idempotency and Safety

- One pending request per user/request type is enforced by service checks and a partial unique index.
- Review operations are guarded by pending status checks.
- Request review and user mutation run in MongoDB transactions.
- Re-approving an already approved request is idempotent.
- Re-rejecting an already rejected request is idempotent.
- Approved, rejected, and canceled requests cannot be reviewed again.

## Notifications and Audit

Best-effort notifications cover request submission and review. Best-effort audit logs cover creation, cancellation, approval, rejection, group change through request, and sub-agent approval.

Failures in notification or audit side effects do not roll back core request/user mutations.

## Tests Added

`src/tests/groupRequest.test.js` covers:

- group-change request creation
- sub-agent request creation
- target group validation
- duplicate pending request prevention
- own request listing/detail access
- pending request cancellation
- reviewed request cancellation rejection
- admin listing/detail
- group-change approval
- sub-agent approval without role escalation
- sub-agent approval with group change
- rejection behavior
- repeated approval/rejection safety
- blocked review of rejected/canceled/approved requests
- customer admin-route denial
- supervisor permission checks
- no wallet/referral side effects

## Remaining Warnings

- Sub-agent hierarchy/profile modeling is reserved for future work.
- Frontend compatibility aliases are not implemented in Phase 2.4.
- Group eligibility is limited to active/deleted-state checks.
- Pricing changes apply naturally to future orders after `User.groupId` changes.

## Final Verification

| Check | Result |
| --- | --- |
| `npm.cmd run lint` | Passed. Syntax check passed for 180 JavaScript files. |
| `npm.cmd test -- --runInBand` | Passed. 21 test suites passed, 641 tests passed. |
| `git diff --check` | Passed. No whitespace errors. |

Phase 2.4 is complete.
