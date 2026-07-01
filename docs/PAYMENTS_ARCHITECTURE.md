# Payments Architecture

## Scope

Phase 2.2 adds a safe base module for wallet top-up payments. It does not integrate a real payment gateway, process webhooks, store card data, or change order payment behavior.

Current scope:

- Wallet top-up only.
- Mock gateway only operational.
- Network International, Ziina, and Tap Payments adapters are placeholders.
- Wallet credit only happens after a controlled mock success confirmation in non-production environments.

Out of scope:

- Direct order payment.
- Real gateway API calls.
- Production webhooks.
- Card number, CVV, or sensitive card data collection/storage.
- Referral commission policy/calculation inside the payments module.
- Group-change or sub-agent workflows.

## Module Layout

`src/modules/payments/`

- `payment.constants.js`: purposes, gateways, methods, statuses, transitions.
- `payment.model.js`: wallet top-up payment intent model.
- `payment.validation.js`: request validation.
- `payment.service.js`: payment state machine, mock confirmation/failure, wallet credit.
- `paymentRisk.config.js`: default `paymentRiskLimits` setting shape and validation.
- `paymentRisk.service.js`: rolling-window risk evaluation before gateway intent creation.
- `payment.controller.js`: customer/admin response handling.
- `payment.routes.js`: `/api/payments` customer/dev routes.
- `gateways/`: mock gateway plus real-gateway placeholders.

## Payment Model

The `Payment` model stores:

- `userId`
- `purpose`
- `gateway`
- `method`
- `amount`
- `feeAmount`
- `totalAmount`
- `currency`
- `status`
- `gatewayPaymentId`
- `gatewayReference`
- `checkoutUrl`
- `returnUrl`
- `cancelUrl`
- `expiresAt`
- `succeededAt`
- `failedAt`
- `canceledAt`
- `creditedAt`
- `walletTransactionId`
- `idempotencyKey`
- `metadata`
- `createdByIp`
- `userAgent`

Indexes:

- `userId + createdAt`
- `status + createdAt`
- unique partial `gateway + gatewayPaymentId`
- unique partial `idempotencyKey`
- `walletTransactionId`

## Status Machine

Statuses:

- `INITIATED`
- `PENDING`
- `REQUIRES_ACTION`
- `SUCCEEDED`
- `FAILED`
- `CANCELED`
- `EXPIRED`

Credit rules:

- `INITIATED`, `PENDING`, and `REQUIRES_ACTION` never credit the wallet.
- `SUCCEEDED` can credit the wallet once.
- `FAILED`, `CANCELED`, and `EXPIRED` never credit the wallet.
- A succeeded payment cannot be failed later in Phase 2.2.
- A credited payment cannot be credited again.

## Wallet Credit

Mock success confirmation calls the wallet service with:

- legacy `type`: `CREDIT`
- `semanticType`: `CARD_PAYMENT_SUCCESS`
- `sourceType`: `PAYMENT`
- `sourceId`: payment id
- `direction`: `CREDIT`
- `idempotencyKey`: `payment:<paymentId>:wallet-credit`

Mock failure does not create a wallet ledger entry because no money moved.

After a successful wallet credit commits, Phase 2.3 calls the referral processor with the resulting wallet transaction. If the user has an active inviter and referral settings allow commission, the referral module may create a separate `REFERRAL_COMMISSION` wallet credit for the inviter. Payment failure and pending states never trigger referral commission.

## Idempotency

Payment creation accepts an optional `Idempotency-Key` header or `idempotencyKey` body field. If the same user repeats a create request with the same key, the existing payment is returned.

Payment risk limits are evaluated before the idempotency lookup and before gateway adapter creation. A blocked request returns a 4xx operational error and does not return an existing checkout URL.

Mock success confirmation is protected by:

- payment `status`
- `creditedAt`
- `walletTransactionId`
- the wallet ledger idempotency key
- a MongoDB transaction/session around payment update and wallet credit

Calling mock confirm twice returns the already credited payment and does not double-credit the wallet.

