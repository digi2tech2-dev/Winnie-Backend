# Referrals Architecture

## Scope

Phase 2.3 adds a safe referral and invitation commission module. It does not add real payment gateways, payment webhooks, frontend compatibility routes, group-based referral rates, or referral reversal logic.

## Business Rules

- Every user gets a stable unique `referralCode`.
- A new user may register with `inviteCode` or `referralCode`.
- Valid codes create one active inviter relationship.
- Invalid codes reject registration with `INVALID_REFERRAL_CODE`.
- Self-referral rejects with `SELF_REFERRAL_NOT_ALLOWED`.
- One invited user can have only one inviter.
- Commissions apply to every eligible successful wallet credit while settings allow it.
- Eligible sources are `DEPOSIT_APPROVED` and `CARD_PAYMENT_SUCCESS`.
- Admin adjustments, order debits, and order refunds do not trigger commission.
- Reversal is reserved for a future phase.

## Module Layout

`src/modules/referrals/`

- `referral.constants.js`: statuses, settings defaults, eligible source mapping.
- `referral.model.js`: `ReferralRelationship` and `ReferralCommission`.
- `referral.validation.js`: request validation.
- `referral.service.js`: code generation, relationship creation, settings, commission processing.
- `referral.controller.js`: HTTP response handling.
- `referral.routes.js`: public, customer, and admin routes.

## Models

`ReferralRelationship`

- `inviterUserId`
- `invitedUserId`
- `referralCode`
- `status`: `ACTIVE`, `CANCELED`, `BLOCKED`
- `registeredAt`
- `metadata`

Indexes include unique `invitedUserId`, `inviterUserId + createdAt`, and `referralCode`.

`ReferralCommission`

- `inviterUserId`
- `invitedUserId`
- `sourceWalletTransactionId`
- `sourceType`: `DEPOSIT` or `PAYMENT`
- `sourceId`
- `sourceSemanticType`
- `sourceAmount`
- `sourceCurrency`
- `commissionPercentage`
- `commissionAmount`
- `commissionCurrency`
- `walletTransactionId`
- `status`: `CREDITED`, `SKIPPED`, `REVERSED`
- `idempotencyKey`
- `metadata`
- `creditedAt`
- `reversedAt`

Indexes include unique `idempotencyKey`, unique `sourceWalletTransactionId`, inviter history, invited history, and status history.

## Settings

The existing `Setting.key` schema does not allow dotted keys. Phase 2.3 stores the logical referral settings in one `referrals` setting document:

```json
{
  "enabled": true,
  "depositCommissionPercentage": 0,
  "applyTo": "EVERY_ELIGIBLE_WALLET_CREDIT",
  "minSourceAmount": null,
  "maxCommissionAmount": null
}
```

Default percentage is `0`, so relationships can exist without crediting commission.

Admin routes:

- `GET /api/admin/referral-settings`
- `PATCH /api/admin/referral-settings`

Settings mutation is admin-only. Supervisor read access can use `referrals.view`.

## Customer Routes

- `GET /api/me/referrals`
- `GET /api/me/referrals/commissions`
- `POST /api/referrals/validate-code`

The summary endpoint lazily generates a referral code for older users that do not have one.

## Commission Triggers

The referral service is called after these wallet credits succeed:

- deposit approval wallet transaction with `semanticType: DEPOSIT_APPROVED`
- mock/card payment wallet transaction with `semanticType: CARD_PAYMENT_SUCCESS`

The trigger ignores all other wallet transactions.

## Wallet Ledger Behavior

Credited commission creates a wallet transaction for the inviter:

- legacy `type`: `CREDIT`
- `semanticType`: `REFERRAL_COMMISSION`
- `sourceType`: `REFERRAL`
- `sourceId`: referral commission id
- `direction`: `CREDIT`
- `idempotencyKey`: `referral:<sourceWalletTransactionId>`

Metadata includes invited user id, source type/id, source amount/currency, and percentage.

## Idempotency

Processing the same source wallet transaction more than once creates at most:

- one `ReferralCommission`
- one `REFERRAL_COMMISSION` wallet transaction
- one inviter wallet balance credit

The duplicate guards are:

- unique `ReferralCommission.idempotencyKey`
- unique `ReferralCommission.sourceWalletTransactionId`
- unique `WalletTransaction.idempotencyKey`
- a MongoDB transaction around commission creation and wallet credit

Skipped records are also idempotent, so a credit that happened while referrals were disabled or percentage was zero is not paid later by retrying.

## Currency

If inviter and source wallet currencies match, commission is credited directly. If they differ, Phase 2.3 uses the existing platform currency converter through USD. If conversion is unavailable, the commission is recorded as `SKIPPED` and the main wallet credit remains successful.

## Notifications and Audit

Credited commission sends a safe wallet notification to the inviter. Relationship creation, commission credited/skipped, and settings changes write audit logs through the existing safe audit service.

Notification and audit failures never roll back or double-credit wallet balances.

## Limitations

- No group-based referral rates.
- No referral reversal or clawback.
- No frontend compatibility aliases beyond the canonical routes.
- No fraud scoring beyond self-referral, one-inviter, and idempotency guards.
