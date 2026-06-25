# Phase 2.1 Wallet Ledger Report

## Scope

Phase 2.1 expanded the wallet ledger taxonomy and normalized active transaction write paths. It did not implement card payment gateway logic, payment webhooks, referral commission logic, group-change workflows, frontend compatibility routes, or a wallet module redesign.

## Files Changed

- `src/modules/wallet/walletTransaction.model.js`
- `src/modules/wallet/wallet.service.js`
- `src/modules/deposits/deposit.service.js`
- `src/modules/orders/order.service.js`
- `src/modules/orders/orderFulfillment.service.js`
- `src/modules/admin/admin.wallet.service.js`
- `src/modules/admin/admin.orders.service.js`
- `src/tests/admin.test.js`
- `src/tests/deposit.test.js`
- `src/tests/fulfillment.test.js`
- `src/tests/order.test.js`
- `src/tests/walletLedger.test.js`
- `docs/LEDGER_ARCHITECTURE.md`
- `docs/PHASE_2_FEATURE_TODO.md`
- `docs/BASELINE_ARCHITECTURE.md`
- `docs/PHASE_2_1_REPORT.md`

## Model Changes

`WalletTransaction` keeps the legacy `type` enum:

- `CREDIT`
- `DEBIT`
- `REFUND`
- `DEBT_ADJUSTMENT`

It now also supports:

- `semanticType`
- `sourceType`
- `sourceId`
- `direction`
- `currency`
- `metadata`
- `idempotencyKey`
- `actorId`
- `actorRole`

The optional `idempotencyKey` has a unique partial index when present.

## Ledger Types Added

Active or legacy:

- `CREDIT`
- `DEBIT`
- `REFUND`
- `DEBT_ADJUSTMENT`
- `DEPOSIT_APPROVED`
- `ORDER_DEBIT`
- `ORDER_REFUND`
- `ADMIN_ADJUSTMENT`

Reserved for future modules:

- `CARD_PAYMENT_SUCCESS`
- `CARD_PAYMENT_FAILED`
- `REFERRAL_COMMISSION`
- `REFERRAL_REVERSAL`

## Active Flow Classification

- Deposit approval: legacy `CREDIT`, semantic `DEPOSIT_APPROVED`.
- Order creation wallet debit: legacy `DEBIT`, semantic `ORDER_DEBIT`.
- Order refunds: legacy `REFUND`, semantic `ORDER_REFUND`.
- Provider failure refunds: legacy `REFUND`, semantic `ORDER_REFUND`.
- Admin wallet add/deduct/set: semantic `ADMIN_ADJUSTMENT`.
- Bulk debt adjustments: legacy and semantic `DEBT_ADJUSTMENT`, with direction set to `DEBIT` for inflation and `CREDIT` for relief.
- Admin forced order completion re-deduction: legacy `DEBIT`, semantic `ORDER_DEBIT`, with admin actor metadata.

## Backward Compatibility

Existing routes and tests that rely on `type` remain compatible. Wallet stats still aggregate by legacy `type`.

New reporting should prefer `semanticType`, `direction`, `sourceType`, and `sourceId`.

Existing historical records may not include the new fields until a migration backfills them.

## Tests Updated

- Deposit approval tests now verify `DEPOSIT_APPROVED` ledger classification.
- Order debit and refund tests now verify `ORDER_DEBIT` and `ORDER_REFUND`.
- Fulfillment refund tests now verify provider failure refunds are `ORDER_REFUND`.
- Admin wallet tests now verify manual wallet changes are `ADMIN_ADJUSTMENT`.
- Added `walletLedger.test.js` for legacy defaults, reserved semantic types, and idempotency key uniqueness.

## Verification

Initial syntax checks passed for:

- `src/modules/wallet/walletTransaction.model.js`
- `src/modules/wallet/wallet.service.js`
- `src/modules/orders/order.service.js`
- `src/modules/orders/orderFulfillment.service.js`
- `src/modules/admin/admin.wallet.service.js`
- `src/modules/admin/admin.orders.service.js`
- `src/modules/deposits/deposit.service.js`

| Check | Result |
| --- | --- |
| `npm.cmd run lint` | Passed. Syntax check passed for 153 JavaScript files. |
| `npm.cmd test -- --runInBand` | Passed. 18 test suites passed, 592 tests passed. |
| `git diff --check` | Passed. Git emitted CRLF normalization warnings and an unrelated malformed global `safe.directory` warning, but no whitespace errors. |

## Remaining Warnings

- No card payment, webhook, referral commission, or referral reversal flow writes the reserved semantic types yet.
- No historical migration was run in Phase 2.1.
- Monetary storage remains numeric in `WalletTransaction`; Decimal/string normalization was intentionally not changed.
- Admin manual wallet adjustments do not yet have natural idempotency keys.
- Jest remains noisy because existing fulfillment/audit tests intentionally exercise error paths that log to console.
