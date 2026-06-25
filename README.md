# Digital Products Platform Backend

Clean Phase 1 backend base for a digital products, wallet, recharge, catalog, provider, and order platform.

This repository is a modular Express monolith backed by MongoDB/Mongoose. Phase 1 keeps the existing architecture and useful modules, removes copied-project identifiers, fixes baseline persistence/config issues, and documents what is intentionally not implemented yet.

## Tech Stack

- Node.js, Express, Mongoose, MongoDB
- JWT authentication, bcrypt password hashing
- Passport Google OAuth when configured
- Multer local uploads under `uploads/`
- Jest with `mongodb-memory-server`
- PM2 ecosystem config for process management

## Folder Structure

```text
src/
  app.js                 Express app, middleware, route mounting
  server.js              Mongo connection, HTTP startup, background jobs
  config/                Database, runtime config, OAuth strategy
  modules/               Domain modules: auth, users, groups, wallet, deposits,
                         products, categories, providers, orders, notifications,
                         audit, currency, admin, me, client
  services/              Shared services such as email and exchange-rate sync
  shared/                Middleware, errors, response helpers, upload handling
  tests/                 Jest test suites and helpers
scripts/                 Development utility scripts
uploads/                 Active local upload root, served at `/uploads`
docs/                    Clean Phase 1 documentation
```

## Setup

```bash
npm install
cp .env.example .env
npm run seed
npm run dev
```

Required local services:

- MongoDB reachable through `MONGO_URI`
- SMTP settings only if outbound verification or 2FA email should send
- Provider credentials stored through Provider records only when live integrations are intentionally enabled

## Environment

Required:

- `MONGO_URI`
- `JWT_SECRET`

Common local defaults:

- `PORT=5000`
- `APP_URL=http://localhost:5000`
- `FRONTEND_URL=http://localhost:5173`
- `ALLOWED_ORIGINS=http://localhost:5173`
- `EMAIL_FROM=noreply@example.com`

See [.env.example](.env.example) for the full sanitized list of variables used by the current app.

## Scripts

```bash
npm run dev          # nodemon src/server.js
npm start            # node src/server.js
npm run seed         # seed groups, generic users, and sample products
npm run seed:clear   # clear seeded collections handled by the seed script
npm run lint         # syntax-check project JavaScript files
npm test             # Jest test suite
```

Seeded example users:

- `admin@example.com` / `AdminExample123`
- `customer@example.com` / `CustomerExample123`

## Main Modules

- `auth`: email/password registration, login, email verification, 2FA, optional Google OAuth.
- `users` and `me`: profile, avatar, status, API token, self-service and admin user actions.
- `groups`: pricing groups and percentage markup tiers.
- `wallet`: wallet balance mutations and transaction records.
- `deposits`: customer deposit requests with receipt upload and admin review.
- `products` and `categories`: sellable catalog management.
- `providers`: provider configuration, adapters, catalog sync, live order fulfillment hooks.
- `orders`: order creation, pricing, wallet debit/refund, provider status polling.
- `notifications`: user/admin notifications for account, order, wallet, and deposit events.
- `audit`: audit logging with sensitive-field redaction.
- `currency`: platform exchange rates and user wallet currency support.
- `admin`: dashboard, users, providers, orders, wallets, groups, settings, currencies, audit.
- `client`: token-based customer API using the `api-token` header.

## Current Baseline Status

- API prefixes are preserved, including `/api/auth`, `/api/users`, `/api/me`, `/api/admin`, `/api/products`, `/api/orders`, `/api/wallet`, `/api/deposits`, `/api/providers`, `/api/groups`, `/api/notifications`, `/api/categories`, and `/api/currencies`.
- Uploads use one active local root: `uploads/`, served publicly at `/uploads`.
- Registration/profile fields now persist `phone`, `country`, `currency`, `username`, and `avatar` where current routes already use them.
- `referralCode` and `referredBy` exist only as inert placeholders. No referral calculations are implemented.
- Provider adapters remain available, but no live provider is seeded or enabled by default.
- Provider and customer API tokens are still plaintext in MongoDB. Encrypt before production.

## Not Implemented Yet

- Card or online payment gateway logic
- Payment gateway webhook handling
- Referral/invitation commission logic
- Group-change or sub-agent request workflow
- Frontend compatibility layer for a new UI
- Expanded wallet ledger event taxonomy
- Production token encryption/rotation

## Phase 2 TODO

See [docs/PHASE_2_FEATURE_TODO.md](docs/PHASE_2_FEATURE_TODO.md) for the next development plan.

## Documentation

- [Baseline architecture](docs/BASELINE_ARCHITECTURE.md)
- [Phase 2 feature TODO](docs/PHASE_2_FEATURE_TODO.md)
- [Cleanup report](docs/CLEANUP_REPORT.md)
