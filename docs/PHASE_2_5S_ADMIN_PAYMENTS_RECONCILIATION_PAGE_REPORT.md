# Phase 2.5S Admin Payments & Reconciliation Page Report

## Scope

Phase 2.5S connects the existing admin payment/reconciliation backend contract to a dedicated admin UI. The backend remains wallet top-up focused and continues to rely on the existing provider verification path before any wallet credit.

## Backend routes used/updated

- `GET /api/admin/payments`
- `GET /api/admin/payments/:id`
- `POST /api/admin/payments/:id/sync-status`

The existing admin routes remain protected by `payments.view`. The list route now supports the existing payment filters plus `userId`, `purpose`, and `credited`.

## Safe response fields

Admin payment responses include:

- payment identifiers, purpose, gateway, method, status
- requested amount/currency and total/fee fields
- safe gateway references
- safe gateway currency conversion summary
- safe risk summary
- credited state and wallet transaction reference
- safe user summary
- recent webhook event summaries on detail

Admin responses no longer expose raw `metadata.gatewayMetadata`, provider payloads, Network access tokens, API keys, outlet references, authorization headers, webhook secrets, or card data.

## Sync/reconcile behavior

The admin sync route still calls `paymentService.syncPaymentStatus`, which re-fetches authoritative provider status for Network payments. Wallet credit remains idempotent and uses the requested `Payment.amount`/`Payment.currency`, not the converted gateway charge.

## Tests/checks run

- Added a Network payment regression test for safe admin list serialization and sanitized metadata.
- `npm.cmd run lint` passed.
- `npm.cmd test -- networkInternationalPayment.test.js --runInBand` passed.
- `npm.cmd test -- --runInBand` passed: 28 suites, 711 tests.
- `git diff --check` passed with Git line-ending/safe.directory warnings only.

## Limitations

- The admin list is intentionally operational, not a settlement or revenue analytics dashboard.
- Webhook event summaries are safe summaries only; raw webhook payloads remain hidden.
