# Group Requests Architecture

Phase 2.4 adds a safe group-change and sub-agent request workflow. It does not change wallet, payment, referral, order, or pricing logic directly.

## Business Rules

- Active customers can create `GROUP_CHANGE` and `SUB_AGENT` requests.
- A customer can have only one `PENDING` request of the same type.
- `GROUP_CHANGE` requires an active target group.
- `SUB_AGENT` may include an optional requested group.
- Customers can list, read, and cancel only their own pending requests.
- Admins can list, read, approve, and reject all requests.
- Supervisors can access admin routes only with explicit permissions:
  - `groupRequests.view`
  - `groupRequests.manage`

## Sub-Agent Meaning

Sub-agent is a customer/business status. It is not an admin role.

Approval sets customer metadata on `User`:

- `isSubAgent`
- `subAgentStatus`
- `subAgentApprovedAt`
- `subAgentApprovedBy`

The workflow never changes `User.role` to `SUPERVISOR`, never grants permissions, and never bypasses normal account activation rules.

## Model

`GroupChangeRequest` stores:

- `userId`
- `requestType`: `GROUP_CHANGE` or `SUB_AGENT`
- `status`: `PENDING`, `APPROVED`, `REJECTED`, `CANCELED`
- `currentGroupId`
- `requestedGroupId`
- `approvedGroupId`
- `reason`
- `adminNote`
- `reviewedBy`
- `reviewedAt`
- `canceledAt`
- user/group snapshots
- `metadata`

Indexes support user timelines, admin filters, reviewer lookup, and a partial unique index on `{ userId, requestType }` for `PENDING` requests.

## Routes

Customer:

- `GET /api/me/group-change-requests/options`
- `POST /api/me/group-change-requests`
- `GET /api/me/group-change-requests`
- `GET /api/me/group-change-requests/:id`
- `POST /api/me/group-change-requests/:id/cancel`

The options endpoint returns customer-safe active group choices for request creation. It includes only `id`, `name`, and `isCurrent`, plus a `currentGroup` summary. It excludes inactive and deleted groups and does not expose pricing percentages or admin metadata.

Admin:

- `GET /api/admin/group-change-requests`
- `GET /api/admin/group-change-requests/:id`
- `PATCH /api/admin/group-change-requests/:id/approve`
- `PATCH /api/admin/group-change-requests/:id/reject`

## Approval Behavior

`GROUP_CHANGE` approval updates `User.groupId` to the approved active group. If `approvedGroupId` is omitted, the requested group is used.

`SUB_AGENT` approval marks the user as an active sub-agent. If `approvedGroupId` is provided, the user is also moved to that active group.

Pricing calculations are not redesigned. They naturally use the user's updated group on future orders.

## Idempotency and Race Safety

- Duplicate pending requests are prevented by service checks and a partial unique index.
- Review writes are guarded by `status: PENDING`.
- Request review and user mutation run in MongoDB transactions.
- Approving an already approved request returns an idempotent success without repeating mutations.
- Rejecting an already rejected request returns an idempotent success without repeating mutations.
- Approved, rejected, and canceled requests cannot be moved back to pending.

## Notifications and Audit

Notifications are best-effort:

- customer notified on submission
- admins/supervisors with matching permissions notified on submission
- customer notified on approval or rejection

Audit logs are best-effort:

- request created
- request canceled
- request approved
- request rejected
- user group changed through request
- user marked as sub-agent

Notification/audit failures do not roll back request creation, approval, or rejection.

## Limitations

- No wallet changes happen in this workflow.
- No referral commission changes happen in this workflow.
- No group-based referral rates are implemented.
- No sub-agent hierarchy, commissions, or profile model is implemented.
- No frontend compatibility aliases are added beyond the canonical routes above.
