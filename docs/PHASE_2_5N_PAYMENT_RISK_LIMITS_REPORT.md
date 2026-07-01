# Phase 2.5N Payment Risk Limits Report

## Files changed

- `src/modules/payments/paymentRisk.config.js`
- `src/modules/payments/paymentRisk.service.js`
- `src/modules/payments/payment.service.js`
- `src/modules/admin/setting.model.js`
- `src/modules/admin/admin.settings.service.js`
- `src/modules/audit/audit.constants.js`
- `src/shared/errors/errorHandler.js`
- `src/tests/paymentRisk.test.js`
- `docs/PAYMENTS_ARCHITECTURE.md`
- `docs/BASELINE_ARCHITECTURE.md`
- `docs/PHASE_2_FEATURE_TODO.md`
- `docs/PHASE_2_5N_PAYMENT_RISK_LIMITS_REPORT.md`

## Settings key and shape

The setting key is `paymentRiskLimits`.

```json
{
  "enabled": true,
  "maxSingleAmount": 1000,
  "hourlyAmountLimit": 1000,
  "dailyAmountLimit": 1500,
  "hourlyAttemptLimit": 3,
  "dailyAttemptLimit": 5,
  "newAccountHours": 24,
  "newAccountSingleAmount": 100,
  "newAccountDailyAmount": 200,
  "action": "BLOCK_ONLINE_PAYMENT",
  "customerMessage": "Your online top-up limit has been reached. Please use manual deposit or contact support."
}
```

Admins can update `enabled`, amount limits, attempt limits, new-account limits, and `customerMessage`. The only accepted `action` is `BLOCK_ONLINE_PAYMENT`.

## Admin UI behavior

The paired frontend Settings page manages this key through the existing admin settings API. The backend remains the source of truth and validates the key-specific shape in `admin.settings.service.js` before saving.

## Risk checks implemented

- Disabled setting allows online payment intent creation.
- Max single online top-up amount.
- New-account max single amount.
- Rolling hourly amount limit.
- Rolling daily amount limit.
- New-account rolling daily amount limit.
- Rolling hourly attempt limit.
- Rolling daily attempt limit.

Hourly means the last rolling 60 minutes. Daily means the last rolling 24 hours.

## Amount basis

Limits are evaluated in USD equivalent using the existing platform currency conversion helper. New `Payment` records snapshot `metadata.risk.amountBaseCurrency` and `metadata.risk.baseCurrency`. Older payment records without a snapshot are converted using current platform rates.

## Enforcement point

`payment.service.js` enforces risk inside `createPaymentIntent` after payment/user/currency validation and before idempotency lookup, gateway adapter creation, gateway calls, or `Payment.create`.

## Customer blocked behavior

Blocked online top-ups throw `PAYMENT_RISK_LIMIT_REACHED` with safe customer text and `details.reason`. No checkout URL is returned.

## Manual deposit behavior

Manual deposits are unchanged. The payment risk service only reads `Payment` records and is not used by deposit request creation or admin approval.

## Risk logging / audit behavior

Blocked online attempts write `PAYMENT_RISK_BLOCKED` audit events with safe fields: user id, amount, currency, gateway, base-currency amount, reason code, matched limit, and action. Card data and gateway secrets are not logged.

## Tests added / updated

Added `src/tests/paymentRisk.test.js` covering below-limit success, max single amount, hourly/daily amount limits, hourly/daily attempt limits, new-account single limit, disabled settings, manual deposit availability, no gateway call on block, no wallet credit on block, safe 4xx-style error, and admin setting updates.

## Checks run

- `npm.cmd run lint`: passed.
- `npm.cmd test -- paymentRisk.test.js --runInBand`: passed.
- `npm.cmd test -- --runInBand`: passed, 26 suites and 688 tests.
- `git diff --check`: passed.

## Limitations

- Payment risk is enforced for online wallet top-up intent creation only.
- Existing historical payments without risk metadata are converted with current platform rates.
- Real gateway webhooks and real gateway success reconciliation remain outside this phase.

## Remaining warnings

- Admins should communicate live limit changes operationally because the setting applies immediately.
- Existing payment records created before Phase 2.5N do not have risk metadata snapshots.
- Jest prints existing expected console output from fulfillment/audit negative-path tests.
- Mongoose prints an existing duplicate schema index warning for `slug`.
- Git prints the workspace `safe.directory` warning and LF-to-CRLF notices during diff checks.

## Completion status

Phase 2.5N backend work is complete.
