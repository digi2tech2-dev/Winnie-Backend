# Backend Technical Reference

This README documents the backend implementation as it exists in this repository. It was written from the current codebase, not from generic MERN assumptions. The backend is a Node.js/Express API for a digital products and top-up platform with customer wallets, admin-managed pricing, provider catalog sync, provider fulfillment, audit logs, notifications, and a supervisor permission system.

Existing documents are available under `docs/`, but several are stale compared with the current code. Treat this README and the source files as the current reference.

---

## 1. Project Overview

### What This Backend Does

The backend manages a digital products marketplace where customers can:

- Register and verify email.
- Wait for admin approval before account activation.
- Browse active products and categories.
- Maintain a wallet in their selected currency.
- Submit wallet deposit requests with receipt uploads.
- Place manual or automatic orders.
- Track orders, deposits, wallet transactions, and notifications.

Admins and supervisors can operate the back office:

- Approve/reject users.
- Manage users, wallets, groups, products, categories, providers, deposits, settings, currencies, and orders.
- Sync provider catalogs into internal `ProviderProduct` records.
- Publish curated platform `Product` records from synced provider products.
- Review provider status and manually retry, refund, or complete orders.
- Use audit logs for traceability.

### Main Business Idea

The platform acts as a reseller layer between customers and external digital-product providers. External providers expose raw catalogs and order APIs. This backend stores those raw catalogs separately, lets admins curate products, applies group-based markup and currency conversion, charges the customer's wallet, and optionally dispatches the order to the provider.

### Main User Roles

| Role | Stored As | Purpose |
|---|---|---|
| `ADMIN` | `User.role` | Full back-office access. Bypasses permission checks. Can manage supervisors and sensitive settings. |
| `SUPERVISOR` | `User.role` plus `User.permissions[]` | Restricted back-office operator. Must have explicit permission keys for most `/api/admin` features. |
| `CUSTOMER` | `User.role` | End user/customer. Can use `/api/me`, `/api/orders`, wallet/deposit endpoints, and client API if enabled. |
| External provider | `Provider` model, not a login role | Third-party supplier configuration with `baseUrl`, `apiToken`, slug, and sync/fulfillment behavior. |
| API client | Customer with `isApiEnabled` and `apiToken` | Uses `/api/client/*` with `api-token` header. This is not a separate role. |

### Main Modules / Features

- Authentication: email/password, Google OAuth if configured, email verification, admin approval, JWT, optional email OTP 2FA.
- RBAC: admin/supervisor role checks and per-supervisor permission strings.
- Users: profile, avatar, API token, approval/rejection, soft-delete/restore, currency and credit limit management.
- Groups: pricing tiers using percentage markup.
- Products/catalog: curated products, categories, dynamic order fields, provider mapping, sync pricing.
- Providers: Royal Crown, Torosfon, Alkasr/Miral VIP, mock adapter, provider-product sync.
- Orders: wallet debit, immutable pricing snapshots, idempotency, provider dispatch, polling, refunds.
- Wallet: direct admin adjustments, order debits/refunds, deposit credits, transaction history.
- Deposits: customer top-up requests with receipt uploads and admin review.
- Currencies: platform exchange rates, currency conversion, optional market-rate sync service.
- Notifications: user/admin notifications with unread counts and read/delete operations.
- Audit logs: immutable event records for users, orders, wallet, deposits, providers, products, categories, settings, and admin actions.
- Background jobs: provider catalog sync and order fulfillment polling via `node-cron`.

### Current Architecture Style

This is a modular Express monolith:

- `src/app.js` builds the Express app and mounts routers.
- `src/server.js` connects MongoDB, starts HTTP, and starts selected cron jobs.
- Each business area lives under `src/modules/<module>`.
- Controllers are mostly thin HTTP adapters.
- Services contain business logic and database operations.
- Models are Mongoose schemas.
- Middleware handles authentication, authorization, rate limiting, validation, uploads, and errors.
- External providers are adapter classes resolved through an adapter factory.
- There is no Redis, BullMQ, Kafka, or separate worker service. Background work is in-process cron.

---

## 2. Tech Stack

| Area | Implementation |
|---|---|
| Runtime | Node.js. No `engines` field is defined in `package.json`; Node 18+ is recommended because the code uses modern Node APIs and current dependency versions. |
| HTTP framework | Express `^4.21.2` |
| Database | MongoDB through Mongoose `^8.10.1` |
| Authentication | JWT via `jsonwebtoken`, password hashing via `bcryptjs`, Google OAuth via `passport-google-oauth20` when configured |
| Authorization | Custom role and permission middleware in `src/shared/middlewares/authorize.js` |
| Validation | `express-validator` for many public/module routes; Joi for admin and category routes |
| File upload/storage | Multer disk storage under `Backend/uploads`, served publicly at `/uploads` |
| Email | Nodemailer SMTP for email verification and 2FA OTP emails |
| External HTTP | Axios for provider APIs; Node `http`/`https` for exchange-rate sync |
| Logging | Morgan HTTP logger outside test; `console.*` for jobs/services |
| Error handling | Custom `AppError` classes plus global error middleware |
| Security middleware | Helmet, CORS, express-rate-limit |
| Jobs | `node-cron` in-process cron jobs |
| Caching | In-memory provider price cache and currency converter cache |
| Tests | Jest, mongodb-memory-server |
| Process manager config | `ecosystem.config.js` for PM2 cluster mode |

---

## 3. Folder Structure

```text
Backend/
  src/
    app.js
    server.js
    config/
    jobs/
    modules/
      admin/
      audit/
      auth/
      categories/
      client/
      currency/
      deposits/
      groups/
      me/
      notifications/
      orders/
      products/
      providers/
      users/
      wallet/
    scripts/
    services/
    shared/
      errors/
      middlewares/
      routes/
      utils/
    tests/
  docs/
  uploads/
  Project/uploads/
  package.json
  jest.config.js
  ecosystem.config.js
  postman_collection.json
  fix_wallet_transactions.js
```

### Root Files

| Path | Purpose |
|---|---|
| `package.json` | Scripts and dependency versions. |
| `package-lock.json` | Locked dependency tree. |
| `.env.example` | Example environment variables. Some provider variables in this file are not referenced by the current adapter factory. |
| `jest.config.js` | Jest config, test patterns, global setup/teardown for mongodb-memory-server. |
| `ecosystem.config.js` | PM2 cluster configuration for production deployment. |
| `postman_collection.json` | API collection, not inspected as source of behavior. |
| `fix_wallet_transactions.js` | One-off utility to link old `DEBIT` wallet transactions to matching orders by timestamp. Run manually only after review. |

### `src/config`

| File | Purpose |
|---|---|
| `config.js` | Central runtime config. Requires `MONGO_URI` and `JWT_SECRET`. Defines JWT, bcrypt, Google, SMTP, frontend, and CORS defaults. |
| `database.js` | Connects Mongoose to MongoDB and logs connection lifecycle events. |
| `google.strategy.js` | Passport Google OAuth strategy. Links by `googleId` or email; creates pending verified customers if new. |

### `src/modules`

Each module generally contains routes, controllers, services, models, and validation files for one bounded area.

| Module | Purpose |
|---|---|
| `admin` | Back-office routes, supervisor/RBAC permissions, user management, wallets, orders, providers, catalog, settings, dashboard stats. |
| `audit` | Immutable audit log model, constants, service, and read endpoints. |
| `auth` | Registration, login, email verification, resend verification, Google OAuth, 2FA OTP flow. |
| `categories` | Category CRUD and validation. Public active category listing is mounted inline in `app.js`. |
| `client` | Token-based API for customers using `api-token` header. |
| `currency` | Currency model, admin currency service/routes, active public currency list. |
| `deposits` | Deposit request model, upload flow, admin approval/rejection. |
| `groups` | Pricing group model and admin group operations. |
| `me` | Authenticated user panel endpoints for profile, wallet, products, orders, deposits. |
| `notifications` | Notification model, service, routes for user notifications and admin broadcast/create. |
| `orders` | Order model, pricing, dynamic-field validation, fulfillment, polling, route handlers. |
| `products` | Curated product model and product service/routes. |
| `providers` | Provider and ProviderProduct models, adapters, provider-product sync job. |
| `users` | User model and profile/admin user endpoints. |
| `wallet` | Wallet transaction model, wallet atomic debit/refund/credit service, wallet endpoints. |

### `src/shared`

| Folder/File | Purpose |
|---|---|
| `shared/errors/AppError.js` | Error class hierarchy: `AppError`, validation/auth/not-found/conflict/business-rule errors. |
| `shared/errors/errorHandler.js` | Global Express error handler; maps Mongoose/JWT errors. |
| `shared/middlewares/authenticate.js` | Bearer JWT auth; loads active user and sets `req.user`/`req.auditContext`. |
| `shared/middlewares/authorize.js` | Role and permission guards. |
| `shared/middlewares/apiAuth.js` | `api-token` auth for `/api/client`. |
| `shared/middlewares/rateLimiter.js` | General, auth, and wallet rate limiters. |
| `shared/middlewares/upload.js` | Multer disk upload setup. |
| `shared/middlewares/validate.js` | Express-validator result handler. |
| `shared/routes/upload.routes.js` | Generic admin image upload route under `/api/upload/:category`. |
| `shared/utils/apiResponse.js` | Standard success/created/paginated response helpers. |
| `shared/utils/catchAsync.js` | Async controller wrapper. |
| `shared/utils/currencyMath.js` | Basic balance/currency math helpers. |
| `shared/utils/decimalPrecision.js` | Decimal.js helpers for high-precision price strings. |

### `src/services`

| File | Purpose |
|---|---|
| `currencyConverter.service.js` | Uses active `Currency.platformRate` with a 60-second in-memory cache. |
| `email.service.js` | SMTP transport and verification/2FA email senders. Test mode no-ops. |
| `exchangeRateSync.service.js` | Pulls market exchange rates and updates `Currency.marketRate`; not automatically started by `server.js`. |

### Jobs / Queues

There is no external queue system. The jobs are in-process cron tasks.

| File | Status |
|---|---|
| `src/modules/orders/fulfillmentJob.js` | Started by `server.js`. Default schedule `*/5 * * * *` (every 5 minutes). Polls `PROCESSING` automatic orders. |
| `src/modules/providers/syncProvidersJob.js` | Started by `server.js`. Default schedule `0 0,6,12,18 * * *` (every 6 hours). Syncs active provider catalogs. |
| `src/modules/orders/orderPolling.job.js` | Exists but is not started by `server.js`. More configurable polling service. |
| `src/jobs/exchangeRateSync.job.js` | Exists but is not started by `server.js`. Syncs market exchange rates if manually started. |

### Uploads / Public Files

Files are stored under `Backend/uploads` and served by Express at `/uploads`.

| Directory | Use |
|---|---|
| `uploads/avatars` | User/admin avatar uploads. |
| `uploads/products` | Product images. |
| `uploads/categories` | Category images. |
| `uploads/payments` | Payment method images. |
| `uploads/deposits` | Deposit receipt images/PDFs. |
| `Project/uploads/deposits` | Present in the repo tree, but the active Express static mount points to `Backend/uploads`, not `Backend/Project/uploads`. Needs verification before use. |

### Tests

Tests live under `src/tests`. Jest uses `mongodb-memory-server` through `src/tests/globalSetup.js` and `src/tests/globalTeardown.js`.

Observed test files include auth, activation, admin, audit, adapters, catalog, currency, deposit, fulfillment, group, order, order fields, order polling, pricing, provider, and sync-upgrade tests.

---

## 4. Setup & Installation

### Prerequisites

- Node.js 18+ recommended.
- npm.
- MongoDB. Use a replica set for code paths that use Mongoose sessions/transactions, especially order creation.
- SMTP credentials if email verification/2FA emails should actually send.
- Provider credentials stored in the `Provider` collection for live integrations.

### Install Dependencies

```bash
npm install
```

### Create Environment File

```bash
cp .env.example .env
```

Then set at minimum:

```env
MONGO_URI=mongodb://localhost:27017/digital_products_platform
JWT_SECRET=replace-with-a-long-random-secret
```

### Run Development Server

```bash
npm run dev
```

This runs `nodemon src/server.js`.

### Run Production Server

```bash
npm start
```

This runs `node src/server.js`.

For PM2:

```bash
pm2 start ecosystem.config.js --env production
```

Production startup requires `ALLOWED_ORIGINS`; `app.js` refuses open CORS when `NODE_ENV=production`.

### Run Tests

```bash
npm test
```

