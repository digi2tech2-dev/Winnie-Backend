# Phase 2.2 Payments Base Report

## Scope

Phase 2.2 added a safe payments base module for wallet top-ups. It did not implement real gateway API calls, production webhooks, direct order payment, referral commissions, or group-change workflows.

## Files Changed

Created:

- `src/modules/payments/payment.constants.js`
- `src/modules/payments/payment.model.js`
- `src/modules/payments/payment.validation.js`
- `src/modules/payments/payment.service.js`
- `src/modules/payments/payment.controller.js`
- `src/modules/payments/payment.routes.js`
- `src/modules/payments/gateways/gateway.interface.js`
- `src/modules/payments/gateways/mock.gateway.js`
- `src/modules/payments/gateways/networkInternational.gateway.js`
- `src/modules/payments/gateways/ziina.gateway.js`
- `src/modules/payments/gateways/tap.gateway.js`
- `src/modules/payments/gateways/gateway.factory.js`
- `src/tests/payment.test.js`
- `docs/PAYMENTS_ARCHITECTURE.md`
- `docs/PHASE_2_2_REPORT.md`

Updated:

- `.env.example`
- `src/app.js`
- `src/config/config.js`
- `src/modules/admin/admin.routes.js`
- `src/modules/audit/audit.constants.js`
- `src/modules/notifications/notification.events.js`
- `src/modules/wallet/walletTransaction.model.js`
- `docs/BASELINE_ARCHITECTURE.md`
- `docs/LEDGER_ARCHITECTURE.md`
- `docs/PHASE_2_FEATURE_TODO.md`

## Payment Model Added

The `Payment` model supports wallet top-up intents with gateway references, status timestamps, checkout URLs, idempotency keys, and wallet credit linkage through `walletTransactionId`.

Safe indexes were added for user history, status history, gateway references, idempotency keys, and wallet transaction linkage.

## Routes Added

Customer:

- `POST /api/payments/intents`
- `GET /api/payments`
- `GET /api/payments/:id`

Development/test mock controls:

- `POST /api/payments/:id/mock-confirm`
- `POST /api/payments/:id/mock-fail`

Admin read-only:

- `GET /api/admin/payments`
- `GET /api/admin/payments/:id`

## Gateway Adapters Added

Operational:

- `MOCK`

Placeholders:

- `NETWORK_INTERNATIONAL`
- `ZIINA`
- `TAP`

Placeholder adapters throw `PAYMENT_GATEWAY_NOT_IMPLEMENTED` and do not call external APIs.

## Wallet Credit Behavior

Payment creation never credits the wallet.

Only non-production mock confirmation can mark a payment `SUCCEEDED` and credit the wallet. The wallet transaction uses:

- legacy `type`: `CREDIT`
- `semanticType`: `CARD_PAYMENT_SUCCESS`
- `sourceType`: `PAYMENT`
- `sourceId`: payment id
- `direction`: `CREDIT`
- `idempotencyKey`: `payment:<paymentId>:wallet-credit`

Mock failure marks the payment `FAILED` and does not create a wallet ledger entry.

## Idempotency Behavior

Payment creation supports an optional idempotency key.

Mock success confirmation is protected by payment status, `creditedAt`, `walletTransactionId`, a wallet ledger idempotency key, and a MongoDB transaction/session.

Calling mock confirmation twice credits the wallet once and returns the already processed payment.

## Security Restrictions

- No card data is stored.
- No real gateway API calls are made.
- Future gateway credential env vars are blank placeholders.
- Customer responses do not expose internal metadata, IP address, user agent, or idempotency keys.
- Browser return URLs do not credit wallets.
- Mock success/failure endpoints are blocked in production.
- Real webhook signature verification is reserved for a future phase.

## Tests Added

`src/tests/payment.test.js` covers:

- creating a mock payment intent
- invalid amount rejection
- customer self-read
- customer cross-user access rejection
- admin list/read service behavior
- real gateway placeholder behavior
- mock confirm success
- one-time wallet credit
- `CARD_PAYMENT_SUCCESS` ledger creation
- mock confirm idempotency
- mock fail without wallet credit
- production blocking for mock confirm/fail

Focused test result:

- `npm.cmd test -- --runInBand src/tests/payment.test.js`: Passed. 1 suite, 10 tests.

Final full verification is recorded below.

| Check | Result |
| --- | --- |
| `npm.cmd run lint` | Passed. Syntax check passed for 166 JavaScript files. |
| `npm.cmd test -- --runInBand` | Passed. 19 test suites passed, 602 tests passed. |
| `git diff --check` | Passed. Git emitted CRLF normalization warnings and an unrelated malformed global `safe.directory` warning, but no whitespace errors. |

## Remaining Warnings

- Real payment gateways remain placeholders.
- Production webhooks are not implemented.
- Payment fees are currently fixed at `0`.
- Payment currency must match wallet currency in Phase 2.2.
- No admin payment mutation endpoints were added.
- Jest remains noisy because existing fulfillment/polling tests intentionally exercise logged error paths.
