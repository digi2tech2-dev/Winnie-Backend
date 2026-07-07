# Phase 2 Feature TODO

Phase 2 should build new business features on top of the cleaned baseline. None of these items are implemented in Phase 1.

## Card / Online Payments Module

Purpose: let customers fund wallets or pay invoices through an online payment gateway.

Phase 2.2 status: a wallet top-up only payments base module exists with `Payment`, mock gateway support, real gateway placeholders, and one-time wallet credit through `CARD_PAYMENT_SUCCESS`. Phase 2.5N adds admin-configured online payment risk limits before gateway/payment-intent creation. Phase 2.5P implements Network International / N-Genius Hosted Payment Page order creation and authenticated status sync for wallet top-up only. Phase 2.5P.1 adds backend Network gateway currency conversion so the requested wallet top-up currency can differ from the configured Network outlet currency. Phase 2.5Q adds Network webhook intake, safe event persistence, dedupe, provider re-fetch before credit, and admin reconciliation. Phase 2.5S adds a safe admin payments list/detail/reconciliation UI backed by `/api/admin/payments`. Phase 2.5W implements Paymento hosted USDT wallet top-ups with backend fiat conversion, the Paymento `Api-key` create/verify contract, token checkout URL handling, HMAC IPN verification when configured, provider verify/status before success, and idempotent wallet credit. See `docs/PAYMENTS_ARCHITECTURE.md`.

Suggested future models: gateway-specific `PaymentWebhookEvent`, optional `PaymentMethod`, and reconciliation records.

Current endpoints: `POST /api/payments/intents`, `GET /api/payments`, `GET /api/payments/:id`, `POST /api/payments/:id/sync-status`, `POST /api/webhooks/payments/network`, `POST /api/webhooks/payments/paymento`, `GET /api/admin/payments`, `GET /api/admin/payments/:id`, `POST /api/admin/payments/:id/sync-status`, plus non-production mock confirmation/failure endpoints.

Suggested future endpoints: scheduled reconciliation jobs and settlement/reconciliation reporting endpoints.

Dependencies: gateway SDK/API choice, webhook signature verification, settlement/fee rules, admin settings.

Risks: double-crediting, chargebacks, currency conversion drift, PCI/security boundaries, replayed webhooks. Phase 2.5N reduces gateway-abuse exposure by blocking unusual online top-up amount/attempt patterns before a gateway call is made. Phase 2.5P keeps card data on Network hosted pages and never credits the wallet from browser return alone. Phase 2.5P.1 snapshots requested/gateway currency conversion with platform rates and keeps wallet credit based on the intended payment amount/currency. Phase 2.5Q deduplicates webhook events and still re-fetches Network status before success/credit. Phase 2.5W keeps USDT checkout hosted by Paymento, verifies Paymento status server-side before success, and never credits from IPN/browser return payload alone.

## Payment Gateway Webhooks

Purpose: receive asynchronous gateway status events and reconcile wallet credits.

Suggested models: `PaymentWebhookEvent`, webhook event metadata on `PaymentTransaction`.

Suggested endpoints: `POST /api/webhooks/payments/:provider`.

Dependencies: confirmed Network portal webhook header/signature settings, confirmed Paymento signature headers, replay protection, payment state machine, gateway-specific event schemas. Phase 2.5Q supports shared-header secret verification and unverified intake mode that still requires provider status re-fetch before credit. Phase 2.5W supports Paymento create at `/v1/payment/request`, verify at `/v1/payment/verify`, token-based checkout/status sync, HMAC SHA-256 verification when `PAYMENTO_IPN_SECRET` is configured, and still requires Paymento verify/status before credit.

Risks: replay attacks, out-of-order events, retry storms, partial wallet updates.

## Referral / Invitation Commission Module

Purpose: track invited users and optionally credit commissions when configured business events occur.

Phase 2.3 status: implemented as a safe referral module with `ReferralRelationship`, `ReferralCommission`, global `referrals` settings, customer/admin routes, registration invite-code support, and idempotent commission crediting for `DEPOSIT_APPROVED` and `CARD_PAYMENT_SUCCESS`. See `docs/REFERRALS_ARCHITECTURE.md`.

Current endpoints: `GET /api/me/referrals`, `GET /api/me/referrals/commissions`, `POST /api/referrals/validate-code`, `GET /api/admin/referral-settings`, `PATCH /api/admin/referral-settings`, `GET /api/admin/referrals/relationships`, `GET /api/admin/referrals/commissions`.

Future dependencies: group-based referral rates, reversal policy, fraud scoring, and richer admin reporting.

Remaining risks: reversal behavior on refunds is intentionally reserved; advanced abuse controls are outside Phase 2.3.

## Group-Change / Sub-Agent Request Workflow

Purpose: let users request different pricing groups or sub-agent status for admin review.

Phase 2.4 status: implemented as a safe request workflow with `GroupChangeRequest`, customer request/cancel routes, admin review routes, explicit supervisor permissions, and business-level sub-agent flags on `User`. Phase 2.5T adds an admin-only direct group assignment route for operational corrections; it updates `User.groupId` only, leaves roles untouched, and affects future order pricing only. See `docs/GROUP_REQUESTS_ARCHITECTURE.md`.

Current customer endpoints: `GET /api/me/group-change-requests/options`, `POST /api/me/group-change-requests`, `GET /api/me/group-change-requests`, `GET /api/me/group-change-requests/:id`, `POST /api/me/group-change-requests/:id/cancel`.