The test environment uses `mongodb-memory-server` and injects `MONGO_TEST_URI`, `MONGO_URI`, `JWT_SECRET`, `JWT_EXPIRES_IN`, and low bcrypt rounds in `src/tests/globalSetup.js`.

### Seed Data

```bash
npm run seed
```

The seeder creates:

- `Standard` group with `percentage: 0`.
- `Premium` group with `percentage: 15`.
- Admin user: `admin@platform.com` / `Admin@1234`.
- Customer user: `customer@platform.com` / `Customer@1234`.
- Three sample products.

Clear seeded collections:

```bash
npm run seed:clear
```

`seed:clear` deletes users, groups, products, orders, and wallet transactions.

### Common Startup Problems

| Symptom | Likely Cause | Fix |
|---|---|---|
| App exits with missing env error | `MONGO_URI` or `JWT_SECRET` missing | Add them to `.env`. |
| Production boot throws CORS security error | `NODE_ENV=production` without `ALLOWED_ORIGINS` | Set comma-separated origins, for example `https://admin.example.com,https://app.example.com`. |
| Order creation transaction fails | MongoDB not running as a replica set | Use a replica set or adjust transaction-dependent code after careful review. |
| Email verification links do not send | SMTP env vars not configured or SMTP rejected | Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`; check logs. |
| Google OAuth route returns unavailable | Google credentials missing | Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. |
| Uploaded files not visible | Looking under wrong upload folder or file permissions | Active path is `Backend/uploads`, served at `/uploads`. |
| Provider calls use mock adapter unexpectedly | Provider slug/name not registered in adapter factory or missing DB credentials | Check `Provider.slug`, `Provider.name`, `baseUrl`, `apiToken`, and `adapter.factory.js`. |

---

## 5. Environment Variables

| Variable | Required | Example | Purpose | Used In |
|---|---:|---|---|---|
| `NODE_ENV` | Optional | `development` | Runtime mode. Affects CORS, logging, jobs, tests. | `config.js`, `app.js`, jobs |
| `PORT` | Optional | `5000` | HTTP port. Defaults to `5000` in config. | `config.js`, `server.js` |
| `MONGO_URI` | Required | `mongodb://localhost:27017/digital_products_platform` | MongoDB connection string. | `config.js`, `database.js`, seed/fix scripts |
| `JWT_SECRET` | Required | `a-long-random-secret` | JWT signing secret. | `config.js`, auth middleware/services |
| `JWT_EXPIRES_IN` | Optional | `7d` | Normal login token lifetime. | `config.js`, auth service |
| `BCRYPT_ROUNDS` | Optional | `12` | Password hash rounds. | `config.js`, user model |
| `GOOGLE_CLIENT_ID` | Optional | `123.apps.googleusercontent.com` | Enables Google OAuth when paired with secret. | `config.js`, `google.strategy.js`, auth routes |
| `GOOGLE_CLIENT_SECRET` | Optional | `google-secret` | Enables Google OAuth. | `config.js`, `google.strategy.js`, auth routes |
| `GOOGLE_CALLBACK_URL` | Optional | `http://localhost:5000/api/auth/google/callback` | OAuth callback URL. Defaults from port. | `config.js`, Google strategy |
| `SMTP_HOST` | Optional | `smtp.mailtrap.io` | SMTP host. Defaults to Mailtrap host. | `config.js`, email service |
| `SMTP_PORT` | Optional | `587` | SMTP port. | `config.js`, email service |
| `SMTP_USER` | Optional | `smtp-user` | SMTP username. Required for real email sending. | `config.js`, email service |
| `SMTP_PASS` | Optional | `smtp-pass` | SMTP password. Required for real email sending. | `config.js`, email service |
| `EMAIL_FROM` | Optional | `noreply@platform.com` | Sender address. | `config.js`, email service |
| `APP_URL` | Optional | `http://localhost:5000` | Backend public base URL used in verification links. | `config.js`, auth/email services |
| `FRONTEND_URL` | Optional | `http://localhost:3000` | Frontend base URL for OAuth redirects/default verify redirect. | `config.js`, auth controller |
| `FRONTEND_VERIFY_REDIRECT_URL` | Optional | `http://localhost:3000/email-verified` | Email verification redirect target. | `config.js`, auth controller |
| `ALLOWED_ORIGINS` | Required in production | `https://app.example.com,https://admin.example.com` | CORS allowlist. Development/test allow `*`. | `app.js`, `config.js` |
| `EXCHANGE_RATE_API_URL` | Optional | `https://api.exchangerate.host/latest?base=USD` | Market-rate feed URL. | `exchangeRateSync.service.js` |
| `EXCHANGE_RATE_API_KEY` | Optional | `key` | Appended as `access_key` to exchange-rate URL when set. | `exchangeRateSync.service.js` |
| `EXCHANGE_RATE_TIMEOUT_MS` | Optional | `10000` | HTTP timeout for exchange-rate sync. | `exchangeRateSync.service.js` |
| `POLL_BATCH_LIMIT` | Optional | `100` | Batch limit for `orderPolling.service.js`. This service exists but is not started by `server.js`. | `orderPolling.service.js` |
| `POLL_MAX_BATCH_SIZE` | Optional | `50` | Provider batch size for optional order polling service. | `orderPolling.service.js` |
| `POLL_MAX_CONCURRENT` | Optional | `3` | Max concurrent providers in optional order polling service. | `orderPolling.service.js` |
| `POLL_INTER_BATCH_DELAY_MS` | Optional | `0` | Delay between batches in optional order polling service. | `orderPolling.service.js` |
| `PROVIDER_PRICE_CACHE_TTL_MS` | Optional | `300000` | TTL for live provider price cache. | `providerPriceCache.js` |
| `SYNC_UPSERT_CONCURRENCY` | Optional | `10` | Concurrency for provider product upserts during sync. | `providerProductSync.service.js` |
| `PROVIDER_BASE_URL` | Optional legacy | `https://royal-croown.com` | Legacy Royal Crown shim fallback. Not used by current provider factory. | `royalCrownProvider.js` |
| `PROVIDER_API_TOKEN` | Optional legacy | `token` | Legacy Royal Crown shim fallback. Not used by current provider factory. | `royalCrownProvider.js` |
| `MONGO_TEST_URI` | Test-only | generated URI | Set by Jest global setup. | `src/tests/testHelpers.js` |
| `ROYAL_CROWN_API_URL` | Not currently used | `https://royal-croown.com` | Present in `.env.example`, but current adapters use DB `Provider.baseUrl`. | `.env.example` only |
| `ROYAL_CROWN_API_TOKEN` | Not currently used | `token` | Present in `.env.example`, but current adapters use DB `Provider.apiToken`. | `.env.example` only |
| `TOROSFON_API_URL` | Not currently used | `https://torosfon.com` | Present in `.env.example`, but current adapters use DB provider config. | `.env.example` only |
| `TOROSFON_API_TOKEN` | Not currently used | `token` | Present in `.env.example`, but current adapters use DB provider config. | `.env.example` only |
| `ALKASR_API_URL` | Not currently used | `https://alkasr-vip.com` | Present in `.env.example`, but current adapters use DB provider config. | `.env.example` only |
| `ALKASR_API_TOKEN` | Not currently used | `token` | Present in `.env.example`, but current adapters use DB provider config. | `.env.example` only |

---

## 6. Database Models / Schemas

All important schemas are Mongoose models. Most include `timestamps: true`; exceptions are noted.

### User

| Item | Detail |
|---|---|
| Path | `src/modules/users/user.model.js` |
| Purpose | Login accounts for admins, supervisors, and customers. Stores wallet, group, approval, 2FA, API-token, and RBAC data. |
| Required fields | `name`, `email`, `groupId`; `password` is not required for OAuth users. |
| Roles | `ADMIN`, `SUPERVISOR`, `CUSTOMER` |
| Status enum | `PENDING`, `ACTIVE`, `REJECTED` |
| Important fields | `password` select false, `googleId`, `verified`, verification token fields, 2FA OTP/temp token fields, `role`, `permissions[]`, `status`, `isApiEnabled`, `apiToken` select false, `groupId`, `walletBalance`, `creditLimit`, `creditUsed`, `currency`, `avatar`, `deletedAt`. |
| Relations | `groupId`, `approvedBy`, `rejectedBy` reference `User`/`Group`. |
| Indexes/unique | Unique `email`; unique sparse `googleId`; indexed `apiToken`, `role`, `permissions`, `groupId`, `status`, sparse `deletedAt`. |
| Timestamps | `createdAt`, `updatedAt`. |
| Business rules | Passwords hash on save. `toSafeObject()` removes sensitive fields. `authenticate` only allows `status === ACTIVE` for protected routes. New registrations are `CUSTOMER`, `PENDING`, assigned the active group with highest percentage. |

### Group

| Item | Detail |
|---|---|
| Path | `src/modules/groups/group.model.js` |
| Purpose | Pricing tier. Group `percentage` is applied as customer markup over product base price. |
| Fields | `name` required unique, `percentage` required min 0, `isActive` default true, `deletedAt`. |
| Relations | Referenced by `User.groupId` and `Order.groupIdSnapshot`. |
| Indexes | Unique `name`, `percentage: -1`. |
| Timestamps | Yes. |
| Business rules | Registration requires at least one active group. Group changes affect future orders only; existing orders keep snapshots. |

### Category

| Item | Detail |
|---|---|
| Path | `src/modules/categories/category.model.js` |
| Purpose | Product grouping/display for admin and public catalog. Supports parent-child categories. |
| Fields | `name` required, `nameAr`, `image`, `slug`, `sortOrder`, `isActive`, `parentCategory`. |
| Relations | Self-reference through `parentCategory`; products store category as string/id-like value. |
| Indexes | `isActive + sortOrder`, `slug`, `parentCategory + isActive + sortOrder`. |
| Timestamps | Yes. |
| Business rules | Slug auto-generates from `name` if missing. Deleting a category hard-deletes it and clears matching product `category` fields. |

### Currency

| Item | Detail |
|---|---|
| Path | `src/modules/currency/currency.model.js` |
| Purpose | Platform exchange rates. Products are priced in USD; user wallets/orders may be in local currency. |
| Required fields | `code`, `name`, `symbol`, `platformRate`. |
| Fields | `code` unique uppercase 3 letters, `marketRate`, `platformRate`, `markupPercentage`, `isActive`, `lastUpdatedAt`. |
| Indexes | Unique `code`, `isActive`. |
| Timestamps | Yes. |
| Business rules | USD platform rate must remain `1`; USD cannot be disabled. Updating rates invalidates converter cache. Optional debt adjustment can adjust negative wallet balances. |

### Provider

| Item | Detail |
|---|---|
| Path | `src/modules/providers/provider.model.js` |
| Purpose | External supplier configuration. |
| Required fields | `name`, `baseUrl`. |
| Fields | `name`, `slug`, `baseUrl`, `apiToken`, `apiKey`, `isActive`, `syncInterval`, `supportedFeatures[]`, `deletedAt`. |
| Virtuals | `effectiveToken = apiToken || apiKey || null`. |
| Indexes | Unique `name`; sparse unique `slug`; `isActive`. |
| Timestamps | Yes. |
| Business rules | Slug auto-generates from name. Provider tokens are stored in plaintext. Soft delete uses `deletedAt` and `isActive: false`. |

### ProviderProduct

| Item | Detail |
|---|---|
| Path | `src/modules/providers/providerProduct.model.js` |
| Purpose | Raw provider catalog item synced from supplier APIs. Not customer-facing. |
| Required fields | `provider`, `externalProductId`, `rawName`, `rawPrice`. |
| Fields | `translatedName`, `minQty`, `maxQty`, `isActive`, `lastSyncedAt`, `rawPayload`. |
| Relations | `provider` references `Provider`. Linked by `Product.providerProduct`. |
| Indexes | Unique `(provider, externalProductId)`, provider/active and last-synced indexes. |
| Timestamps | Yes, version key disabled. |
| Business rules | Sync preserves `translatedName`. Missing products are deactivated only when provider returns a non-empty catalog. |

### Product