## Payment Risk Limits

Phase 2.5N adds admin-configurable online payment risk limits under the `paymentRiskLimits` setting. The backend evaluates these limits inside `POST /api/payments/intents` after request/user/currency validation and before any gateway adapter is created or called.

Setting shape:

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

Amount limits are evaluated in USD equivalent using the existing `convertUserCurrencyToUsd` platform-rate helper. New payment records snapshot `metadata.risk.amountBaseCurrency` and `metadata.risk.baseCurrency` so future rolling sums can reuse the evaluated amount. Older payment records without that snapshot are converted with the current platform rate when the risk check runs.

Implemented checks:

- Max single online top-up amount.
- New-account max single amount when `accountAgeHours < newAccountHours`.
- Rolling hourly amount limit, where hourly means the last 60 minutes.
- Rolling daily amount limit, where daily means the last 24 hours.
- New-account rolling daily amount limit.
- Rolling hourly attempt limit.
- Rolling daily attempt limit.

Risk checks count existing `Payment` records for the same user and `WALLET_TOPUP` purpose. Manual deposits are not counted and are not blocked by this setting.

Blocked response contract:

```json
{
  "success": false,
  "code": "PAYMENT_RISK_LIMIT_REACHED",
  "message": "Your online top-up limit has been reached. Please use manual deposit or contact support.",
  "details": {
    "reason": "DAILY_AMOUNT_LIMIT"
  }
}
```

Blocked requests do not create a `Payment` record, do not call a gateway adapter, and do not credit the wallet. The backend writes a safe `PAYMENT_RISK_BLOCKED` audit event with user id, amount, currency, gateway, reason code, matched limit, action, and base-currency amount. Card data and gateway secrets are never logged.

## Routes

Customer routes:

- `POST /api/payments/intents`
- `GET /api/payments`
- `GET /api/payments/:id`

Development/test-only mock routes:

- `POST /api/payments/:id/mock-confirm`
- `POST /api/payments/:id/mock-fail`

Admin read routes:

- `GET /api/admin/payments`
- `GET /api/admin/payments/:id`

Supervisor access requires `payments.view`. Admins bypass permission checks.

## Gateway Adapters

Operational now:

- `MOCK`

Placeholders only:

- `NETWORK_INTERNATIONAL`
- `ZIINA`
- `TAP`

Placeholder adapters throw `PAYMENT_GATEWAY_NOT_IMPLEMENTED` for operations and do not call external APIs.

## Environment

Safe defaults:

```env
PAYMENTS_ENABLED=true
PAYMENT_DEFAULT_GATEWAY=MOCK
PAYMENT_ALLOWED_GATEWAYS=MOCK
PAYMENT_MIN_AMOUNT=1
PAYMENT_MAX_AMOUNT=10000
MOCK_PAYMENT_CHECKOUT_BASE_URL=http://localhost:5173/mock-payment
NETWORK_INTERNATIONAL_MERCHANT_ID=
NETWORK_INTERNATIONAL_API_KEY=
ZIINA_API_KEY=
TAP_SECRET_KEY=
```

Future gateway credentials are optional placeholders and are not required for startup.

## Security Notes

- No card numbers, CVV, or sensitive card data are stored.
- Gateway secrets must not be committed or logged.
- Customer responses omit internal metadata, IP, user agent, and idempotency keys.
- Browser return URLs are never trusted for wallet credit.
- Mock success/failure endpoints are blocked when `NODE_ENV=production`.
- Online payment risk limits are enforced server-side before gateway/payment intent creation.
- Manual deposit remains available when online payment risk limits block a customer.
- Real webhooks must be implemented with signature verification and replay protection in a future phase.

## Future Reserved Work

- Real gateway SDK/API integration.
- Hosted checkout/webview return handling.
- Verified payment webhooks.
- Gateway-specific event persistence.
- Payment reconciliation tooling.
- Gateway fees and settlement currency rules.
- Admin payment operations beyond read-only inspection.
