# Payments Architecture

## Scope

Phase 2.2 added a safe base module for wallet top-up payments. Phase 2.5P adds Network International / N-Genius Hosted Payment Page order creation for wallet top-ups only. Phase 2.5P.1 adds Network gateway currency conversion so customers can request top-ups in their wallet currency while the hosted payment order is charged in the configured Network outlet currency. The module does not collect card data, trust redirect returns for wallet credit, or change order payment behavior.

Current scope:

- Wallet top-up only.
- Mock gateway operational for non-production testing.
- Network International Hosted Payment Page operational for online wallet top-up order creation.
- Network gateway orders use `NETWORK_INTERNATIONAL_CURRENCY` for provider charge currency while `Payment.amount` and `Payment.currency` preserve the requested wallet top-up amount.
- Ziina and Tap Payments adapters are placeholders.
- Wallet credit only happens after a controlled mock success confirmation in non-production environments or after authenticated Network status sync verifies an authoritative successful provider state.

Out of scope:

- Direct order payment.
- Direct card entry in this frontend/backend.
- Production webhook processing until the Network portal webhook/header contract is finalized.
- Card number, CVV, or sensitive card data collection/storage.
- Referral commission policy/calculation inside the payments module.
- Group-change or sub-agent workflows.
- Gateway FX markup, settlement accounting, or reconciliation dashboards.

## Module Layout

`src/modules/payments/`

- `payment.constants.js`: purposes, gateways, methods, statuses, transitions.
- `payment.model.js`: wallet top-up payment intent model.
- `payment.validation.js`: request validation.
- `payment.service.js`: payment state machine, mock confirmation/failure, Network status sync, wallet credit.
- `paymentRisk.config.js`: default `paymentRiskLimits` setting shape and validation.
- `paymentRisk.service.js`: rolling-window risk evaluation before gateway intent creation.
- `payment.controller.js`: customer/admin response handling.
- `payment.routes.js`: `/api/payments` customer/dev routes.
- `gateways/`: mock gateway, Network International Hosted Payment Page adapter, and remaining real-gateway placeholders.

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

For Network payments, `amount`, `feeAmount`, `totalAmount`, and `currency` remain the customer requested wallet top-up values. The provider charge is stored as a safe snapshot under `metadata.gatewayCurrencyConversion`, for example:

```json
{
  "requestedAmount": 100,
  "requestedCurrency": "EGP",
  "gatewayAmount": 7.34,
  "gatewayCurrency": "AED",
  "exchangeRate": 0.0734,
  "exchangeRateSource": "PLATFORM_CURRENCY_RATES_VIA_USD",
  "requestedAmountUsd": 2,
  "requestedCurrencyRate": 50,
  "gatewayCurrencyRate": 3.67,
  "convertedAt": "2026-07-02T00:00:00.000Z"
}
```

Customer responses expose only safe charge fields (`requestedAmount`, `requestedCurrency`, `gatewayAmount`, `gatewayCurrency`, `exchangeRate`, and `exchangeRateSource`) and do not expose raw provider payloads or secrets.

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

Mock success confirmation and verified Network status sync call the wallet service with:

- legacy `type`: `CREDIT`
- `semanticType`: `CARD_PAYMENT_SUCCESS`
- `sourceType`: `PAYMENT`
- `sourceId`: payment id
- `direction`: `CREDIT`
- `idempotencyKey`: `payment:<paymentId>:wallet-credit`

Mock failure does not create a wallet ledger entry because no money moved.

For Network payments, wallet credit uses the intended `Payment.amount` and `Payment.currency` values that were validated at intent creation. Gateway charge fields are an authorization/checkout snapshot only; the wallet is not credited in AED merely because the Network outlet charged AED.

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

## Network Gateway Currency Conversion

Phase 2.5P.1 lets Network wallet top-ups accept any active platform/customer currency that can be converted through the existing platform currency-rate helpers.

Conversion flow:

1. Validate the requested wallet currency through the existing payment currency checks.
2. Run Phase 2.5N risk limits against the requested top-up amount; risk conversion continues to use USD equivalent snapshots.
3. Resolve `NETWORK_INTERNATIONAL_CURRENCY` as the gateway charge currency.
4. Validate the gateway currency is available in platform currency data.
5. Convert requested amount to USD with `convertUserCurrencyToUsd`, then USD to gateway currency with `convertUsdToUserCurrency`.
6. Round the gateway charge amount to two decimal places before converting to Network minor units.
7. Store `metadata.gatewayCurrencyConversion` before returning the hosted checkout URL.

