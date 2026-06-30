# Phase 2.5J Seed Data + Smoke Test Report

## Files changed

- `scripts/seed-smoke-data.js`
- `package.json`
- `.env.example`
- `src/tests/smokeSeed.test.js`
- `docs/PHASE_2_5J_SEED_SMOKE_REPORT.md`

## Seed script added

- Added `scripts/seed-smoke-data.js`.
- The script is idempotent and does not delete, truncate, or hard-reset collections.
- The script exports helpers so Jest can exercise the seed behavior in the in-memory test database.

## NPM script added

- Added `npm run seed:smoke`.
- Command:

```bash
cd Backend
npm run seed:smoke
```

## Seeded records

- Users:
  - Admin: `smoke.admin@example.com`
  - Active customer: `smoke.customer@example.com`
  - Pending customer: `smoke.pending@example.com`
- Groups:
  - `Default`
  - `Silver`
  - `Gold`
  - `Sub Agent`
- Currencies:
  - `USD`
  - `EGP`
- Payment settings:
  - `paymentGroups` gets one seed-owned `Smoke Payment Methods` group.
  - Manual method id: `smoke-vodafone-cash-egp`
  - Optional mock-card method id: `smoke-mock-card`
  - `paymentInstructions` is filled only when empty.
- Catalog:
  - Main category: `Smoke Games`
  - Subcategory: `Smoke Test Products`
  - Manual product: `Smoke Test Manual Product`
  - Required order field: `player_id`

## Environment variables supported

- `SMOKE_ADMIN_EMAIL`
- `SMOKE_ADMIN_PASSWORD`
- `SMOKE_ADMIN_NAME`
- `SMOKE_CUSTOMER_EMAIL`
- `SMOKE_CUSTOMER_PASSWORD`
- `SMOKE_CUSTOMER_NAME`
- `SMOKE_PENDING_CUSTOMER_EMAIL`
- `SMOKE_PENDING_CUSTOMER_PASSWORD`
- `SMOKE_PENDING_CUSTOMER_NAME`
- `SMOKE_EGP_PLATFORM_RATE`
- `SMOKE_VODAFONE_CASH_NUMBER`
- `SMOKE_VODAFONE_CASH_OWNER`
- `SMOKE_PROVIDER_NAME`
- `SMOKE_PROVIDER_BASE_URL`
- `SMOKE_PROVIDER_API_TOKEN`
- `SMOKE_PROVIDER_ACTIVE`
- `ALLOW_PRODUCTION_SEED`

## Production safety behavior

- The script refuses to run when `NODE_ENV=production`.
- It can only be overridden by explicitly setting `ALLOW_PRODUCTION_SEED=true`.
- Production seeding remains strongly discouraged; use a disposable development database.

## Idempotency behavior

- Stable keys, names, slugs, and ids are used for seed-owned records.
- Running the script repeatedly updates the same smoke users, groups, currencies, settings group, categories, and product.
- Existing non-smoke payment groups are preserved.
- Existing user wallet balances are not reset on repeated runs.

## Optional provider behavior

- No provider is seeded by default.
- A provider is seeded only when `SMOKE_PROVIDER_NAME`, `SMOKE_PROVIDER_BASE_URL`, and `SMOKE_PROVIDER_API_TOKEN` are all present.
- If provider env vars are present but `PROVIDER_CREDENTIALS_KEY` is missing, provider seeding is skipped safely.
- Provider tokens are never printed.
- If seeded, provider credentials pass through the normal provider model encryption hook.

## Wallet seeding decision

- The seed does not directly credit wallet balance.
- Wallet funding remains a real smoke-test flow: customer submits a manual deposit, then admin approves it.
- No dev-only direct wallet credit option was added.

## Tests/checks run

- Backend `npm.cmd run lint`: passed.
- Backend `npm.cmd test -- --runInBand`: passed, 24 suites and 669 tests.
- Backend `git diff --check`: passed.
- Frontend `npm.cmd run lint`: passed.
- Frontend `npm.cmd run build`: passed.
- Frontend `git diff --check`: passed.
- Targeted `smokeSeed.test.js` also passed on its own before the full suite.
- The seed script was not run against a local persistent Mongo database; its behavior is covered by Jest against the in-memory test database.

## Remaining warnings

- Default smoke passwords are development-only and should be overridden in shared environments.
- The seeded payment account number is a fake development value.
- The optional mock-card method is active only when the backend environment allows the `MOCK` gateway.
- Provider seed remains optional and requires safe dev credentials plus `PROVIDER_CREDENTIALS_KEY`.
- Backend tests still print existing fulfillment/audit/order-polling console output.
- Mongoose still prints an existing duplicate schema index warning for category slug during tests.
- Frontend build still prints the existing large chunk-size warning.
- Git still prints the existing malformed `safe.directory` warning, and Backend diff check prints LF-to-CRLF notices for touched files.

## Completion status

Phase 2.5J backend seed work is complete.