| Item | Detail |
|---|---|
| Path | `src/modules/products/product.model.js` |
| Purpose | Admin-curated product sold to customers. Can be standalone or linked to provider catalog. |
| Required fields | `name`, `minQty`, `maxQty`, `basePrice`. |
| Enums | `pricingMode: manual/sync`, `markupType: percentage/fixed`, `executionType: manual/automatic`, dynamic field types: `text`, `textarea`, `number`, `select`, `url`, `email`, `tel`, `date`. |
| Fields | `description`, `image`, `category`, `displayOrder`, `basePrice`, `providerPrice`, `markupType`, `markupValue`, `finalPrice`, `pricingMode`, `syncPriceWithProvider`, `enableManualPrice`, `manualPriceAdjustment`, `isActive`, `isAvailableForApi`, `deletedAt`, `executionType`, `provider`, `providerProduct`, `createdBy`, `orderFields[]`, `dynamicFields[]`, `providerMapping`. |
| Relations | `provider`, `providerProduct`, `createdBy`. |
| Indexes | `name`, `isActive`, `isActive + isAvailableForApi`, `provider + isActive`, `providerProduct`, `pricingMode + provider`, `isActive + displayOrder`, sparse `deletedAt`. |
| Timestamps | Yes. |
| Business rules | Dynamic field names must be unique; select fields need active options; min/max bounds validated. Product list for customers strips sensitive provider/pricing configuration. |

### Order

| Item | Detail |
|---|---|
| Path | `src/modules/orders/order.model.js` |
| Purpose | Customer purchase and fulfillment record with immutable pricing/customer-input snapshots. |
| Required fields | `userId`, `productId`, `quantity`, price snapshots, wallet deduction snapshots, `groupIdSnapshot`. |
| Status enum | `PENDING`, `PROCESSING`, `COMPLETED`, `CANCELED`, `PARTIAL`, `FAILED`, `MANUAL_REVIEW`. |
| Execution enum | `manual`, `automatic`. |
| Fields | `orderNumber`, `idempotencyKey`, `unitPrice`, `totalPrice`, `basePriceSnapshot`, `markupPercentageSnapshot`, `finalPriceCharged`, `walletDeducted`, `creditUsedAmount`, `currency`, `rateSnapshot`, `usdAmount`, `chargedAmount`, provider code/order/status/raw response, `retryCount`, `lastCheckedAt`, refund flags, `remains`, `customerInput`. |
| Relations | `userId`, `productId`, `groupIdSnapshot`. |
| Indexes | `userId + createdAt`, `status`, `groupIdSnapshot`, unique sparse `userId + idempotencyKey`, provider polling index. |
| Timestamps | Yes. |
| Business rules | Order creation debits wallet and creates order in a transaction. `Counter` provides sequential `orderNumber`. Automatic orders dispatch after commit. Refunds use exact wallet snapshots. |

### Counter

| Item | Detail |
|---|---|
| Path | `src/modules/orders/counter.model.js` |
| Purpose | Sequential counters, currently for order numbers. |
| Fields | `_id` string counter name, `seq` number. |
| Business rules | `getNextSequence(name, startAt = 9999, session)` initializes then increments atomically. |

### WalletTransaction

| Item | Detail |
|---|---|
| Path | `src/modules/wallet/walletTransaction.model.js` |
| Purpose | Immutable record of wallet balance changes. |
| Required fields | `userId`, `type`, `amount`, `balanceBefore`, `balanceAfter`. |
| Type enum | `CREDIT`, `DEBIT`, `REFUND`, `DEBT_ADJUSTMENT`. |
| Status enum | `PENDING`, `COMPLETED`, `FAILED`. |
| Fields | `reference` ref `Order`, `description`. |
| Indexes | `userId + createdAt`, `reference`. |
| Timestamps | Yes. |
| Business rules | Wallet service writes completed transaction records for order debits, refunds, deposits, and admin adjustments. |

### DepositRequest

| Item | Detail |
|---|---|
| Path | `src/modules/deposits/deposit.model.js` |
| Purpose | Customer wallet top-up request with uploaded receipt and admin review. |
| Required fields | `userId`, `paymentMethodId`, `requestedAmount`, `currency`, `exchangeRate`, `amountUsd`, `receiptImage`. |
| Status enum | `PENDING`, `APPROVED`, `REJECTED`. |
| Fields | `notes`, `adminNotes`, `reviewedBy`, `reviewedAt`. |
| Relations | `userId`, `reviewedBy`. |
| Indexes | `status + createdAt`, `userId + createdAt`. |
| Timestamps | Yes, version key disabled. |
| Business rules | A user may have only one pending deposit. Approval compare-and-swaps from `PENDING`, can apply admin amount/currency overrides, converts to user's wallet currency when needed, then credits wallet. |

### Notification

| Item | Detail |
|---|---|
| Path | `src/modules/notifications/notification.model.js` |
| Purpose | User/admin notification feed. |
| Required fields | `userId`, `title`, `message`. |
| Type enum | `system`, `deposit`, `order`, `wallet`, `account`, `admin`. |
| Priority enum | `low`, `normal`, `high`. |
| Fields | `isRead`, `readAt`, `route`, `entityType`, `entityId`, `metadata`. |
| Indexes | `userId + createdAt`, `userId + isRead + createdAt`, `type + createdAt`. |
| Timestamps | Yes. |
| Business rules | `readAt` is set when `isRead` becomes true. Admin actor notifications include active admins and supervisors with required permissions. |

### Setting

| Item | Detail |
|---|---|
| Path | `src/modules/admin/setting.model.js` |
| Purpose | Runtime key/value settings, including payment configuration. |
| Required fields | `key`, `value`. |
| Fields | `description`, `updatedBy`. |
| Defaults | `orderTimeoutMinutes`, `providerRetryLimit`, `maintenanceMode`, `maxWalletAdjustment`, `defaultPaginationLimit`, `paymentGroups`, `paymentCountryAccounts`, `paymentInstructions`, `whatsappNumber`. |
| Timestamps | Yes. |
| Business rules | `seedDefaultSettings()` is called at app startup and only inserts missing defaults. Mixed `value` fields are marked modified on update. |

### AuditLog

| Item | Detail |
|---|---|
| Path | `src/modules/audit/audit.model.js` |
| Purpose | Immutable audit event store. |
| Required fields | `actorId`, `actorRole`, `action`, `entityType`. |
| Actor roles | `ADMIN`, `SUPERVISOR`, `CUSTOMER`, `SYSTEM`. |
| Entity types | `USER`, `ORDER`, `WALLET`, `GROUP`, `DEPOSIT`, `PROVIDER`, `PRODUCT`, `CATEGORY`, `SETTING`, `SYSTEM`. |
| Fields | `entityId`, `metadata`, `ipAddress`, `userAgent`. |
| Indexes | `entityType + entityId + createdAt`, `actorId + createdAt`, `action + createdAt`. |
| Timestamps | `createdAt` only, version key disabled. |
| Business rules | Pre-hooks throw on update/delete operations. Use `audit.constants.js` for valid actions. |

---

## 7. Authentication & Authorization

### Registration Flow

Endpoint: `POST /api/auth/register`

1. Request is rate limited by `authLimiter`.
2. `auth.validation.js` validates name/email/password and accepts optional `currency`, `country`, `phone`, `username`.
3. `auth.service.register()` rejects duplicate email and duplicate username.
4. The user is assigned the active `Group` with the highest `percentage`.
5. A SHA-256 hashed email verification token is stored with a 24-hour expiry.
6. A `CUSTOMER` user is created with `status: PENDING`, `verified: false`.
7. Password is hashed by the `User` model pre-save hook.
8. Verification email is sent fire-and-forget.
9. A pending-user admin notification and audit log are created.
10. No JWT is returned on registration.

Important note: validation accepts `country`, `phone`, and `username`, and services reference `username`, but the current `User` schema does not define these fields. With default Mongoose strict behavior, these fields may not persist. This needs verification before relying on them.

### Email Verification

Endpoint: `GET /api/auth/verify-email?token=<raw-token>`

- The raw token is hashed and matched against `emailVerificationToken`.
- Expired or invalid tokens are rejected.
- On success, `verified` becomes true and token fields are cleared.
- Controller redirects to `FRONTEND_VERIFY_REDIRECT_URL` with a `status` query.

Endpoint: `POST /api/auth/resend-verification`

- Uses generic response for missing accounts.
- Rejects already verified users with an already-verified response.
- Regenerates and emails a new token.

### Login Flow

Endpoint: `POST /api/auth/login`

1. Request is rate limited by `authLimiter`.
2. Email/password are validated.
3. User is loaded with password and 2FA fields.
4. Login is blocked if:
   - user does not exist,
   - email is not verified,
   - account is `PENDING` or `REJECTED`,
   - account uses Google only and has no password,
   - password does not match.
5. If 2FA is disabled, service returns a signed JWT and safe user object.
6. If 2FA is enabled, service sends an OTP email, stores hashed OTP/temp token, and returns `requires2FA`, `tempToken`, `requestId`, masked email, and expiry.

JWT payload includes at least:

```json
{ "id": "<userId>", "role": "ADMIN|SUPERVISOR|CUSTOMER" }
```

### 2FA Flow

| Endpoint | Auth | Behavior |
|---|---|---|
| `POST /api/auth/2fa/generate` | Bearer JWT | Issues an OTP challenge for the authenticated user. |
| `POST /api/auth/2fa/enable` | Bearer JWT | Enables 2FA after OTP validation. |
| `POST /api/auth/2fa/disable` | Bearer JWT | Disables 2FA after OTP validation. |
| `POST /api/auth/verify-2fa` | temp token body | Verifies pending OTP and returns the normal JWT. |

2FA pending tokens use JWT purpose `2fa-pending`; `authenticate.js` explicitly rejects them for normal protected routes.

### Google OAuth

Routes:

- `GET /api/auth/google`
- `GET /api/auth/google/callback`
- `GET /api/auth/google/failure`

Google OAuth is only initialized when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` exist.

Google strategy behavior:

- Link by existing `googleId`.
- If no `googleId`, link by email.
- If new email, create `CUSTOMER`, `PENDING`, `verified: true`, no password, assigned highest-percentage group.
- Active users receive JWT.
- Pending users redirect without a JWT and must be approved.
- Rejected users are blocked.

### Token / Session / Refresh / Logout

- The backend uses stateless JWT Bearer tokens.
- There is no refresh token model or refresh endpoint.
- There is no server-side logout/token blacklist endpoint.
- Logout is therefore client-side token deletion unless a future blacklist/session store is added.

### Auth Middleware

`src/shared/middlewares/authenticate.js`:

- Requires `Authorization: Bearer <token>`.
- Verifies token with `JWT_SECRET`.
- Rejects 2FA pending tokens.
- Loads `User` by decoded `id`.
- Rejects missing or non-`ACTIVE` users.
- Attaches `req.user`.
- Attaches `req.auditContext` with actor id, actor role, IP, and user-agent.

`src/shared/middlewares/requireActiveUser.js`:

- Requires `req.user.status === ACTIVE`.
- Some routes use it even though `authenticate` already enforces active users.

### Authorization Middleware

`src/shared/middlewares/authorize.js` exports:

- `authorizeRoles(...roles)` / default `authorize(...)`: role guard.
- `requirePermission(...permissions)`: admin bypass; supervisors must include every listed permission.
- `requireAnyPermission(...permissions)`: admin bypass; supervisors must include at least one listed permission.

Protected routes generally chain:

```js
router.use(authenticate);
router.use(authorizeRoles('ADMIN', 'SUPERVISOR'));
router.get('/orders', requirePermission('orders.view'), controller);
```

### Current User/Profile Endpoints

| Endpoint | Behavior |
|---|---|
| `GET /api/users/me` | Profile through users module. |
| `PATCH /api/users/me` | Self-service profile update. |
| `PATCH /api/users/me/avatar` | Avatar upload/update. |
| `PATCH /api/users/me/api-token` | Regenerates API token. |
| `GET /api/me` | User-panel profile with wallet/group summary. |

### Auth Error Cases

Common codes/messages are produced through custom errors:

- Missing/invalid token: `AUTHENTICATION_ERROR`, 401.
- Role/permission failure: `AUTHORIZATION_ERROR`, 403.
- Pending/rejected/inactive account: auth/business error depending on route.
- Invalid/expired JWT: mapped by global error handler.
- Validation failure: 400 or 422 depending on validator path.

---

## 8. Supervisors / Admin / RBAC System

This section is intentionally detailed because supervisor permissions are security-sensitive.

### What a Supervisor Is

A supervisor is a normal `User` document with:

```js
role: 'SUPERVISOR'
permissions: ['orders.view', 'topups.review', ...]
status: 'ACTIVE'
```

There is no separate `Supervisor` model or supervisor auth table. Supervisors log in through the same auth flow as admins and customers.

### Role Differences

| Actor | Storage | Login | Back-office access | Permission behavior |
|---|---|---|---|---|
| Main admin | `User.role = ADMIN` | Same `/api/auth/login` | Full `/api/admin` access where route allows admin | Bypasses `requirePermission` and `requireAnyPermission`. |
| Supervisor | `User.role = SUPERVISOR`, `permissions[]` | Same `/api/auth/login` | Only routes that allow `ADMIN`/`SUPERVISOR` and pass permission checks | Must have required permission strings. No bypass. |
| Customer | `User.role = CUSTOMER` | Same `/api/auth/login` | No `/api/admin` access | Uses customer/user-panel routes. |
| Provider | `Provider` document | No login | External supplier config only | Not part of RBAC. |
| API client | Customer with `apiToken` | `api-token` header on `/api/client` | Client API only | Not supervisor/admin RBAC. |

### Where Supervisors Are Stored

Model: `src/modules/users/user.model.js`

Important fields:

| Field | Type | Purpose |
|---|---|---|
| `role` | String enum | Must be `SUPERVISOR`. |
| `permissions` | `[String]` | Permission keys. Setter trims and deduplicates. |
| `status` | String enum | Must be `ACTIVE` to authenticate. |
| `verified` | Boolean | Login requires verified email unless admin sets active/verified. |
| `approvedBy`, `approvedAt` | User ref/date | Approval tracking. |
| `rejectedBy`, `rejectedAt` | User ref/date | Rejection tracking. |
| `deletedAt` | Date | Soft delete marker. |
| `groupId` | Group ref | Required by schema even for admins/supervisors. |
| `password` | String select false | Bcrypt-hashed if password login is used. |

There is no `createdBy` or `updatedBy` field on `User`. Supervisor permission/role changes are tracked through `AuditLog`.

### How Supervisors Are Created

Current code does not expose a dedicated "create supervisor" endpoint.

The implemented path is:

1. Create/register a user, or create one by other existing admin/user mechanisms.
2. Admin approves/activates the user if needed.
3. Admin changes role through:

```http
PATCH /api/admin/users/:id/role
Authorization: Bearer <admin-token>
Content-Type: application/json

