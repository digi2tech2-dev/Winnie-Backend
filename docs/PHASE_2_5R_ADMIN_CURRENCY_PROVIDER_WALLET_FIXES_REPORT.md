# Phase 2.5R - Admin Currency / Provider / User Wallet Fixes

## Scope

Phase 2.5R focuses only on admin currency creation consistency, provider quick-create shape, and admin access to a user's wallet/history.

## Backend Changes

- Currency creation now goes through the canonical currency service from the admin proxy route.
- `createCurrency` validates `code`, `name`, `symbol`, `marketRate`, `platformRate`, `markupPercentage`, and `isActive`.
- Duplicate currency codes are still rejected before insert.
- New currencies invalidate the currency conversion cache immediately.
- Provider records now store safe non-secret metadata:
  - `integrationType`, currently `API`.
  - `authType`, one of `NONE`, `API_KEY`, `BEARER_TOKEN`, `USERNAME_PASSWORD`.
- Provider quick-create accepts `code` as an alias for `slug`.
- Existing provider credential encryption and response redaction remain unchanged.

## Registration Currency Source

The public active-currency endpoint remains:

```text
GET /api/currencies/active
```

It returns active database currencies only. The frontend registration page now uses that endpoint and does not rely on hardcoded currency options.

## Admin User Wallet Routes

Existing read-only wallet routes are used:

```text
GET /api/admin/wallets/:userId
GET /api/admin/wallets/:userId/transactions
```

The routes require `wallet.view` through the existing admin RBAC path. No balance mutation was added for the history view.

## Security Notes

- Provider secrets remain in encrypted provider credential fields only.
- Provider API tokens/keys are not serialized in API responses.
- Inactive currencies are not returned to registration.
- Wallet history does not create or mutate transactions.
- Payment, Network International, manual deposit, order debit, and wallet ledger credit flows were not changed.

## Tests

Added or updated backend coverage for:

- currency create requiring a positive `marketRate`;
- currency create preserving `isActive`;
- provider quick-create validation metadata;
- provider quick-create without credentials.

## Verification

Checks run for this phase:

```text
npm.cmd run lint - passed
npm.cmd test -- --runInBand - passed (28 suites, 710 tests)
git diff --check - passed
```

Warnings observed: Git emitted safe.directory and LF-to-CRLF working-copy warnings during diff checks; Jest emitted existing noisy fulfillment/order-polling console output and a duplicate `slug` index warning.
