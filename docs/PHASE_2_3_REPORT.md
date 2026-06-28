# Phase 2.3 Referral Commission Report

## Scope

Phase 2.3 added a safe referral/invitation module. It did not implement real payment gateways, webhooks, group-change workflows, group-based referral rates, frontend compatibility routes, or referral reversal logic.

## Files Changed

Created:

- `src/modules/referrals/referral.constants.js`
- `src/modules/referrals/referral.model.js`
- `src/modules/referrals/referral.validation.js`
- `src/modules/referrals/referral.service.js`
- `src/modules/referrals/referral.controller.js`
- `src/modules/referrals/referral.routes.js`
- `src/tests/referral.test.js`
- `docs/REFERRALS_ARCHITECTURE.md`
- `docs/PHASE_2_3_REPORT.md`

Updated:

- `src/app.js`
- `src/modules/auth/auth.controller.js`
- `src/modules/auth/auth.service.js`
- `src/modules/auth/auth.validation.js`
- `src/modules/users/user.model.js`
- `src/modules/deposits/deposit.service.js`
- `src/modules/payments/payment.service.js`
- `src/modules/admin/setting.model.js`
- `src/modules/audit/audit.constants.js`
- `src/tests/testHelpers.js`
- `docs/BASELINE_ARCHITECTURE.md`
- `docs/LEDGER_ARCHITECTURE.md`
- `docs/PAYMENTS_ARCHITECTURE.md`
- `docs/PHASE_2_FEATURE_TODO.md`

## Referral Models Added

- `ReferralRelationship`
- `ReferralCommission`

Both include unique duplicate guards for the critical one-inviter and one-commission-per-source invariants.

## Routes Added

Customer/public:

- `GET /api/me/referrals`
- `GET /api/me/referrals/commissions`
- `POST /api/referrals/validate-code`

Admin:

- `GET /api/admin/referral-settings`
- `PATCH /api/admin/referral-settings`
- `GET /api/admin/referrals/relationships`
- `GET /api/admin/referrals/commissions`

## Registration Invite Behavior

Registration accepts optional `inviteCode` or `referralCode`.

- Valid code links the new user to the inviter.
- Invalid code rejects registration with `INVALID_REFERRAL_CODE`.
- Self-referral rejects with `SELF_REFERRAL_NOT_ALLOWED`.
- The new account remains `PENDING` and still requires existing verification/approval flow.

## Commission Trigger Behavior

Commission processing runs after successful eligible wallet credits:

- manual deposit approval: `DEPOSIT_APPROVED`
- mock/card payment success: `CARD_PAYMENT_SUCCESS`

Admin wallet adjustments, order debits, order refunds, pending deposits, rejected deposits, failed payments, and pending payments do not trigger commission.

## Wallet Ledger Behavior

Credited commission creates an inviter wallet transaction:

- `type: CREDIT`
- `semanticType: REFERRAL_COMMISSION`
- `sourceType: REFERRAL`
- `direction: CREDIT`
- `idempotencyKey: referral:<sourceWalletTransactionId>`

The `ReferralCommission.walletTransactionId` points to that wallet ledger entry.

## Idempotency Behavior

The referral processor is idempotent through:

- unique `ReferralCommission.idempotencyKey`
- unique `ReferralCommission.sourceWalletTransactionId`
- unique `WalletTransaction.idempotencyKey`
- a MongoDB transaction around commission creation and wallet credit

Calling the processor repeatedly for the same source wallet transaction does not double-credit.

## Settings Behavior

Settings are stored under the existing settings key `referrals` because dotted keys are not supported by the current schema.

Default:

- `enabled: true`
- `depositCommissionPercentage: 0`
- `applyTo: EVERY_ELIGIBLE_WALLET_CREDIT`
- `minSourceAmount: null`
- `maxCommissionAmount: null`

Admin can update settings. Customers cannot. Supervisor read access can use `referrals.view`; mutation remains admin-only.

## Notifications and Audit Behavior

Commission credit sends a safe wallet notification to the inviter. Audit logs cover:

- referral relationship created
- referral commission credited
- referral commission skipped
- referral settings updated

Notification and audit failures do not roll back the main wallet credit or duplicate commission.

## Tests Added

`src/tests/referral.test.js` covers:

- automatic referral code generation
- registration with valid invite code
- invalid invite rejection
- self-referral rejection
- one inviter per invited user
- admin settings read/update
- invalid percentage rejection
- customer settings mutation rejection
- deposit approval commission
- mock payment commission
- admin adjustment exclusion
- order debit/refund exclusion
- zero percentage skip
- disabled setting skip
- duplicate processing idempotency
- commission ledger semantic type/linkage
- own summary/history access
- customer commission endpoint ignoring another inviter id
- admin relationship/commission listing

## Remaining Warnings

- Referral reversal is reserved for future work.
- Group-based referral rates are not implemented.
- Existing users get referral codes lazily if they predate the field.
- Skipped commission records are intentionally idempotent and are not retried after settings change.
- Full Jest output remains noisy from existing fulfillment/polling/audit tests that intentionally exercise logged error paths.
- `git diff --check` emitted an unrelated malformed global `safe.directory` warning and CRLF normalization warnings, but returned success with no whitespace errors.

## Final Verification

| Check | Result |
| --- | --- |
| `npm.cmd run lint` | Passed. Syntax check passed for 173 JavaScript files. |
| `npm.cmd test -- --runInBand` | Passed. 20 test suites passed, 620 tests passed. |
| `git diff --check` | Passed. No whitespace errors. |

Phase 2.3 is complete.