{
  "role": "SUPERVISOR",
  "permissions": ["orders.view", "topups.review"]
}
```

Only `ADMIN` can call this route. Supervisors cannot create or promote other supervisors.

### Who Can Create / Modify Supervisors

Admin-only routes:

| Action | Endpoint | Guard |
|---|---|---|
| List supervisors | `GET /api/admin/supervisors` | `authorizeRoles('ADMIN')` |
| Update supervisor permissions | `PATCH /api/admin/supervisors/:id/permissions` | `authorizeRoles('ADMIN')` |
| Change any user's role | `PATCH /api/admin/users/:id/role` | `authorizeRoles('ADMIN')` |
| General admin user patch | `PATCH /api/admin/users/:id` | `authorizeRoles('ADMIN')` |
| Reset password | `POST /api/admin/users/:id/reset-password` | `authorizeRoles('ADMIN')` |
| Update user currency/credit/avatar | various | `authorizeRoles('ADMIN')` |

### Supervisor Login

Supervisors use exactly the same login endpoint:

```http
POST /api/auth/login
```

Requirements:

- Email verified.
- `status === ACTIVE`.
- Password matches or Google account is linked/active.
- If 2FA enabled, OTP verification must complete.

The returned JWT has `role: SUPERVISOR`. No separate session/token type exists.

### Permission Representation

Permissions are plain strings stored in `User.permissions`.

Example:

```json
{
  "role": "SUPERVISOR",
  "permissions": [
    "dashboard.view",
    "orders.view",
    "orders.update",
    "topups.review"
  ]
}
```

Important implementation notes:

- `User.permissions` setter only trims and deduplicates. It does not validate against a central whitelist.
- Admin Joi validation requires dot notation such as `orders.view`.
- Legacy route aliases `manage_providers` and `manage_products` are accepted by one route guard but do not match the Joi dot-notation validation if assigned through current supervisor permission endpoints.

### Permission Keys Found in Code

| Permission | Where Used | Allows |
|---|---|---|
| `dashboard.view` | `/api/admin/dashboard/stats`, `/api/admin/stats` | View dashboard metrics. |
| `users.view` | `/api/admin/users`, `/api/admin/users/:id` | List and view users. |
| `users.delete` | `DELETE /api/admin/users/:id` | Soft-delete non-admin users. |
| `users.status` | user approve/reject/restore routes | Approve, reject, restore users. |
| `wallet.view` | admin wallet routes | List wallets and view wallet transaction history. |
| `wallet.adjust` | admin wallet/debt adjustment routes | Add, deduct, set balances, adjust debt. |
| `suppliers.manage` | provider management and provider catalog sync routes | Manage suppliers/providers, sync catalogs, check balances/products/prices/orders. |
| `products.view` | admin products/categories read routes | View products and categories. |
| `products.manage` | admin product/category mutation routes | Create/update/delete/toggle products and categories, publish provider products. |
| `orders.view` | admin order list/detail routes | View orders. |
| `orders.update` | retry/sync/complete/status routes | Retry, sync status, manually complete, change processing status. |
| `orders.refund` | refund route | Refund orders. |
| `groups.manage` | admin group routes | Create/update/delete groups. |
| `topups.review` | admin deposits routes | List, inspect, approve, reject, edit deposit requests. |
| `manage_providers` | provider list `requireAnyPermission` only | Legacy alias for viewing provider list. |
| `manage_products` | provider list `requireAnyPermission` only | Legacy alias for viewing provider list. |

No permission keys were found for settings, currencies, audit access, supervisor management, upload, user role changes, password resets, user currency changes, or user credit-limit changes. Those are admin-only.

### How Permissions Are Checked

File: `src/shared/middlewares/authorize.js`

Simplified behavior:

```js
requirePermission('orders.view')
```

- If `req.user.role === 'ADMIN'`, allow.
- If no permissions were passed, allow.
- Otherwise every required permission must exist in `req.user.permissions`.
- Missing permission throws 403.

```js
requireAnyPermission('suppliers.manage', 'products.manage')
```

- Admin always allowed.
- Supervisor needs at least one permission.

Routes first require the role:

```js
router.use(authenticate);
router.use(authorizeRoles('ADMIN', 'SUPERVISOR'));
```

Then specific routes require permissions.

### Example Protected Route

From `src/modules/admin/admin.routes.js`:

```js
router.get(
  '/orders',
  requirePermission('orders.view'),
  validateQuery(schemas.listOrdersQuery),
  ordersCtrl.listOrders
);
```

An active supervisor can call this only if `permissions` includes `orders.view`. An admin can call it without that permission.

### Supervisor CRUD / Lifecycle Endpoints

| Capability | Current Endpoint | Notes |
|---|---|---|
| Create supervisor | No dedicated endpoint | Promote an existing user with `PATCH /api/admin/users/:id/role`. |
| List supervisors | `GET /api/admin/supervisors` | Admin-only. Internally filters users by `role: SUPERVISOR`. |
| Update permissions | `PATCH /api/admin/supervisors/:id/permissions` | Admin-only. Target must be active/non-deleted supervisor. |
| Demote supervisor | `PATCH /api/admin/users/:id/role` | Admin-only. Moving away from `SUPERVISOR` clears permissions. |
| Activate/deactivate | `PATCH /api/admin/users/:id/approve`, `/reject`, `/restore`, `DELETE /api/admin/users/:id` | Permission-gated for some status/delete actions; role change and sensitive patch remain admin-only. |
| Block login | Set `status: REJECTED` or soft-delete | `authenticate` rejects non-active users. |
| Hard delete | Not implemented for users | `deleteUser` soft-deletes. |

### Activation / Deactivation / Block / Delete Behavior

- `approveUser`: sets `status: ACTIVE`, `verified: true`, `approvedBy`, `approvedAt`, clears verification and rejection fields.
- `rejectUser`: sets `status: REJECTED`, `rejectedBy`, `rejectedAt`, clears approval fields.
- `deleteUser`: refuses admins, sets `deletedAt`, sets `status: REJECTED`.
- `restoreUser`: clears `deletedAt` and currently sets `status: ACTIVE`.

Note: `restoreUser` comment says it resets status to pending, but code sets `ACTIVE`. Treat the code as current behavior and verify desired product behavior before changing.

### Supervisor Password Update / Reset

Supervisors use the same `User.password` field and bcrypt pre-save hook.

Available paths:

- Self-service `PATCH /api/users/me` can update password for authenticated users.
- Admin-only `POST /api/admin/users/:id/reset-password` sets a new password and relies on pre-save hashing.

No forced password-rotation flag, password reset email, or session invalidation is implemented.

### Scope Limitations

The current supervisor system is permission-key based only. There are no built-in data scopes such as:

- country,
- branch,
- category,
- provider,
- product,
- order owner,
- wallet range,
- reports subset,
- deposit country/payment method.

A supervisor with `orders.view` can view all admin orders exposed by that route. A supervisor with `topups.review` can review all deposits. Add scoped authorization explicitly before assigning operational staff to limited territories or suppliers.

### Audit Logs for Supervisor/Admin Actions

Audit logging is implemented in services. Relevant admin/supervisor actions include:

- `ADMIN_USER_ROLE_CHANGED`
- `ADMIN_USER_UPDATED`
- `ADMIN_USER_DELETED`
- `ADMIN_USER_PASSWORD_RESET`
- `ADMIN_USER_AVATAR_UPDATED`
- `USER_APPROVED`
- `USER_REJECTED`
- `ADMIN_WALLET_ADJUSTED`
- `ADMIN_DEBT_ADJUSTED`
- `ADMIN_ORDER_REFUNDED`
- `ADMIN_ORDER_RETRIED`
- `ADMIN_ORDER_COMPLETED`
- provider/product/category/setting actions

`authenticate.js` sets `req.auditContext.actorRole` from the actual user role, so supervisor actions can be recorded as `SUPERVISOR` where services pass audit context. Some admin services hardcode `ACTOR_ROLES.ADMIN`; verify per service before relying on actor role analytics.

### UI / Frontend Dependencies

The backend expects the frontend to:

- Store/send JWT bearer tokens.
- Hide/show admin UI based on role and `permissions[]`.
- Map permission keys exactly as backend strings.
- Use admin-only screens for settings, supervisor management, currencies, role changes, resets, uploads.
- Use `api-token` for external client API flows only.
- Treat missing permission as 403 and not as a missing route.

No backend endpoint returns a central permission catalog. The frontend must currently maintain its own mapping or derive it from documented constants.

### Security Risks / Missing Validations

- No central permission whitelist: arbitrary dot-notation strings can be stored.
- Legacy underscore permissions are checked by one route but not accepted by Joi permission validation.
- No scoped permissions by provider/country/category/order segment.
- Some admin services hardcode `ADMIN` in audit logs.
- Admin bypass is absolute.
- Supervisor creation is indirect and depends on generic user role update.
- User `permissions[]` field can contain any string if written outside the Joi-validated endpoints.
- Existing API tokens are stored plaintext.
- Provider API tokens are stored plaintext.
- No refresh-token revocation on role/permission/password change.

### How to Safely Modify the Supervisors Feature

Before changing supervisor permissions, inspect these files:

| Concern | Files |
|---|---|
| User storage | `src/modules/users/user.model.js` |
| Auth loading and active-user enforcement | `src/shared/middlewares/authenticate.js`, `src/shared/middlewares/requireActiveUser.js` |
| Role/permission checks | `src/shared/middlewares/authorize.js` |
| Admin route guards | `src/modules/admin/admin.routes.js`, `src/modules/admin/admin.catalog.routes.js` |
| Admin validation | `src/modules/admin/admin.validation.js` |
| Supervisor/user management services | `src/modules/admin/admin.users.service.js`, `src/modules/admin/admin.users.controller.js` |
| Audit constants/logging | `src/modules/audit/audit.constants.js`, `src/modules/audit/audit.service.js` |
| Frontend mapping | Frontend admin permission map/screens, outside this backend folder. |

To add a new permission:

1. Pick a dot-notation key, for example `reports.view`.
2. Add/update route guard with `requirePermission('reports.view')` or `requireAnyPermission(...)`.
3. Add the key to backend documentation and frontend permission mapping.
4. Consider adding a central whitelist before production use.
5. Update Joi validation only if the key format changes.
6. Add tests for admin bypass, supervisor allowed, supervisor denied, customer denied.

To protect a new route:

```js
router.get(
  '/reports',
  requirePermission('reports.view'),
  reportsCtrl.list
);
```

Common mistakes to avoid:

- Adding a route under `/api/admin` without a permission guard when supervisors should be restricted.
- Using underscore permission names while Joi only accepts dot notation.
- Granting `wallet.adjust`, `orders.refund`, or `topups.review` broadly without audit review.
- Forgetting that admins bypass all permission checks.
- Checking permissions in controllers instead of central middleware.
- Adding frontend-only permission checks and assuming they secure the API.
- Forgetting to update tests and audit metadata.

---

## 9. API Routes

All `/api/*` routes are behind the general API rate limiter: 500 requests per 15 minutes per IP. Auth and wallet routes may have stricter route-specific limiters.

Response summaries below describe the implemented shape at a high level; exact response fields come from controllers/services and Mongoose documents.

### Health and Public Routes

| Method | Endpoint | Auth | Handler | Input | Response / Errors |
|---|---|---|---|---|---|
| `GET` | `/health` | None | `app.js` inline | None | `{ success, status, environment, timestamp }` |
| `GET` | `/api/categories` | None | `app.js` inline, category service | None | Active categories. 500 on load failure. |
| `GET` | `/api/currencies/active` | None | `app.js` inline | None | Active currencies with code/name/symbol/platformRate. |
| `GET` | `/api/settings/payment` | None | `app.js` inline, Setting model | None | Active payment groups, country accounts, instructions, WhatsApp number. |
| `GET` | `/api/public/catalog` | None | `app.js` inline | None | Active categories/products with all pricing stripped. |

### Auth Routes - `/api/auth`

| Method | Endpoint | Auth | Controller/Service | Input | Response / Important Errors |
|---|---|---|---|---|---|
| `POST` | `/register` | None, auth rate limit | `auth.controller.register`, `auth.service.register` | `name`, `email`, `password`, optional `currency/country/phone/username` | Creates pending customer, sends verification email. Duplicate email, no active groups, validation errors. |
| `POST` | `/login` | None, auth rate limit | `auth.controller.login`, `auth.service.login` | `email`, `password` | JWT + user, or 2FA challenge. Blocks unverified/pending/rejected/no-password OAuth users. |
| `POST` | `/2fa/generate` | Bearer JWT | auth controller/service | Current user | OTP challenge. |
| `POST` | `/2fa/enable` | Bearer JWT | auth controller/service | OTP/temp token fields | Enables 2FA. |
| `POST` | `/2fa/disable` | Bearer JWT | auth controller/service | OTP/temp token fields | Disables 2FA. |
| `POST` | `/verify-2fa` | None, auth rate limit | auth controller/service | `otp`, `tempToken`/request data | Normal JWT after successful OTP. |
| `GET` | `/verify-email` | None | `auth.controller.verifyEmail` | query `token` | Redirects to frontend status URL. |
| `POST` | `/resend-verification` | None, auth rate limit | auth controller/service | `email` | Sends or returns generic response. |
| `GET` | `/google` | None | Passport | None | Redirect to Google, 503 if config missing. |
| `GET` | `/google/callback` | None | Passport + auth controller | Google callback | Redirects frontend with token/status. |
| `GET` | `/google/failure` | None | inline | None | OAuth failure response/redirect. |

### Users Routes - `/api/users`

All routes use `authenticate`.

| Method | Endpoint | Auth | Controller/Service | Input | Response / Errors |
|---|---|---|---|---|---|
| `GET` | `/me` | Active user | `user.controller.getMyProfile` | None | Current user profile. |
| `PATCH` | `/me` | Active user | `user.controller.updateMyProfile` | `name`, `email`, `phone`, `username`, `password` | Updated safe user. Schema persistence for phone/username needs verification. |
| `PATCH` | `/me/avatar` | Active user | upload + user controller | multipart `avatar` | Updates avatar path/url. |
| `PATCH` | `/me/api-token` | Active user | user controller/service | None | Regenerates plaintext API token and returns it once. |
| `GET` | `/` | Admin | user controller/service | query `page`, `limit`, `role`, `status`, `groupId` | Paginated users. |
| `GET` | `/:id` | Admin | user controller/service | path `id` | User detail. |
| `PATCH` | `/:id` | Admin | user controller/service | update user body | Updates group/name/credit/API enablement. |
| `PATCH` | `/:id/approve` | Admin | user service | path `id` | Activates and verifies user. |
| `PATCH` | `/:id/reject` | Admin | user service | path `id` | Rejects user. |

### User Panel Routes - `/api/me`

All routes use `authenticate` and `requireActiveUser`.

| Method | Endpoint | Auth | Controller/Service | Input | Response / Errors |
|---|---|---|---|---|---|
| `GET` | `/` | Active user | `me.controller.getProfile` | None | Profile, role, status, currency, wallet balance, group. |
| `GET` | `/wallet` | Active user | me controller | None | Wallet summary and last 5 transactions. |
| `GET` | `/wallet/transactions` | Active user | me controller | `page`, `limit`, `from`, `to` | Paginated transactions. |
| `GET` | `/products` | Active user | me controller | `search`, `page`, `limit` | Active products with group markup and user currency display price. |
| `GET` | `/products/:id` | Active user | me controller | path `id` | Product detail with display pricing. |
| `POST` | `/orders` | Active user | order service | `productId`, `quantity`, `orderFieldsValues`, optional `link`, `target`; `idempotency-key` header | Places order. Wallet debit, snapshots, optional provider dispatch. |
| `GET` | `/orders` | Active user | me controller | `status`, `page`, `limit`, `from`, `to` | Own orders. |
| `GET` | `/orders/:id` | Active user | order service | path `id` | Own order detail; ownership enforced. |
| `POST` | `/deposits` | Active user | upload + deposit service | multipart `receipt`, `requestedAmount`, `currency`, `paymentMethodId`, `notes` | Creates pending deposit; one pending deposit allowed. |
| `GET` | `/deposits` | Active user | deposit service | `status`, `page`, `limit` | Own deposits. |
| `GET` | `/deposits/:id` | Active user | deposit service | path `id` | Own deposit detail. |

### Client API Routes - `/api/client`

All routes use `apiAuth`, which reads the `api-token` header and finds a user with matching `apiToken` and `isApiEnabled: true`.

| Method | Endpoint | Auth | Controller/Service | Input | Response / Errors |
|---|---|---|---|---|---|
| `GET` | `/profile` | `api-token` | client service | None | `{ balance, currency, email }`. |
| `GET` | `/products` | `api-token` | client service | None | Array of API-available products with `id`, `name`, `price`, qty bounds, type, params. |
| `POST` | `/orders` | `api-token` | client service/order service | `productId`, `qty`, `order_uuid`, plus dynamic params | `{ order_id, status, price }`; custom API error codes. |
| `GET` | `/check` | `api-token` | client service | query `orders` comma-separated ids/order_uuid | Matching order statuses. |

### Products Routes - `/api/products`

| Method | Endpoint | Auth | Controller/Service | Input | Response / Errors |
|---|---|---|---|---|---|
| `GET` | `/` | Bearer JWT | product controller/service | query filters/pagination | Admins see all; customers see sanitized active products. |
| `GET` | `/:id` | Bearer JWT | product controller/service | path `id` | Product detail, sanitized for non-admin. |
| `POST` | `/` | Admin | product service | product fields | Create standalone product. |
| `POST` | `/publish` | Admin | product service | provider product publish body | Publish provider product. |
| `PATCH` | `/:id` | Admin | product service | product update body | Update product. |
| `PATCH` | `/:id/toggle-status` | Admin | product service | path `id` | Toggle active status. |

### Orders Routes - `/api/orders`

All routes use `authenticate`.

| Method | Endpoint | Auth | Controller/Service | Input | Response / Errors |
|---|---|---|---|---|---|
| `POST` | `/` | Active customer | order controller/service | `productId`, `quantity`, dynamic fields | Places order. |
| `GET` | `/my` | Active customer | order controller/service | `page`, `limit`, status filters | Own orders. |
| `GET` | `/my/:id` | Active customer | order controller/service | path `id` | Own order detail. |
| `GET` | `/` | Admin | order controller/service | filters/pagination | All orders. |
| `GET` | `/:id` | Admin | order controller/service | path `id` | Any order detail. |
| `PATCH` | `/:id/fail` | Admin | order service | path `id` | Marks failed and refunds. |
| `PATCH` | `/:id/complete` | Admin | order service | path `id` | Marks pending order completed in legacy flow. |

### Wallet Routes - `/api/wallet`

| Method | Endpoint | Auth | Controller/Service | Input | Response / Errors |
|---|---|---|---|---|---|
| `GET` | `/stats` | Active user | wallet controller | None | Aggregated own wallet stats. |
| `GET` | `/transactions` | Active user | wallet service | `page`, `limit` | Own transaction history. |
| `GET` | `/users/:userId/transactions` | Active admin | wallet service | path `userId`, pagination | Any user's transaction history. |

### Deposits Routes - `/api/deposits`

All routes use `authenticate`.

| Method | Endpoint | Auth | Controller/Service | Input | Response / Errors |
|---|---|---|---|---|---|
| `POST` | `/` | Active user | upload + deposit service | multipart `receipt`, `requestedAmount`, `currency`, `paymentMethodId`, `notes` | Pending deposit. |
| `GET` | `/` | Authenticated user | deposit service | `status`, `page`, `limit` | Admin sees all; non-admin sees own. |
| `PATCH` | `/:id/approve` | Admin | deposit service | path `id` | Approves and credits wallet. |
| `PATCH` | `/:id/reject` | Admin | deposit service | `adminNotes` | Rejects deposit. |

### Notifications Routes - `/api/notifications` and `/api/me/notifications`

Both mount the same router. All routes use `authenticate` and `requireActiveUser`.

| Method | Endpoint | Auth | Controller/Service | Input | Response / Errors |
|---|---|---|---|---|---|
| `GET` | `/` | Active user | notification service | `page`, `limit`, `isRead`, `type` | Notifications, unread count, pagination. |
| `GET` | `/unread-count` | Active user | notification service | None | Count. |
| `PATCH` | `/read-all` | Active user | notification service | None | Marks all read. |
| `DELETE` | `/read` | Active user | notification service | None | Clears read notifications. |
| `PATCH` | `/:id/read` | Active user | notification service | path `id` | Marks one read. |
| `DELETE` | `/:id` | Active user | notification service | path `id` | Deletes own notification. |
| `POST` | `/` | Admin | notification service | notification body or broadcast | Creates notification/broadcast. |

### Groups Routes - `/api/groups`

All routes use `authenticate` and admin role. Separate admin routes also exist under `/api/admin/groups`.

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `POST` | `/` | Admin | Create group. |
| `GET` | `/` | Admin | List groups. |
| `GET` | `/:id` | Admin | Get group. |
| `PATCH` | `/:id` | Admin | Update group. |
| `PATCH` | `/:id/percentage` | Admin | Update percentage. |
| `PATCH` | `/users/:userId` | Admin | Assign user to group. |

### Providers Routes - `/api/providers`

All routes use `authenticate` and admin role. Similar and more permission-aware routes exist under `/api/admin/providers`.

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `GET` | `/` | Admin | List providers. |
| `POST` | `/` | Admin | Create provider. |
| `GET` | `/:id` | Admin | Get provider. |
| `PATCH` | `/:id` | Admin | Update provider. |
| `POST` | `/:id/sync` | Admin | Sync one provider. |
| `GET` | `/:id/products` | Admin | Provider products. |
| `GET` | `/:id/products/:productId` | Admin | Provider product detail. |
| `PATCH` | `/:id/products/:productId/translated-name` | Admin | Set translated name. |
| `POST` | `/products/publish` | Admin | Publish provider product. |
| `PATCH` | `/products/:productId` | Admin | Update provider product/local linked product. |

### Audit Routes - `/api/audit`

All routes use `authenticate` and admin role. Additional admin audit routes exist under `/api/admin/audit`.

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `GET` | `/entity/:type/:id` | Admin | Audit logs for entity. |
| `GET` | `/actor/:id` | Admin | Audit logs for actor. |

### Upload Routes - `/api/upload`

| Method | Endpoint | Auth | Input | Response / Errors |
|---|---|---|---|---|
| `POST` | `/:category` | Admin | multipart `image`; category `products`, `categories`, or `payments` | `{ path: "/uploads/<category>/<filename>" }`; rejects invalid category/file type. |

### Admin Routes - `/api/admin`

All admin routes first use `authenticate` and `authorizeRoles('ADMIN', 'SUPERVISOR')` unless noted. Admin-only means `authorizeRoles('ADMIN')`.

#### Dashboard and Supervisors

| Method | Endpoint | Auth/Permission | Purpose |
|---|---|---|---|
| `GET` | `/dashboard/stats` | `dashboard.view` | Dashboard metrics. |
| `GET` | `/stats` | `dashboard.view` | Same dashboard metrics. |
| `GET` | `/supervisors` | Admin-only | List supervisors. |
| `PATCH` | `/supervisors/:id/permissions` | Admin-only | Replace supervisor permissions. |

#### Admin Users

| Method | Endpoint | Auth/Permission | Input | Purpose |
|---|---|---|---|---|
| `GET` | `/users` | `users.view` | query filters | List verified non-deleted users. |
| `GET` | `/users/deleted` | Admin-only | pagination | List soft-deleted users. |
| `POST` | `/users/adjust-debt` | `wallet.adjust` + wallet limiter | `percentage`, `reason` | Bulk debt adjustment. |
| `GET` | `/users/:id` | `users.view` | path id | User detail. |
| `PATCH` | `/users/:id` | Admin-only | name/email/status/verified/group/permissions/api | General user patch. |
| `DELETE` | `/users/:id` | `users.delete` | path id | Soft-delete non-admin. |
| `PATCH` | `/users/:id/approve` | `users.status` | path id | Activate/verify user. |
| `PATCH` | `/users/:id/reject` | `users.status` | path id | Reject user. |
| `PATCH` | `/users/:id/restore` | `users.status` | path id | Restore soft-deleted user; code sets active. |
| `PATCH` | `/users/:id/role` | Admin-only | `role`, optional `permissions` | Change role/supervisor permissions. |
| `PATCH` | `/users/:id/currency` | Admin-only | `currency` | Convert wallet balance and change currency. |
| `PATCH` | `/users/:id/credit-limit` | Admin-only | `creditLimit` | Set credit limit. |
| `POST` | `/users/:id/reset-password` | Admin-only | `password` | Reset password. |
| `PATCH` | `/users/:id/avatar` | Admin-only | multipart `avatar` | Update avatar. |

#### Admin Providers

| Method | Endpoint | Auth/Permission | Purpose |
|---|---|---|---|
| `GET` | `/providers` | any of `suppliers.manage`, `products.manage`, `manage_providers`, `manage_products` | List providers. |
| `POST` | `/providers` | `suppliers.manage` | Create provider. |
| `GET` | `/providers/:id/balance` | `suppliers.manage` | Live balance. |
| `GET` | `/providers/:id/products` | `suppliers.manage` | Live products. |
| `POST` | `/providers/:id/test-connection` | `suppliers.manage` | Test balance connection with timeout. |
| `GET` | `/providers/:id/check-order` | `suppliers.manage` | Check provider order status. |
| `GET` | `/providers/:providerId/products/:externalProductId/price` | `suppliers.manage` | Live product price. |
| `PATCH` | `/providers/:id/toggle` | `suppliers.manage` | Toggle active. |
| `GET` | `/providers/:id` | `suppliers.manage` | Provider detail. |
| `PATCH` | `/providers/:id` | `suppliers.manage` | Update provider. |
| `DELETE` | `/providers/:id` | `suppliers.manage` | Soft-delete provider. |

#### Admin Orders

| Method | Endpoint | Auth/Permission | Purpose |
|---|---|---|---|
| `GET` | `/orders` | `orders.view` | List/filter/search orders. |
| `GET` | `/orders/:id` | `orders.view` | Order detail. |
| `POST` | `/orders/:id/retry` | `orders.update` | Retry failed provider order. Needs verification; service references fields not present on schema. |
| `POST` | `/orders/:id/refund` | `orders.refund` | Refund order. |
| `POST` | `/orders/:id/sync-status` | `orders.update` | Live provider status sync. Needs verification; service populates `product`, but schema path is `productId`. |
| `POST` | `/orders/:id/complete` | `orders.update` | Force/manual complete, with re-deduction if previously refunded. |
| `PATCH` | `/orders/:id/status` | `orders.update` | Unified status update: complete/refund/retry based on target status. |

#### Admin Wallets

| Method | Endpoint | Auth/Permission | Input | Purpose |
|---|---|---|---|---|
| `GET` | `/wallets` | `wallet.view` | pagination | List wallet summaries. |
| `GET` | `/wallets/:userId` | `wallet.view` | path userId | User wallet summary. |
| `GET` | `/wallets/:userId/transactions` | `wallet.view` | pagination | User wallet transactions. |
| `POST` | `/wallets/:userId/add` | `wallet.adjust` + limiter | `amount`, `reason`/`description` | Add funds in user's wallet currency. |
| `POST` | `/wallets/:userId/deduct` | `wallet.adjust` + limiter | `amount`, `reason`/`description` | Deduct funds within balance + available credit. |
| `PUT` | `/wallets/:userId/set` | `wallet.adjust` + limiter | `targetBalance`, `reason`/`description` | Force set balance and recalc credit usage. |

#### Admin Categories

| Method | Endpoint | Auth/Permission | Purpose |
|---|---|---|---|
| `GET` | `/categories` | `products.view` | List categories. |
| `GET` | `/categories/:id` | `products.view` | Category detail. |
| `POST` | `/categories` | `products.manage` | Create category. |
| `PATCH` | `/categories/:id` | `products.manage` | Update category. |
| `PATCH` | `/categories/:id/toggle` | `products.manage` | Toggle active. |
| `DELETE` | `/categories/:id` | `products.manage` | Delete category. |

Note: `admin.routes.js` also mounts `categoryRoutes` under `/categories` with admin-only guard after defining these permission-based routes. Because explicit routes are declared first, the permission-based handlers are the current first match for those exact routes. Keep this duplication in mind when modifying categories.

#### Admin Currencies

| Method | Endpoint | Auth/Permission | Purpose |
|---|---|---|---|
| `GET` | `/currencies` | Admin-only | List currencies. Defined inline in `admin.routes.js` and also in `currency.routes.js`. |
| `POST` | `/currencies` | Admin-only | Create currency. Inline route likely handles first. |
| `GET` | `/currencies/:code` | Admin-only | Get currency by code via `currency.routes.js`. |
| `PATCH` | `/currencies/:code` | Admin-only | Update rate/platform settings. Inline route likely handles first. |
| `PATCH` | `/currencies/:code/status` | Admin-only | Enable/disable currency via `currency.routes.js`. |

#### Admin Groups

| Method | Endpoint | Auth/Permission | Purpose |
|---|---|---|---|
| `GET` | `/groups` | `groups.manage` | List groups including inactive/deleted behavior from service. |
| `POST` | `/groups` | `groups.manage` | Create group. |
| `PATCH` | `/groups/:id` | `groups.manage` | Update group. |
| `DELETE` | `/groups/:id` | `groups.manage` | Soft-delete/deactivate group. |

#### Admin Settings

| Method | Endpoint | Auth/Permission | Purpose |
|---|---|---|---|
| `GET` | `/settings` | Admin-only | List settings. |
| `GET` | `/settings/:key` | Admin-only | Get setting. |
| `PATCH` | `/settings/:key` | Admin-only | Update/create setting value. |

#### Admin Deposits / Topups

| Method | Endpoint | Auth/Permission | Purpose |
|---|---|---|---|
| `GET` | `/deposits` | `topups.review` | List deposits with filters. |
| `GET` | `/deposits/:id` | `topups.review` | Deposit detail. |
| `PATCH` | `/deposits/:id/approve` | `topups.review` | Approve with optional amount/currency/admin notes. |
| `PATCH` | `/deposits/:id/reject` | `topups.review` | Reject. |
| `PATCH` | `/deposits/:id/review` | `topups.review` | Unified approve/reject. |
| `PATCH` | `/deposits/:id` | `topups.review` | Update pending requested amount. |

#### Admin Audit

| Method | Endpoint | Auth/Permission | Purpose |
|---|---|---|---|
| `GET` | `/audit` | Admin-only | Query audit logs. |
| `GET` | `/audit/actor/:actorId` | Admin-only | Logs by actor. |

### Admin Catalog Routes - `/api/admin`

These are mounted after `admin.routes.js` and use the same admin/supervisor role base.

| Method | Endpoint | Auth/Permission | Purpose |
|---|---|---|---|
| `POST` | `/catalog/sync` | `suppliers.manage` | Sync all active providers. |
| `POST` | `/catalog/sync/:providerId` | `suppliers.manage` | Sync one provider. |
| `GET` | `/provider-products` | `suppliers.manage` | List all provider products. |
| `GET` | `/provider-products/item/:id` | `suppliers.manage` | Provider product detail. |
| `GET` | `/provider-products/item/:id/price` | `suppliers.manage` | Live price check. |
| `PATCH` | `/provider-products/item/:id/translated-name` | `suppliers.manage` | Set translated name. |
| `GET` | `/provider-products/:providerId` | `suppliers.manage` | List provider products for one provider. |
| `GET` | `/products` | `products.view` | Admin product list. |
| `POST` | `/products` | `products.manage` | Create product. |
| `POST` | `/products/from-provider` | `products.manage` | Create product from provider product. |
| `PATCH` | `/products/:id/toggle` | `products.manage` | Toggle product. |
| `DELETE` | `/products/:id` | `products.manage` | Soft-delete product. |
| `PATCH` | `/products/:id` | `products.manage` | Update product. |

---

## 10. Business Flows

### User Registration / Login

1. Customer registers through `/api/auth/register`.
2. Backend validates fields, assigns highest active group, creates pending unverified user.
3. Verification email is sent.
4. Customer clicks verification link.
5. Admin approves user through `/api/admin/users/:id/approve` or `/api/users/:id/approve`.
6. User can log in only after `verified: true` and `status: ACTIVE`.
7. Login returns JWT or 2FA challenge if enabled.

### Admin / Supervisor Login

1. Admin/supervisor exists as a `User`.
2. User logs in through `/api/auth/login`.
3. JWT role determines access.
4. `/api/admin` routes first require role `ADMIN` or `SUPERVISOR`.
5. Admin bypasses permission middleware.
6. Supervisor must have each route's required permission.

### Product Browsing / Management

Customer/user-panel flow:

1. User calls `/api/me/products` or `/api/products`.
2. Backend loads active products.
3. For `/api/me/products`, group markup and currency conversion are applied for display.
4. Sensitive fields such as provider cost, provider mapping, sync flags, and provider refs are hidden from non-admins.

Admin flow:

1. Admin/supervisor with `suppliers.manage` creates provider config.
2. Catalog sync fetches raw products into `ProviderProduct`.
3. Admin with `products.manage` publishes a curated `Product` manually or from provider product.
4. Product can define dynamic fields/order fields and provider mapping.
5. Product can be `manual` or `automatic`.

### Order Creation

1. Customer posts to `/api/me/orders`, `/api/orders`, or `/api/client/orders`.
2. Product must be active and quantity within min/max.
3. Dynamic fields are validated from product `dynamicFields` or legacy `orderFields`.
4. Pricing is calculated:
   - product base price in USD,
   - user's group percentage markup,
   - quantity,
   - user's currency `platformRate`,
   - rounded wallet `chargedAmount`.
5. For automatic provider-linked products, live provider price may be checked. If live provider price is higher than stored price, backend updates cached product pricing and rejects the order with a provider price increase error.
6. Within a Mongo transaction, backend:
   - gets next `orderNumber`,
   - debits wallet atomically,
   - creates `Order` with snapshots,
   - creates wallet transaction.
7. After commit:
   - manual orders stay `PENDING` and notify admins,
   - automatic orders become `PROCESSING` and dispatch to provider asynchronously.

### Order Status Update / Fulfillment

1. `executeOrder(orderId)` loads order/product/provider.
2. Provider parameters are built from `customerInput.values` and `providerMapping`.
3. Adapter `placeOrder()` is called.
4. Hard provider failures mark order failed and refund.
5. Transient failures may leave order `PROCESSING`.
6. `fulfillmentJob` polls `PROCESSING` automatic orders every 5 minutes.
7. Provider statuses are mapped to internal statuses:
   - completed -> `COMPLETED`,
   - pending/waiting -> `PROCESSING`,
   - canceled/failed -> terminal failure/refund path,
   - partial -> `PARTIAL` and partial refund.
8. Orders reaching retry exhaustion in the polling path can be moved to `MANUAL_REVIEW`.

### Wallet / Add Funds / Payment

Order debit:

1. `debitWalletAtomic` checks `walletBalance + creditLimit >= amount`.
2. It subtracts from `walletBalance`; wallet can go negative up to credit limit.
3. It returns `walletDeducted` and `creditUsedAmount`.
4. A `DEBIT` wallet transaction is recorded.

Refund:

1. Refund uses order snapshots.
2. `refundWalletAtomic` adds `walletDeducted` back and reduces `creditUsed`.
3. A `REFUND` transaction is recorded.

Admin adjustments:

- `POST /api/admin/wallets/:userId/add` credits user's local wallet currency.
- `POST /api/admin/wallets/:userId/deduct` deducts with credit-limit enforcement.
- `PUT /api/admin/wallets/:userId/set` force-sets balance.
- Debt adjustment can bulk-adjust negative balances.

### Deposit / Top-up Flow

1. Customer uploads receipt to `/api/me/deposits` or `/api/deposits`.
2. Currency must be active.
3. Backend snapshots `exchangeRate = Currency.platformRate` and computes `amountUsd`.
4. User cannot have another pending deposit.
5. Deposit is created with `PENDING` status.
6. Notifications are sent to user and admins/supervisors with `topups.review`.
7. Admin/supervisor approves/rejects through `/api/admin/deposits/*`.
8. Approval can override amount/currency.
9. Wallet credit amount is:
   - exact amount if deposit currency equals user wallet currency,
   - otherwise converted deposit currency -> USD -> wallet currency using platform rates.
10. Wallet is credited and audit logs are written.

### Provider Integration Flow

1. Admin creates `Provider` with name/slug/baseUrl/apiToken.
2. Adapter factory resolves provider slug/name to adapter.
3. Sync job or manual sync calls adapter `fetchProducts()`.
4. `ProviderProduct` upserts preserve translated names.
5. Linked sync-priced products can receive updated provider/base/final prices.
6. Automatic orders call adapter `placeOrder()`.
7. Polling calls adapter `checkOrders()` or `checkOrder()`.
8. Status mapper normalizes provider strings.

### Notification Flow

- User registration creates admin notifications for pending users.
- Deposit creation notifies user and admin actors with `topups.review`.
- Low provider balance can create admin notifications.
- Manual/admin notifications can be created through notification routes.
- Users can list, mark read, mark all read, delete one, and clear read notifications.

---

## 11. External Integrations

### Provider API Adapters

| Integration | Purpose | Main Files | Config | Behavior |
|---|---|---|---|---|
| Royal Crown | Catalog, order placement, status checks, balance | `royalCrown.adapter.js` | DB `Provider.baseUrl`, `Provider.apiToken` | Uses `api-token` header; fetches `/api/AllProducts`; places `/api/PlaceOrder/:productId/data`; checks `/api/CheckOrder` and `/api/CheckListOrders`. |
| Torosfon | Same Royal Crown-style API | `torosfon.adapter.js` | DB provider config | Similar endpoints/header to Royal Crown. |
| Alkasr / Miral VIP | Catalog/order/status/balance | `alkasr.adapter.js` | DB provider config | Uses `/client/api/products`, `/client/api/newOrder/:productId/params`, `/client/api/check`, `/client/api/profile`. |
| Mock | Test/dev fallback | `mock.adapter.js` | None | Returns fake products/orders/balance. Factory may fall back to mock when strict mode is not used. |

Adapter factory: `src/modules/providers/adapters/adapter.factory.js`.

Registered provider keys include:

- `royal-crown`, `royal crown`, `royalcrown`
- `toros`, `torosfon`, `torosfon store`, `toros-store`, `torosfonstore`
- `alkasr`, `alkasr-vip`, `alkasr vip`, `alkasrvip`, `miral-store`, `miral store`, `miralstore`
- `mock`

Provider error handling:

- Fulfillment service treats timeout/network/503/504-style errors as transient in some paths.
- Hard placement failures can mark order failed and refund.
- Provider polling maps external status to internal status and refunds canceled/partial/failed cases.
- Provider price cache can avoid repeated live price calls within TTL.

### Google OAuth

| Item | Detail |
|---|---|
| Purpose | Optional social login/register. |
| Files | `src/config/google.strategy.js`, `src/modules/auth/auth.routes.js`, auth service/controller. |
| Env | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `FRONTEND_URL`. |
| Behavior | Creates or links user by email/googleId; new users are verified but pending approval. |

### SMTP / Email

| Item | Detail |
|---|---|
| Purpose | Email verification and 2FA OTP. |
| File | `src/services/email.service.js`. |
| Env | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `APP_URL`. |
| Behavior | Test mode no-ops. Registration email send is fire-and-forget; failure logs but does not roll back user creation. |

### Exchange Rate API

| Item | Detail |
|---|---|
| Purpose | Populate `Currency.marketRate` from an external market-rate feed. Billing uses `platformRate`, not marketRate. |
| Files | `src/services/exchangeRateSync.service.js`, `src/jobs/exchangeRateSync.job.js`. |
| Env | `EXCHANGE_RATE_API_URL`, `EXCHANGE_RATE_API_KEY`, `EXCHANGE_RATE_TIMEOUT_MS`. |
| Behavior | Updates existing currencies' `marketRate`; creates new currencies inactive with platformRate set to marketRate. |
| Current startup status | Job exists but is not started by `src/server.js`. |

### Local Upload Storage

| Item | Detail |
|---|---|
| Purpose | Store avatars, product/category/payment images, deposit receipts. |
| Files | `src/shared/middlewares/upload.js`, `src/shared/routes/upload.routes.js`. |
| Storage | Disk under `Backend/uploads`. |
| Public URL | `/uploads/<category>/<filename>`. |
| Validation | 20 MB max; images allowed generally; deposits also allow PDF. |

---

## 12. Error Handling & Response Format

### Global Error Middleware

File: `src/shared/errors/errorHandler.js`

It handles:

- `AppError` subclasses.
- Mongoose cast errors.
- Duplicate key errors.
- Mongoose validation errors.
- JWT invalid/expired errors.
- Unknown errors as 500 in production.

Development responses include stack traces. Production hides unknown internals.

### Error Classes

File: `src/shared/errors/AppError.js`

| Class | Status | Typical Use |
|---|---:|---|
| `AppError` | custom | Base operational error. |
| `ValidationError` | 400 | express-validator validation failures. |
| `AuthenticationError` | 401 | Missing/invalid auth. |
| `AuthorizationError` | 403 | Role/permission/ownership failures. |
| `NotFoundError` | 404 | Missing resource. |
| `ConflictError` | 409 | Duplicate email/name/etc. |
| `InsufficientFundsError` | 422 | Wallet balance insufficient. |
| `BusinessRuleError` | 422 | Domain rule violation. |

### Success Response

Helpers in `src/shared/utils/apiResponse.js` use:

```json
{
  "success": true,
  "message": "Message",
  "data": {}
}
```

Created responses use HTTP 201.

### Pagination Response

```json
{
  "success": true,
  "message": "Items retrieved.",
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "pages": 5
  }
}
```

### Error Response

Typical operational response:

```json
{
  "success": false,
  "code": "BUSINESS_RULE_ERROR",
  "statusCode": 422,
  "message": "Human-readable message"
}
```

Some routes differ:

- Rate limiters return `{ success: false, code, message }`.
- `/api/client` returns custom `error_code` numbers for API clients.
- Inline public routes in `app.js` return simpler 500 messages.

### Validation Errors

- `express-validator` routes call `validate.js`, which throws `ValidationError` with an array of `{ field, message, value }`.
- Admin/category routes use Joi via `validateBody`/`validateQuery` and throw `BusinessRuleError('VALIDATION_ERROR')`.
- Client API validation returns `error_code: 123`.

---

## 13. Security Notes

- Passwords are hashed with bcryptjs using `BCRYPT_ROUNDS`.
- JWT secret is required at startup. Use a long, random production secret.
- There is no refresh-token rotation or token revocation store.
- Account activation requires email verification plus admin approval for normal registration.
- `authenticate` rejects non-active users.
- 2FA exists with email OTP and a temporary 2FA JWT purpose.
- Helmet is enabled with adjusted cross-origin resource policies for uploads.
- CORS is strict in production and open in development/test.
- Rate limiting:
  - `/api`: 500 requests per 15 minutes.
  - auth: 10 requests per 15 minutes.
  - wallet adjustments: 20 requests per 15 minutes.
- Uploads are limited to 20 MB and file types are checked, but filenames are publicly served and uploads are stored on local disk.
- Provider API tokens are stored plaintext in MongoDB.
- Customer API tokens are stored plaintext in MongoDB.
- Supervisor permissions have no central whitelist and no data scoping.
- Admin bypasses all permission checks.
- Some admin/audit service code hardcodes actor role as `ADMIN`.
- Manual wallet/order operations are powerful and should be monitored through audit logs.
- The provider adapter factory can fall back to mock adapter in non-strict resolution; this can hide configuration mistakes.
- Sensitive `.env` values must not be committed.

---

## 14. Performance Notes

- Pagination exists on most list endpoints; defaults vary by route.
- Admin user listing clamps limit to 20 in `admin.users.service.js`.
- Admin order listing allows limit up to 500.
- Indexes support common lookups: users by email/status/role, orders by user/status/provider polling, provider products by provider/external id, wallet/deposits by user/status dates.
- In-memory caches:
  - currency converter cache: 60 seconds,
  - provider price cache: default 5 minutes.
- Provider product sync uses configurable upsert concurrency (`SYNC_UPSERT_CONCURRENCY`, default 10).
- Cron jobs use in-process locks to avoid overlapping runs in a single process.
- PM2 cluster mode can start multiple app processes; in-process cron locks are not distributed. Multiple PM2 instances may run the same cron jobs unless externally controlled.
- Large provider syncs and order polling run in the API process. Consider separating workers before high traffic.
- `admin.orders.service.listOrders` validates `providerId` query but does not currently apply it to the Mongo query.
- Some regex searches over order fields/providerOrderId can become expensive on large collections.

Suggested safe improvements:

- Add central permission registry and tests.
- Add distributed job locking if running multiple Node processes.
- Move provider sync/polling to a worker process/queue.
- Add indexes for frequently used search fields after observing real queries.
- Encrypt provider/API tokens at rest.
- Add structured logging and request correlation IDs.

---

## 15. Development Guidelines

### Add a New Route

1. Add route in the appropriate `*.routes.js`.
2. Use `authenticate` and `requireActiveUser` if user context is needed.
3. For admin routes, decide:
   - admin-only: `authorizeRoles('ADMIN')`,
   - admin/supervisor: `authorizeRoles('ADMIN', 'SUPERVISOR')` plus `requirePermission(...)`.
4. Add validation with express-validator or Joi, matching module style.
5. Put HTTP parsing in controller and business logic in service.
6. Use `catchAsync` for async controllers.
7. Return through `sendSuccess`, `sendCreated`, or `sendPaginated`.
8. Add tests for success, validation failure, auth failure, and permission failure.

### Add a New Model

1. Create `*.model.js` in the module.
2. Define required fields, enums, indexes, timestamps.
3. Add business invariants as schema validation/pre-hooks only when they are truly schema-level rules.
4. Keep sensitive fields `select: false`.
5. Add service methods for writes; avoid direct controller writes for complex logic.
6. Add tests around schema validation and service behavior.

### Add a New Permission

1. Use dot notation, for example `reports.view`.
2. Guard route with `requirePermission`.
3. Update this README and frontend mapping.
4. Add tests for admin/supervisor/customer cases.
5. Prefer adding a central backend permission catalog before expanding RBAC further.

### Add a New Provider / Integration

1. Add adapter class under `src/modules/providers/adapters`.
2. Implement the `BaseProviderAdapter` contract: catalog, place order, check order/batch, balance where possible.
3. Normalize provider product DTOs to fields used by `providerProductSync.service.js`.
4. Normalize provider order responses for fulfillment service.
5. Register slug/name aliases in `adapter.factory.js`.
6. Add tests using mocked provider responses.
7. Document provider-specific params and status mapping.

### Test a Feature

```bash
npm test
```

For focused work:

```bash
npx jest src/tests/order.test.js --runInBand
```

Tests use `mongodb-memory-server`; first run can be slower while binaries are downloaded.

### Code Style Conventions Observed

- CommonJS modules (`require`, `module.exports`).
- `'use strict';` at the top of most source files.
- Controllers are relatively thin.
- Services hold domain logic.
- Custom operational errors are preferred over raw `Error`.
- Monetary product prices are often strings with Decimal.js helpers; wallet balances are numbers rounded to fiat precision.
- Validation is mixed: express-validator for many public/module routes, Joi for admin/category routes.
- Audit logs are fire-and-forget in many flows; do not make audit failure break customer flows unless intentionally changing behavior.

---

## 16. Known Issues / TODO / Needs Verification

- No dedicated supervisor creation endpoint exists; supervisors are created by promoting existing users.
- Supervisor permissions are not backed by a central whitelist.
- Legacy permission aliases `manage_providers` and `manage_products` are checked by one route but cannot be assigned through current Joi dot-notation validation.
- Supervisor permissions are global only; no country/provider/category/order scope exists.
- Some admin services hardcode `ACTOR_ROLES.ADMIN`, which can make supervisor audit attribution inaccurate.
- `admin.orders.service.retryOrder()` references `order.providerProductId`, `order.externalProductId`, and `order.orderFieldsValues`, which are not fields on the current `Order` schema. Retry behavior needs verification.
- `admin.orders.service.syncOrderProviderStatus()` uses `.populate('product')`, but the schema path is `productId`. This route likely needs correction/verification.
- `admin.orders.service.listOrders()` accepts/validates `providerId` but does not apply it to the query.
- `orderPolling.job.js` and `src/jobs/exchangeRateSync.job.js` exist but are not started by `src/server.js`.
- `server.js` comments say fulfillment polling every minute, but `fulfillmentJob.js` default schedule is every 5 minutes.
- Admin category routes are duplicated: explicit permission-based routes plus mounted admin-only category routes.
- Admin currency routes overlap between inline `admin.routes.js` and `currency.routes.js`.
- `.env.example` contains provider-specific env vars that the current adapter factory does not use; live provider config is stored in the `Provider` collection.
- Registration validation/services reference `username`, `phone`, and `country`, but `User` schema does not define them.
- `restoreUser` comment says restored users become pending, but code sets `status: ACTIVE`.
- Existing docs under `docs/` contain stale claims in places, including admin-only authorization, deposit field names, cron timing, and older status lists.
- Provider and customer API tokens are stored plaintext.
- Provider adapter fallback to mock can hide bad provider slug/name configuration.
- Product `orderFields`, `dynamicFields`, and `providerMapping` are core to order fulfillment but not consistently validated by all product route validators.
- In PM2 cluster mode, cron jobs can run in every process because locks are process-local.
- Uploads are stored on local disk; production deployments with multiple instances need shared storage or sticky file routing.
- No refresh tokens, logout endpoint, token revocation, or forced JWT invalidation after password/permission change.
- `Project/uploads` exists but active static files come from `Backend/uploads`; confirm whether the extra folder is legacy.

---

## Supervisor / Admin Permission Reference - Current Implementation

This section documents the current supervisor/admin permission behavior after the recent RBAC, wallet, product-visibility, provider-sync, and notification updates. It is intended as the source of truth for future backend changes.

### Personal Routes vs Admin Routes

Supervisors are hybrid accounts: they can use their personal customer-facing account surfaces and, separately, may access admin surfaces only when their supervisor permissions allow it.

| Area | Supervisor behavior | Backend boundary |
| --- | --- | --- |
| Personal orders | Allowed even without `orders.view`; returns only the supervisor's own orders. | Personal order endpoints such as `/api/me/orders` remain account-scoped. |
| Personal wallet | Allowed even without `wallet.view`; returns only the supervisor's own wallet/transactions. | Personal wallet endpoints such as `/api/wallet/transactions` and personal `/me` endpoints remain account-scoped. |
| Personal topup/deposit pages | Not enabled for supervisors in the current frontend flow. | Deposit creation remains a customer-facing flow unless a backend route explicitly allows another role. |
| Admin orders | Requires admin/supervisor admin route access plus `orders.view`. | `/api/admin/orders` is guarded by `requirePermission('orders.view')`. |
| Admin wallet | Requires admin/supervisor admin route access plus `wallet.view`. | `/api/admin/wallets` is guarded by `requirePermission('wallet.view')`. |

Do not use role alone to choose admin endpoints. Personal pages should call personal endpoints; admin pages should call `/api/admin/*` endpoints and rely on backend permission checks.

### Wallet Adjustment Permission

The existing `wallet.adjust` permission is now active for supervisors, but only for the safest operation.

| Operation | ADMIN | SUPERVISOR with `wallet.adjust` | SUPERVISOR without `wallet.adjust` |
| --- | --- | --- | --- |
| Add balance to CUSTOMER | Allowed | Allowed | Forbidden |
| Add balance to self | Allowed by admin tooling only when targeting another account | Forbidden | Forbidden |
| Add balance to ADMIN | Allowed | Forbidden | Forbidden |
| Add balance to SUPERVISOR | Allowed | Forbidden | Forbidden |
| Deduct balance | Allowed | Forbidden | Forbidden |
| Set exact balance | Allowed | Forbidden | Forbidden |
| Debt/credit adjustment | Admin-only | Forbidden | Forbidden |

Backend files involved:

- `src/modules/admin/admin.routes.js`
- `src/modules/admin/admin.wallet.controller.js`
- `src/modules/admin/admin.wallet.service.js`

Important implementation notes:

- `POST /api/admin/wallets/:userId/add` requires `wallet.adjust`.
- Supervisor add-balance requests are additionally validated in `admin.wallet.service.js`.
- Supervisor target users must have role `CUSTOMER`.
- Supervisors cannot adjust their own wallet.
- `POST /api/admin/wallets/:userId/deduct`, `PUT /api/admin/wallets/:userId/set`, and `POST /api/admin/users/adjust-debt` remain admin-only.
- Wallet audit records use the real actor role, so supervisor add-balance actions are audited as `SUPERVISOR`.
- Blocked supervisor wallet actions return authorization errors before wallet mutation and before notification creation.

### Product Permissions

Product management is intentionally split so supervisors can view and manage limited metadata without seeing provider or pricing data.

| Permission | Supervisor behavior on `/api/admin/products` |
| --- | --- |
| `products.view` | Read-only admin product list. No price fields, provider columns, provider IDs, supplier IDs, provider product IDs, raw provider data, or product action mutations. |
| `products.manage` | Safe metadata updates only. Intended safe fields are `name`, `description`, `image`, `category`, `displayOrder`, and active status where the controller/service supports them safely. Manual price editing and provider linkage are blocked. |
| `products.provider.sync` | Blind provider link/sync only. Allows linking an existing platform product to a provider product and triggering provider price sync without returning any price values. |

Admin-only product operations:

- Product creation.
- Product creation from provider catalog.
- Product delete.
- Manual pricing edits.
- Full provider/pricing response visibility.
- Full provider product raw/price details.

### Supervisor Product Visibility

When `req.user.role` is `SUPERVISOR`, admin product responses are sanitized before leaving the backend. Supervisors must not receive internal price or provider-mapping fields from admin product management endpoints.

Hidden from supervisors where present:

```text
basePrice
basePriceCoins
providerPrice
rawPrice
price
finalPrice
sellingPrice
displayPrice
markedUpPriceUSD
usdAmount
priceCoins
originalPrice
original_price
cost
rate
api_price
provider_price
basePriceSnapshot
providerPriceSnapshot
markupType
markupValue
manualPriceAdjustment
enableManualPrice
syncPriceWithProvider
pricingMode
provider
providerId
supplierId
providerProduct
providerProductId
providerMapping
externalProductId
rawPayload
rawResponse
profit
margin
```

Relevant files:

- `src/shared/utils/priceVisibility.js`
- `src/modules/admin/admin.catalog.controller.js`
- `src/modules/products/product.service.js`

Sanitization must not mutate shared Mongoose documents in place. Use lean/plain objects or cloned objects before deleting sensitive fields.

### Blind Provider Link / Sync

`products.provider.sync` is a dedicated permission for blind provider linkage. It must not be folded into `products.manage`.

Allowed for a supervisor with `products.provider.sync`:

- Select a provider by name.
- Select a provider product by name/search result.
- Link or move an existing platform product to the selected provider product.
- Trigger provider price sync.

Not allowed for supervisors:

- Seeing old/new/base/provider/raw/final/display/selling price values.
- Seeing cost/profit/margin/markup values.
- Seeing raw provider payloads or external provider IDs.
- Creating products from provider catalog.
- Deleting products.
- Manually editing price fields.

Endpoints:

| Endpoint | Purpose | Supervisor response |
| --- | --- | --- |
| `GET /api/admin/product-provider-options` | Safe provider picker | `{ id, name, isActive }` for internal selection; UI must not render IDs visibly. |
| `GET /api/admin/product-provider-options/:providerId/products` | Safe provider product picker | `{ id, name, providerName, categoryLabel, minQty, maxQty, isActive }`; no prices, raw payload, or external product IDs. |
| `PATCH /api/admin/products/:id/provider-link` | Link product to provider product | Generic success message plus safe current linkage summary. |
| `POST /api/admin/products/:id/provider-sync` | Blind price sync | Generic success message plus safe current linkage summary. |

Safe current linkage summary returned to supervisors:

```json
{
  "currentProviderName": "Provider Name",
  "currentProviderProductName": "Provider Product Name",
  "linkageMode": "sync",
  "isLinked": true,
  "currentProviderProductActive": true,
  "currentProviderMinQty": 1,
  "currentProviderMaxQty": 100
}
```

The summary must not include price fields, raw provider payload, provider product raw response, `externalProductId`, or visible provider/product identifiers beyond names and safe status/quantity metadata.

### Supervisor Product Update Payload Guards

Supervisor product update requests through general product endpoints must reject unsafe fields, including pricing and provider-linkage fields. The dedicated blind provider-link endpoint is the only supervisor path allowed to change provider linkage, and it accepts only the provider/provider-product IDs needed to perform the link.

If future product metadata permissions are added, check all of these before changing behavior:

- Route guard in `src/modules/admin/admin.catalog.routes.js`.
- Payload validation in `src/modules/admin/admin.catalog.controller.js`.
- Service mutation behavior in `src/modules/products/product.service.js`.
- Sanitization in `src/shared/utils/priceVisibility.js`.
- Frontend permission mapping and payload construction.

### Notification Events

The backend now emits notifications through the existing notification infrastructure for these flows:

| Event area | Recipients | Notes |
| --- | --- | --- |
| New order | Admins and supervisors with relevant order permissions | Created once using `metadata.eventKey`. |
| Manual review order | Admins and supervisors with order permissions | Emitted when an order enters manual review. |
| Completed order | Affected customer, admins, and permitted supervisors | Customer message is safe and generic. |
| Failed/canceled order | Affected customer, admins, and permitted supervisors | Customer message does not expose raw provider responses. |
| Refunded order | Affected customer, admins, and permitted supervisors | Emitted only after wallet refund/credit succeeds. |
| Provider rejected + refunded | Admins and permitted supervisors | High-priority warning. |
| Manual wallet credit/debit/set | Affected customer, admins, and permitted supervisors | Supervisor add-balance actions use the same notification path when allowed. |
| New topup/deposit request | Admins and supervisors with `topups.review` | Review notification. |
| Topup approved | Affected customer; admin/supervisor event where applicable | User notification is sent after wallet credit succeeds. |
| Topup rejected | Affected customer; admin/supervisor event where applicable | Message does not say balance was credited. |

Permission targeting:

- Order events: supervisors with `orders.view`, `orders.update`, or `orders.refund` depending on event type.
- Refund/wallet events: supervisors with `wallet.view` or `wallet.adjust` where applicable.
- Topup/deposit events: supervisors with `topups.review`.
- Customers receive only their own notifications.

### Notification Deduplication

Notification helpers include `metadata.eventKey` to prevent duplicate notifications during retries, polling, and repeated status transitions.

Examples:

```text
order:<orderId>:completed
order:<orderId>:refunded
order:<orderId>:provider_rejected_refunded
user:<userId>:order:<orderId>:completed
wallet:<userId>:manual_add:<transactionId>
topup:<depositId>:approved
user:<userId>:topup:<depositId>:approved
```

`notification.service.js` checks for an existing notification with the same `{ userId, metadata.eventKey }` before creating or broadcasting. Notification failures are logged and should not break the money/order operation unless the project intentionally changes that convention later.

### High-Priority Provider Rejection / Refund Warning

When a provider rejects/fails an order and the customer refund succeeds, admins and permitted supervisors receive a high-priority warning similar to:

```text
تحذير: تم رفض الطلب من المورد وتم رد المبلغ للمستخدم. راجع العملية المرفوضة لهذا المستخدم.
```

Customer-facing messages stay safe and do not expose provider raw reasons unless they are explicitly sanitized in a future change.

### Remaining TODO / Needs Verification

- Consider adding a database-level unique partial index on `{ userId, metadata.eventKey }` for stronger deduplication under concurrent notification creation.
- Decide whether provider `Cancelled`/`Canceled` statuses should map to `FAILED` or `CANCELED`; do not change this without product/client confirmation.
- Optional frontend high-priority notification styling can make `HIGH` priority more visible, but the backend priority field already exists.
- Decide whether category management should receive a separate supervisor permission instead of sharing broader product/admin permissions.
- Decide whether more granular product metadata permissions are needed beyond `products.manage`.
- Confirm whether supervisors should ever be allowed to create safe non-pricing products; current behavior keeps creation admin-only.