When requested currency and gateway currency match, the conversion snapshot uses `exchangeRate: 1` and `exchangeRateSource: "SAME_CURRENCY"` after validating the currency rate exists. Cross-currency snapshots use `exchangeRateSource: "PLATFORM_CURRENCY_RATES_VIA_USD"`.

If the requested or gateway currency rate is missing/inactive, the backend returns:

```json
{
  "success": false,
  "code": "PAYMENT_CURRENCY_CONVERSION_UNAVAILABLE",
  "message": "Online card payment is temporarily unavailable for this currency. Please try another currency or use manual deposit."
}
```

The frontend displays the backend-returned requested amount and gateway charge before redirect. It does not calculate exchange rates locally.

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

Status sync route:

- `POST /api/payments/:id/sync-status`

This route is authenticated and owner/admin restricted. It re-fetches the provider status through the gateway adapter before applying terminal status changes. For Network, wallet credit is only attempted when the provider state maps to `SUCCEEDED` (`PURCHASED`, `CAPTURED`, `SUCCESS`, or `SUCCESSFUL`). The credit path is idempotent through `creditedAt`, `walletTransactionId`, and the wallet ledger idempotency key.

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
- `NETWORK_INTERNATIONAL`

Placeholders only:

- `ZIINA`
- `TAP`

The Network adapter uses the Hosted Payment Page redirect flow:

1. Requests an access token from `POST {baseUrl}/identity/auth/access-token` with `Authorization: Basic <service-account-api-key>`.
2. Creates an order at `POST {baseUrl}/transactions/outlets/{outletRef}/orders` with `action: SALE`, configured gateway-currency minor units, merchant order reference, and configured return/cancel URLs.
3. Stores the provider order id/reference and hosted checkout URL on `Payment`.
4. Leaves the payment in `REQUIRES_ACTION`; creation never marks a real gateway payment successful.
5. Fetches order status through the same token flow for status sync.

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
NETWORK_INTERNATIONAL_ENABLED=false
NETWORK_INTERNATIONAL_ENV=sandbox
NETWORK_INTERNATIONAL_BASE_URL=
NETWORK_INTERNATIONAL_API_KEY=
NETWORK_INTERNATIONAL_OUTLET_REF=
NETWORK_INTERNATIONAL_CURRENCY=AED
NETWORK_INTERNATIONAL_RETURN_URL=http://localhost:5173/payment/success
NETWORK_INTERNATIONAL_CANCEL_URL=http://localhost:5173/payment/cancel
NETWORK_INTERNATIONAL_WEBHOOK_SECRET=
ZIINA_API_KEY=
TAP_SECRET_KEY=
```

Network env is validated only when `NETWORK_INTERNATIONAL` is selected/enabled. If `NETWORK_INTERNATIONAL_BASE_URL` is empty, the adapter defaults to `https://api-gateway.ngenius-payments.com` for `live` and `https://api-gateway.sandbox.ngenius-payments.com` otherwise.

## Security Notes

- No card numbers, CVV, or sensitive card data are stored.
- Gateway secrets must not be committed or logged.
- Customer responses omit internal metadata, IP, user agent, and idempotency keys.
- Browser return URLs are never trusted for wallet credit.
- Mock success/failure endpoints are blocked when `NODE_ENV=production`.
- Online payment risk limits are enforced server-side before gateway/payment intent creation.
- A blocked risk check prevents Network token/order HTTP calls.
- Manual deposit remains available when online payment risk limits block a customer.
- Network currency conversion happens on the backend with platform rates; the frontend only displays returned safe charge fields.
- Network API key, access token, outlet reference, and raw provider error bodies are not exposed to customer responses.
- Network webhooks must be implemented with signature/custom-header verification and replay protection after the merchant portal contract is finalized.

## Future Reserved Work

- Verified Network webhook processing.
- Gateway-specific event persistence.
- Payment reconciliation tooling.
- Gateway fees, FX markup, and settlement reconciliation rules.
- Admin payment operations beyond read-only inspection.
