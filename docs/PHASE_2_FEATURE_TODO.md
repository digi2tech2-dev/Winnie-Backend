# Phase 2 Feature TODO

Phase 2 should build new business features on top of the cleaned baseline. None of these items are implemented in Phase 1.

## Card / Online Payments Module

Purpose: let customers fund wallets or pay invoices through an online payment gateway.

Phase 2.2 status: a wallet top-up only payments base module exists with `Payment`, mock gateway support, real gateway placeholders, and one-time wallet credit through `CARD_PAYMENT_SUCCESS`. See `docs/PAYMENTS_ARCHITECTURE.md`.

Suggested future models: gateway-specific `PaymentWebhookEvent`, optional `PaymentMethod`, and reconciliation records.

Current endpoints: `POST /api/payments/intents`, `GET /api/payments`, `GET /api/payments/:id`, `GET /api/admin/payments`, `GET /api/admin/payments/:id`, plus non-production mock confirmation/failure endpoints.

Suggested future endpoints: real gateway checkout/webhook endpoints and admin reconcile endpoints.

Dependencies: gateway SDK/API choice, webhook signature verification, settlement/fee rules, admin settings.

Risks: double-crediting, chargebacks, currency conversion drift, PCI/security boundaries, replayed webhooks.

## Payment Gateway Webhooks

Purpose: receive asynchronous gateway status events and reconcile wallet credits.

Suggested models: `PaymentWebhookEvent`, webhook event metadata on `PaymentTransaction`.

Suggested endpoints: `POST /api/webhooks/payments/:provider`.

Dependencies: signature verification, replay protection, payment state machine, gateway-specific event schemas.

Risks: replay attacks, out-of-order events, retry storms, partial wallet updates.

## Referral / Invitation Commission Module

Purpose: track invited users and optionally credit commissions when configured business events occur.

Suggested models: `ReferralInvitation`, `ReferralRule`, `ReferralCommission`.

Suggested endpoints: `GET /api/me/referrals`, `POST /api/me/referrals/invite`, admin rule management.

Dependencies: final commission policy, wallet ledger types, fraud controls.

Risks: self-referral, duplicate commission credit, unclear reversal behavior on refunds.

## Group-Change / Sub-Agent Request Workflow

Purpose: let users request different pricing groups or sub-agent status for admin review.

Suggested models: `GroupChangeRequest`, optional `SubAgentProfile`.

Suggested endpoints: `POST /api/me/group-change-requests`, `GET /api/admin/group-change-requests`, approve/reject routes.

Dependencies: final hierarchy policy, group eligibility rules, supervisor permissions.

Risks: unauthorized group escalation, stale pricing assumptions, unclear audit ownership.

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

## Admin Settings for Referral and Payment Rules

Purpose: let admins configure payment provider behavior, referral rules, commission rates, and operational limits.

Suggested models: extend `Setting` or add typed `PaymentSetting` and `ReferralSetting` models.

Suggested endpoints: admin settings read/update routes with strict validation.

Dependencies: final policy decisions, audit requirements, supervisor permissions.

Risks: unsafe defaults, unvalidated money rules, changing live rules without audit trail.