Current admin endpoints: `GET /api/admin/group-change-requests`, `GET /api/admin/group-change-requests/:id`, `PATCH /api/admin/group-change-requests/:id/approve`, `PATCH /api/admin/group-change-requests/:id/reject`.

Future dependencies: richer group eligibility policy, optional sub-agent profile fields, frontend compatibility aliases, and any hierarchy/reporting model.

Remaining risks: pricing changes naturally apply to future orders only after user group update; sub-agent is intentionally not a privileged role and does not grant permissions.

## Admin User Wallet Controls

Phase 2.5T status: implemented admin user wallet controls on top of existing wallet routes. Admins can add balance, deduct balance, update credit/debt limit with a reason, and directly assign an active pricing group. Add/deduct actions create real `ADMIN_ADJUSTMENT` wallet transactions and audit logs. Credit-limit updates are account settings and do not create wallet movement rows. Group assignment is admin-only, validates active/non-deleted groups, and does not change user roles or historical orders.

Current endpoints: `GET /api/admin/wallets/:userId`, `GET /api/admin/wallets/:userId/transactions`, `POST /api/admin/wallets/:userId/add`, `POST /api/admin/wallets/:userId/deduct`, `PATCH /api/admin/users/:id/credit-limit`, `PATCH /api/admin/users/:id/group`.

Remaining risks: manual add/deduct entries do not have natural idempotency keys; frontend group selection depends on access to the admin groups endpoint.

## Updated Wallet Ledger Types

Purpose: make wallet history explicit enough for payments, referrals, orders, refunds, and manual adjustments.

Suggested models: extend `WalletTransaction` or introduce a stricter ledger entry model.

Suggested endpoints: preserve existing wallet history routes; add admin filters by ledger type/source.

Phase 2.1 status: the existing `WalletTransaction` model now keeps legacy `type` values and adds `semanticType`, `sourceType`, `sourceId`, `direction`, `currency`, metadata, actor fields, and optional idempotency keys. See `docs/LEDGER_ARCHITECTURE.md`.

Dependencies still remaining: migration plan for existing `CREDIT`, `DEBIT`, `REFUND`, `DEBT_ADJUSTMENT` records; admin/reporting filters by semantic type/source; final payment/referral business rules.

Risks: breaking balance reconciliation, mixing display labels with accounting semantics.

Active or reserved semantic types:

- `DEPOSIT_APPROVED`
- `ORDER_DEBIT`
- `ORDER_REFUND`
- `ADMIN_ADJUSTMENT`
- `DEBT_ADJUSTMENT`
- `CARD_PAYMENT_SUCCESS`
- `CARD_PAYMENT_FAILED`
- `REFERRAL_COMMISSION`
- `REFERRAL_REVERSAL`

## Frontend API Compatibility Layer

Purpose: adapt current backend responses to the new frontend without breaking stable API routes.

Suggested models: none unless API client/version settings are needed.

Suggested endpoints: versioned or compatibility routes only where existing shapes cannot be reused.

Dependencies: frontend contract, pagination conventions, auth/session expectations.

Risks: duplicate routes drifting from canonical services, accidental breaking changes.

## Customer Currency Update

Phase 2.5I.1 status: implemented `PATCH /api/me/currency` for authenticated active customers. The endpoint validates `{ currency }` against active platform currencies and updates only `User.currency`; it does not recalculate wallet balances, wallet ledger records, orders, deposits, payments, pricing groups, or referrals.

Current customer endpoints: `GET /api/currencies/active` and `PATCH /api/me/currency`.

Remaining risks: currency changes affect future display/pricing behavior according to existing services only. Historical wallet/order/deposit/payment records keep their stored currency snapshots.

## Customer Password Change

Phase 2.5M.1 status: implemented `PATCH /api/me/password` for authenticated active customers. The endpoint requires `currentPassword`, validates and verifies it against the stored hash, validates `newPassword` with the existing registration strength rule, and saves only the new hashed password through the User model pre-save hook.

Current customer endpoint: `PATCH /api/me/password`.

Remaining risks: existing JWT sessions are not revoked because the backend has no refresh-token/logout/session-revocation model.

## Provider Credentials Encryption

Phase 2.5H.1 status: provider `apiToken` and legacy `apiKey` fields are encrypted at rest with AES-256-GCM using `PROVIDER_CREDENTIALS_KEY`. Provider list/detail responses expose only safe credential booleans, and adapters decrypt credentials internally when backend provider actions run.

Operational requirement: generate a 32-byte key with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` and set `PROVIDER_CREDENTIALS_KEY` before creating/updating providers or calling provider APIs.

Migration: run `npm run migrate:provider-credentials` to encrypt existing plaintext provider credentials. The script skips already encrypted values and prints counts only.

## Admin Settings for Referral and Payment Rules

Purpose: let admins configure payment provider behavior, referral rules, commission rates, and operational limits.

Phase 2.3 status: referral settings are stored as one `referrals` `Setting` value with `enabled`, `depositCommissionPercentage`, `applyTo`, `minSourceAmount`, and `maxCommissionAmount`.

Phase 2.5N status: online payment risk limits are stored as one `paymentRiskLimits` `Setting` value with `enabled`, amount limits, attempt limits, new-account limits, fixed `action`, and customer message. The payment intent service enforces the setting server-side before gateway adapter creation.

Current referral endpoints: `GET /api/admin/referral-settings` and `PATCH /api/admin/referral-settings`.

Dependencies still remaining: payment provider settings beyond Phase 2.2 placeholders and any future typed settings split.

Risks: changing live rules without operational communication; Phase 2.3 validates percentage ranges and audits referral settings updates.
