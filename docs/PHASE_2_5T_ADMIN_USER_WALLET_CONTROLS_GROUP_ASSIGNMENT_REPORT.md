# Phase 2.5T - Admin User Wallet Controls & Group Assignment

## Scope

Phase 2.5T adds safe admin controls around the existing admin user wallet page:

- Add wallet balance.
- Deduct wallet balance.
- Set user credit/debt limit.
- Directly assign a user's pricing group.
- Keep wallet transaction history as the source of truth for money movement.

Payments, Network International, deposits, order debit/refund, and customer wallet flows were not changed.

## Backend Routes Used/Added

- Existing: `GET /api/admin/wallets/:userId`
- Existing: `GET /api/admin/wallets/:userId/transactions`
- Existing: `POST /api/admin/wallets/:userId/add`
- Existing: `POST /api/admin/wallets/:userId/deduct`
- Existing, enhanced: `PATCH /api/admin/users/:id/credit-limit`
- Added: `PATCH /api/admin/users/:id/group`

## Wallet Adjustment Behavior

Admin wallet add/deduct still goes through `admin.wallet.service`.

- Amount must be positive and within the existing maximum adjustment guard.
- Reason is required by the existing wallet adjustment validation.
- Add writes a `CREDIT` wallet transaction with `semanticType: ADMIN_ADJUSTMENT`.
- Deduct writes a `DEBIT` wallet transaction with `semanticType: ADMIN_ADJUSTMENT`.
- Both operations write audit metadata and actor information.
- Deduction respects the user's balance plus available credit limit.
- The credit-used calculation now handles users already in debt without double-counting drawn credit.

No direct wallet balance setting was added to the frontend controls.

## Credit/Debt Limit Behavior

`PATCH /api/admin/users/:id/credit-limit` now accepts:

```json
{
  "creditLimit": 500,
  "reason": "Trusted reseller"
}
```

Rules:

- `creditLimit` must be a number greater than or equal to zero.
- `reason` is required for audit context.
- Updating credit limit does not create a wallet transaction.
- Existing order/wallet debit logic continues to enforce negative balance only up to the configured credit limit.

## Group Assignment Behavior

`PATCH /api/admin/users/:id/group` accepts:

```json
{
  "groupId": "64f000000000000000000000",
  "reason": "Moved to reseller group"
}
```

Rules:

- Admin-only route.
- Target group must exist, be active, and not be soft-deleted.
- Only `User.groupId` changes.
- User role and supervisor permissions are not changed.
- Pricing changes apply to future orders only.
- Group-change request workflow remains unchanged.

## Security Notes

- Customers cannot access these admin routes.
- Supervisors keep existing wallet permissions: view wallet with `wallet.view`, add only where existing route/service permission allows, and no deduction.
- Credit limit and group assignment are admin-only.
- Wallet balance changes always create wallet ledger records and audit logs.
- No payment provider secrets, Network credentials, or raw provider payloads are exposed.

## Tests/Checks

- Added backend tests in `src/tests/admin.test.js` for:
  - credit-limit update without wallet transaction
  - negative credit-limit rejection
  - active group assignment
  - inactive group rejection
  - debt deduction credit-used correctness
  - credit-limit and group validation schemas
- Focused check run: `npm.cmd test -- admin.test.js --runInBand` passed.
- Backend lint run: `npm.cmd run lint` passed.
- Full backend test run: `npm.cmd test -- --runInBand` passed, 28 suites / 718 tests.
- Backend diff check: `git diff --check` passed.

## Limitations

- Manual admin add/deduct entries do not have a natural idempotency key.
- The frontend group dropdown uses `/api/admin/groups`; admins without group-management permission may see wallet controls while group options are unavailable.

## Status

Implementation complete.
