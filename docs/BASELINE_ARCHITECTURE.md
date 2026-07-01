# Baseline Architecture

## Current Architecture

The backend is a modular Express monolith. `src/app.js` builds the Express app, installs security, CORS, parsing, static uploads, rate limits, and route modules. `src/server.js` connects MongoDB, starts HTTP, and starts background jobs outside test mode.

MongoDB access is through Mongoose models inside each module. Controllers stay thin, services hold business rules, and shared middleware handles authentication, authorization, validation, uploads, and error handling.

## Modules

- `auth`: registration, login, email verification, 2FA, optional Google OAuth.
- `users`: admin and self-service user profile/account actions.
- `me`: active-user panel for profile, preferred currency, wallet, products, orders, and deposits.
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

Customers can update their own preferred currency with `PATCH /api/me/currency`. The endpoint accepts `{ "currency": "EGP" }`, requires an authenticated active user, validates the code against active currencies, and updates only `User.currency`. Wallet balances, wallet ledger entries, orders, deposits, payments, pricing groups, and referral data are not recalculated by this self-service endpoint.

Customers can update their own password with `PATCH /api/me/password`. The endpoint accepts `{ "currentPassword": "...", "newPassword": "..." }`, requires an authenticated active user, verifies the current password against the stored hash, validates the new password against the registration strength rule, and saves only the newly hashed password. The response does not include password data or hashes.

## Provider Architecture

Provider records store `name`, `slug`, `baseUrl`, encrypted `apiToken`/`apiKey`, active state, sync interval, and supported features. Provider credentials are encrypted at rest with AES-256-GCM using `PROVIDER_CREDENTIALS_KEY` and stored as `enc:v1:<iv>:<tag>:<ciphertext>`. API responses expose safe credential-status booleans only, never raw or encrypted credential values.

Provider adapters decrypt credentials internally when making server-side provider calls. Legacy plaintext provider credentials are supported only for backward-compatible internal use while the idempotent `npm run migrate:provider-credentials` script is used to encrypt existing records. No provider is seeded by default, and real provider credentials must never be committed.

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

- Customer API tokens are plaintext.
- No refresh-token, logout, or token revocation model exists.
- Permissions have no central whitelist or data scoping.
- Some legacy permission aliases remain for provider list compatibility.
- Local disk uploads are not suitable for multi-instance production without shared storage.
- Existing provider adapters are legacy/sample until confirmed for the new platform.
- Real card gateways, payment webhooks, referral reversal, group-based referral rates, frontend compatibility aliases, and advanced sub-agent hierarchy/profile features are intentionally not implemented in the current baseline.
