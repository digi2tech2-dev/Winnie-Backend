# Phase 2.5V Final QA Bug Fixes Report

## Files Changed

- `src/modules/admin/admin.routes.js`
- `src/modules/admin/admin.users.controller.js`
- `src/modules/admin/admin.users.service.js`
- `src/modules/admin/admin.validation.js`
- `src/modules/currency/currency.controller.js`
- `src/modules/currency/currency.service.js`
- `src/modules/me/me.controller.js`
- `src/modules/orders/order.controller.js`
- `src/modules/orders/order.routes.js`
- `src/modules/payments/payment.routes.js`
- `src/modules/payments/payment.service.js`
- `src/modules/products/product.service.js`
- `src/tests/admin.test.js`
- `src/tests/catalog.test.js`
- `src/tests/currency.test.js`
- `src/tests/order.test.js`
- `docs/PHASE_2_5V_FINAL_QA_BUG_FIXES_REPORT.md`

## Currency User And Admin Behavior

- `PATCH /api/me/currency` remains the self-service route and accepts active platform currencies only.
- `PATCH /api/admin/users/:id/currency` validates an active platform currency and updates only `User.currency`.
- Admin currency changes do not convert wallet balances, alter roles/groups, recalculate historical records, or create wallet ledger entries.
- The existing admin audit pattern records old/new currency, the optional reason, and that the wallet was unchanged.

## Currency Edit Behavior

- Admin partial updates accept `name`, `symbol`, `marketRate`, `platformRate`, `markupPercentage`, and `isActive`.
- Currency codes remain immutable through the update route.
- USD cannot be disabled or assigned a non-unit platform rate.
- Conversion cache entries are invalidated after updates.

## Product Price Fix

- Manual product updates persist matching `basePrice` and `finalPrice` values.
- A provider-linked product preserves a manual admin price when sync is false.
- Explicit sync pricing recomputes from the current provider price and markup.
- Customer catalog/detail pricing continues to derive future group pricing from the persisted product base price; old order snapshots are unchanged.

## Account Settings And Deposit Modal

- These are frontend-only fixes; no backend response-shape or deposit processing changes were required.

## Admin Customer Flow

- Admins may use self-service order create/list/detail and payment intent/list/detail endpoints.
- The same active-account, wallet balance, risk, currency, ownership, and order validation rules still apply.
- Order and payment audit actors retain the real `ADMIN` role.

## Security Notes

- No role mutation or admin privilege bypass was introduced.
- Customer endpoints remain ownership-scoped and do not expose admin-only product fields.
- Existing admin wallet adjustment authorization was not changed.
- Network International, webhook, reconciliation, provider fulfillment, and ledger business logic were not modified.

## Tests And Checks

- Added currency metadata/rate/status and cache invalidation coverage.
- Added admin user currency no-conversion/no-ledger and inactive-currency coverage.
- Added provider-linked manual price persistence through the customer product endpoint.
- Added admin purchase coverage using the normal wallet rules.
- Backend lint: passed (`196` JavaScript files).
- Backend full tests: passed (`28` suites, `731` tests) after all code changes.
- Backend diff check: passed.

## Limitations And Warnings

- Jest reports its existing forced-exit/open-handle advisory after a successful run.
- Git reports existing `safe.directory` and LF-to-CRLF warnings.
- Browser-based manual QA against a seeded live environment was not available in this workspace session.

## Completion Status

Implementation and automated verification are complete. Final production sign-off still requires the listed manual browser checks against seeded data.
