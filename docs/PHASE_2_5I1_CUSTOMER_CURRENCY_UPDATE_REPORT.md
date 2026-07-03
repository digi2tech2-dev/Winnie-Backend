# Phase 2.5I.1 Customer Currency Update Report

## Files changed

- `src/modules/users/user.service.js`
- `src/modules/me/me.controller.js`
- `src/modules/me/me.routes.js`
- `src/tests/meCurrency.test.js`
- `docs/BASELINE_ARCHITECTURE.md`
- `docs/PHASE_2_FEATURE_TODO.md`
- `docs/PHASE_2_5I1_CUSTOMER_CURRENCY_UPDATE_REPORT.md`

## Route added

- `PATCH /api/me/currency`

## Request shape

```json
{
  "currency": "EGP"
}
```

`currency` is required, trimmed, validated as a 3-letter ISO-style code, and normalized to uppercase.

## Response shape

```json
{
  "success": true,
  "message": "Currency updated.",
  "data": {
    "user": {},
    "currency": "EGP"
  }
}
```

The `user` payload is produced through the existing safe-user serialization path and does not expose password, token, or 2FA secret fields.

## Validation behavior

- Requires a valid authenticated user.
- Requires the account to be active through the existing `/api/me` route guards.
- Rejects missing or malformed currency values.
- Rejects unsupported or inactive currencies.
- Currency model has no deleted flag, so deleted-currency behavior is not applicable in the current schema.
- Re-saving the current currency is idempotent.

## Frontend behavior

The frontend customer settings page now saves selected active currencies through `PATCH /api/me/currency` and refreshes the current user/session after success.

## Tests/checks run

- Added `src/tests/meCurrency.test.js`.
- `npm.cmd run lint`: passed.
- `npm.cmd test -- --runInBand`: passed, 23 suites and 665 tests.
- `git diff --check`: passed.

## Remaining warnings

- Self-service currency update intentionally does not convert wallet balance or historical records.
- Customer can choose only currencies returned active by the backend.
- Jest printed existing console output from fulfillment/audit/order polling tests.
- Git printed the existing malformed `safe.directory` warning and LF-to-CRLF notices.

## Completion status

Phase 2.5I.1 backend implementation is complete.
