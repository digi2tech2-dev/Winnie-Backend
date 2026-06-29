# Baseline Architecture

## Current Architecture

The backend is a modular Express monolith. `src/app.js` builds the Express app, installs security, CORS, parsing, static uploads, rate limits, and route modules. `src/server.js` connects MongoDB, starts HTTP, and starts background jobs outside test mode.

MongoDB access is through Mongoose models inside each module. Controllers stay thin, services hold business rules, and shared middleware handles authentication, authorization, validation, uploads, and error handling.

## Modules

- `auth`: registration, login, email verification, 2FA, optional Google OAuth.
- `users`: admin and self-service user profile/account actions.
- `me`: active-user panel for profile, wallet, products, orders, and deposits.
- `groups`: pricing group tiers and active/inactive group management.
- `wallet`: balance mutations and wallet transaction history.
- `deposits`: deposit request lifecycle and admin review.
- `payments`: wallet top-up payment intents with mock-only confirmation in non-production.
- `referrals`: referral codes, inviter relationships, global referral settings, and idempotent commission credits.
- `groupRequests`: customer group-change and sub-agent requests with admin/supervisor review.
- `products` and `categories`: platform catalog.
- `providers`: provider records, adapter factory, live adapter calls, catalog sync.
- `orders`: order pricing, wallet debit/refund, provider fulfillment, status polling.
- `notifications`: user/admin notification records and event helpers.
- `audit`: audit log creation and sensitive metadata redaction.
- `currency`: active currencies, exchange rates, and debt adjustment helpers.
- `admin`: dashboard and back-office orchestration routes.
- `client`: API-token customer integration routes.

## Auth Flow

Registration validates `name`, `email`, `password`, optional profile fields, and optional `inviteCode`/`referralCode`. A valid invite code links the new user to the inviter; an invalid or self-referral code rejects registration. A customer is created as `PENDING`, `verified=false`, assigned to the highest-percentage active group, and sent an email verification link.

Login requires a verified email and `status=ACTIVE`. JWTs contain `id` and `role`. 2FA-enabled accounts receive a temporary 2FA token until OTP verification succeeds. Google OAuth is initialized only when Google credentials exist.

## User Status Flow

`User.status` is the access source of truth:

- `PENDING`: registered but not approved.
- `ACTIVE`: approved and allowed through active-user routes.
- `REJECTED`: denied or revoked.

`isActive` is a virtual compatibility shim for `status === ACTIVE`.

## Wallet, Deposit, and Order Flow

Deposits are customer-created requests with a receipt stored under `uploads/deposits`. Admin review approves or rejects. Approval credits the user's wallet using the current deposit service conversion logic and writes wallet/audit records.

Orders debit wallet balance atomically, create order records, and either fulfill through a provider adapter or enter manual/provider-processing states. Refund and forced-complete paths use wallet service helpers and audit logs.

Wallet transactions keep legacy `type` values (`CREDIT`, `DEBIT`, `REFUND`, `DEBT_ADJUSTMENT`) and now carry Phase 2 ledger fields such as `semanticType`, `direction`, `sourceType`, `sourceId`, `currency`, metadata, actor fields, and optional idempotency keys. See `docs/LEDGER_ARCHITECTURE.md`.

Online payments are prepared for wallet top-ups only. `POST /api/payments/intents` creates a payment intent and never credits the wallet. In development/test, the mock gateway can confirm success and credit the wallet once with `CARD_PAYMENT_SUCCESS`. Real gateways and production webhooks remain future work. See `docs/PAYMENTS_ARCHITECTURE.md`.

Referrals are active for invitation tracking and global commission settings. Eligible successful wallet credits (`DEPOSIT_APPROVED` and `CARD_PAYMENT_SUCCESS`) can credit the inviter with `REFERRAL_COMMISSION` when the configured percentage is greater than zero. Admin wallet adjustments, order debits, and order refunds do not trigger referral commission. See `docs/REFERRALS_ARCHITECTURE.md`.

Group-change and sub-agent requests are customer self-service workflows reviewed by admins. Customers can fetch a safe active-group options list for group-change request creation; that list exposes only group id/name/current markers, not pricing percentages or admin metadata. A group-change approval updates `User.groupId`, so pricing changes apply naturally to future orders. A sub-agent approval sets business-level fields on the user (`isSubAgent`, `subAgentStatus`, approval stamp fields) and may optionally update `groupId`. It never changes `role`, never grants supervisor permissions, and has no wallet or referral side effects. See `docs/GROUP_REQUESTS_ARCHITECTURE.md`.

## Provider Architecture

Provider records store `name`, `slug`, `baseUrl`, `apiToken`/`apiKey`, active state, sync interval, and supported features. The adapter factory maps known provider slugs/names to adapter classes and falls back to the mock adapter for unknown providers unless strict mode is requested.

No provider is seeded by default. Provider tokens are currently plaintext and must be encrypted before production.

## RBAC and Supervisor Permissions

Roles are `ADMIN`, `SUPERVISOR`, and `CUSTOMER`. Admins bypass permission checks. Supervisors must have route-specific permission strings.

Permission keys currently used by route guards:

- `dashboard.view`
- `users.view`
- `users.delete`
- `users.status`
- `wallet.view`
- `wallet.adjust`
- `payments.view`
- `referrals.view`
- `groupRequests.view`
- `groupRequests.manage`
- `suppliers.manage`
- `products.view`
- `products.manage`
- `products.provider.sync`
- `orders.view`
- `orders.update`
- `orders.refund`
- `groups.manage`
- `topups.review`
- Legacy aliases on provider listing only: `manage_providers`, `manage_products`

Admin-only areas include supervisor management, settings, currencies, audit logs, role changes, password resets, user currency changes, and some wallet operations.

## Upload Handling

The active upload root is `uploads/` at the repository root. Express serves it at `/uploads`. Multer writes category folders such as:

- `uploads/avatars`
- `uploads/products`
- `uploads/categories`
- `uploads/payments`
- `uploads/deposits`

The copied `Project/uploads` tree is not an active upload root and is ignored for the clean base.

## Background Jobs

- Order fulfillment/status polling job starts from `src/modules/orders/fulfillmentJob.js`.
- Provider catalog sync job starts from `src/modules/providers/syncProvidersJob.js`.
- Exchange-rate sync service/job exists and is environment-configurable.

Jobs skip startup work in `NODE_ENV=test` where implemented.

## Audit Logs

Audit logs record actor, action, entity, metadata, IP, and user agent. The audit service redacts sensitive keys such as passwords, tokens, secrets, API keys, and card-like fields before saving.

## Known Limitations

- Provider and customer API tokens are plaintext.
- No refresh-token, logout, or token revocation model exists.
- Permissions have no central whitelist or data scoping.
- Some legacy permission aliases remain for provider list compatibility.
- Local disk uploads are not suitable for multi-instance production without shared storage.
- Existing provider adapters are legacy/sample until confirmed for the new platform.
- Real card gateways, payment webhooks, referral reversal, group-based referral rates, frontend compatibility aliases, and advanced sub-agent hierarchy/profile features are intentionally not implemented in the current baseline.
