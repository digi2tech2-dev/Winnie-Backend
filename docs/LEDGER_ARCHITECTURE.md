# Wallet Ledger Architecture

## Overview

The wallet ledger keeps the existing `type` field for API compatibility and adds explicit Phase 2 classification fields for clearer financial history.

Compatibility rule:

- `type` remains the legacy bucket used by existing clients and aggregate stats: `CREDIT`, `DEBIT`, `REFUND`, `DEBT_ADJUSTMENT`.
- `semanticType` is the canonical business event type for new reporting and future modules.
- `direction` describes balance movement: `CREDIT`, `DEBIT`, or `NEUTRAL`.
- `sourceType` and `sourceId` point to the business object that caused the entry.

## Transaction Fields

Active ledger entries now support:

- `type`: legacy compatible transaction bucket.
- `semanticType`: explicit business event taxonomy.
- `sourceType`: source domain, such as `ORDER`, `DEPOSIT`, or `ADMIN_ADJUSTMENT`.
- `sourceId`: source document id when available.
- `direction`: balance direction.
- `amount`: transaction amount in the recorded currency.
- `balanceBefore` and `balanceAfter`: wallet balance snapshot.
- `currency`: 3-letter wallet currency snapshot.
- `status`: `PENDING`, `COMPLETED`, or `FAILED`.
- `description`: human-readable summary.
- `metadata`: structured event context.
- `idempotencyKey`: optional natural duplicate-protection key.
- `actorId` and `actorRole`: actor that caused the entry when known.

## Taxonomy

| semanticType | Legacy type | Direction | Status |
| --- | --- | --- | --- |
| `CREDIT` | `CREDIT` | `CREDIT` | Legacy/default only |
| `DEBIT` | `DEBIT` | `DEBIT` | Legacy/default only |
| `REFUND` | `REFUND` | `CREDIT` | Legacy/default only |
| `DEBT_ADJUSTMENT` | `DEBT_ADJUSTMENT` | `CREDIT`, `DEBIT`, or `NEUTRAL` | Active |
| `DEPOSIT_APPROVED` | `CREDIT` | `CREDIT` | Active |
| `ORDER_DEBIT` | `DEBIT` | `DEBIT` | Active |
| `ORDER_REFUND` | `REFUND` | `CREDIT` | Active |
| `ADMIN_ADJUSTMENT` | `CREDIT` or `DEBIT` | `CREDIT` or `DEBIT` | Active |
| `CARD_PAYMENT_SUCCESS` | `CREDIT` | `CREDIT` | Reserved |
| `CARD_PAYMENT_FAILED` | `CREDIT`, `DEBIT`, or `REFUND` | `NEUTRAL` by expected use | Reserved |
| `REFERRAL_COMMISSION` | `CREDIT` | `CREDIT` | Reserved |
| `REFERRAL_REVERSAL` | `DEBIT` or `REFUND` | `DEBIT` by expected use | Reserved |

Reserved means the enum accepts the value, but no Phase 2.1 business flow writes it yet.

## Active Write Flows

- Deposit approval writes `type: CREDIT`, `semanticType: DEPOSIT_APPROVED`, `sourceType: DEPOSIT`.
- Order creation wallet debit writes `type: DEBIT`, `semanticType: ORDER_DEBIT`, `sourceType: ORDER`.
- Manual failed-order refund writes `type: REFUND`, `semanticType: ORDER_REFUND`, `sourceType: ORDER`.
- Provider failure and cancellation refunds write `type: REFUND`, `semanticType: ORDER_REFUND`, `sourceType: ORDER`.
- Admin add, deduct, and set-balance operations write `semanticType: ADMIN_ADJUSTMENT`.
- Bulk debt inflation and deflation keep `type: DEBT_ADJUSTMENT` and write `semanticType: DEBT_ADJUSTMENT`.

## Idempotency

Phase 2.1 does not implement payment idempotency or webhook handling.

The ledger now supports an optional unique `idempotencyKey`. Current flows use natural keys where safe:

- `deposit:<depositId>:approved`
- `order:<orderId>:debit`
- `order:<orderId>:refund:failed`
- `order:<orderId>:refund:provider`
- `order:<orderId>:refund:full`
- `order:<orderId>:refund:partial:<remains>`
- `order:<orderId>:forced-complete-rededuction`

Manual admin add/deduct/set entries do not currently have a natural idempotency key.

## Backward Compatibility

Existing API routes and response shapes are preserved. Historical consumers can continue filtering and aggregating by `type`.

New consumers should prefer `semanticType`, `direction`, `sourceType`, and `sourceId` for finance history screens and admin reporting.

Existing database records may not have the new fields. When new records are created with only the legacy `type`, model defaults fill `semanticType` and `direction`. Old persisted records should be backfilled before production reporting depends on the new fields.

## Migration Considerations

A future migration should backfill:

- `semanticType` from `type` where missing.
- `direction` from `type` where missing.
- `currency` from the owning user or order where available.
- `sourceType` and `sourceId` from `reference` when the referenced domain is known.

Do not infer deposit/order/admin semantics blindly for old `CREDIT` or `DEBIT` records unless the source can be verified.

## Known Limitations

- Money is still stored as `Number` in `WalletTransaction`; Decimal/string monetary normalization remains outside Phase 2.1.
- `reference` is retained as a legacy populated field and may point at non-order ids in older flows.
- Card payment, webhook, referral commission, and referral reversal logic is not implemented.
- Wallet stats still aggregate by legacy `type` to preserve existing behavior.
