# Phase 1.5 Test Reconciliation Report

## Scope

Phase 1.5 reconciled stale/pre-existing tests with the cleaned Phase 1 backend baseline. No Phase 2 features were implemented.

Not implemented in this phase:

- Card or online payment gateway logic
- Payment webhooks
- Referral commission logic
- Group-change/sub-agent workflow
- New frontend compatibility layer

## Baseline Contracts Confirmed

- Product/provider/order monetary fields such as `rawPrice`, `basePrice`, `basePriceSnapshot`, `finalPriceCharged`, `totalPrice`, and `usdAmount` are precision strings.
- Wallet-facing amounts such as `walletBalance`, `walletDeducted`, transaction amounts, and `chargedAmount` remain numeric.
- Provider-canceled statuses map to internal `CANCELED`.
- Internal hard failures, provider rejections, and retry exhaustion use `FAILED`.
- Provider poll statistics still aggregate terminal refund actions under the existing `failed` counter.
- Unknown provider statuses defensively default to `PROCESSING`.
- Deposit requests use the current schema fields: `paymentMethodId`, `requestedAmount`, `currency`, `exchangeRate`, `amountUsd`, and `receiptImage`.

## Test Categories Reconciled

- Deposit tests: rewritten to the current deposit model/service flow.
- Monetary tests: updated to Decimal/string-aware assertions.
- Provider adapter tests: updated to actual retained adapter endpoints and payloads.
- Fulfillment/order polling tests: updated to canonical `CANCELED` status and unique direct fixture order numbers.
- Admin tests: updated to current wallet response envelope and setting upsert behavior.
- Audit tests: updated to current refund metadata names.
- Currency tests: updated for string order `usdAmount` snapshots and current `updateCurrencyRate()` return shape.

## Production Fixes

- `src/modules/orders/pricing.service.js`: fixed fractional percentage math to avoid JavaScript floating artifacts before Decimal arithmetic.
- `src/modules/orders/orderFulfillment.service.js`: fixed immediate provider cancellation handling so it follows the existing canceled/refund path.
- `src/modules/providers/statusMapper.js`: aligned comments with the canonical `CANCELED` mapping.

## Final Checks

```bash
npm.cmd run lint
```

Passed:

```text
Syntax check passed for 152 JavaScript files.
```

```bash
npm.cmd test -- --runInBand
```

Passed:

```text
Test Suites: 17 passed, 17 total
Tests:       589 passed, 589 total
Snapshots:   0 total
Time:        160.03 s
```

```bash
git diff --check
```

Passed with no whitespace errors.

## Remaining Warnings

- Jest still force-exits because the test script includes `--forceExit`; fire-and-forget fulfillment/audit/notification work can remain briefly active after tests.
- Some suites intentionally log expected error-path messages.
- Git prints local safe.directory and LF/CRLF normalization warnings; these did not fail `git diff --check`.

## Status

Phase 1.5 is complete. The baseline test suite is green.
