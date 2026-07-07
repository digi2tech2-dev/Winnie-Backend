# Payments Architecture

## Scope

Phase 2.2 added a safe base module for wallet top-up payments. Phase 2.5P adds Network International / N-Genius Hosted Payment Page order creation for wallet top-ups only. Phase 2.5P.1 adds Network gateway currency conversion so customers can request top-ups in their wallet currency while the hosted payment order is charged in the configured Network outlet currency. Phase 2.5Q adds Network webhook intake and admin reconciliation. Phase 2.5S connects the admin list/detail/reconciliation backend routes to a safe Admin Payments UI. Phase 2.5W adds Paymento hosted USDT wallet top-ups. The module does not collect card data, crypto private keys, trust redirect returns for wallet credit, or change order payment behavior.

Current scope:

- Wallet top-up only.
- Mock gateway operational for non-production testing.
- Network International Hosted Payment Page operational for online wallet top-up order creation.
- Network gateway orders use `NETWORK_INTERNATIONAL_CURRENCY` for provider charge currency while `Payment.amount` and `Payment.currency` preserve the requested wallet top-up amount.
- Network webhook events are accepted at `POST /api/webhooks/payments/network`, persisted with safe summaries, deduplicated, and processed only after re-fetching authoritative Network status.
- Paymento hosted USDT checkout is operational for wallet top-up order creation when `PAYMENTO` is enabled and allowed.
- Paymento requests use `PAYMENTO_FIAT_CURRENCY` for provider charge currency while `Payment.amount` and `Payment.currency` preserve the requested wallet top-up amount.
- Paymento IPN/webhook events are accepted at `POST /api/webhooks/payments/paymento`, verified with HMAC SHA-256 when `PAYMENTO_IPN_SECRET` is configured, safely persisted, deduplicated, and processed only after re-fetching authoritative Paymento status.
- Admins/supervisors with `payments.view` can list payments, inspect safe payment details, and trigger reconciliation through `/api/admin/payments`.
- Ziina and Tap Payments adapters are placeholders.
- Wallet credit only happens after a controlled mock success confirmation in non-production environments, authenticated/admin provider status sync, or webhook processing that re-fetches and verifies an authoritative successful provider state.

Out of scope:

- Direct order payment.
- Direct card entry in this frontend/backend.
- Network signature verification beyond shared-header secret mode until the Network portal webhook/signature contract is finalized.
- Card number, CVV, or sensitive card data collection/storage.
- Crypto wallet private-key, seed phrase, or address custody.
- Referral commission policy/calculation inside the payments module.
- Group-change or sub-agent workflows.
- Gateway FX markup, settlement accounting, or settlement analytics dashboards.

## Module Layout

`src/modules/payments/`

- `payment.constants.js`: purposes, gateways, methods, statuses, transitions.
- `payment.model.js`: wallet top-up payment intent model.
- `payment.validation.js`: request validation.
- `payment.service.js`: payment state machine, mock confirmation/failure, provider status sync, wallet credit.
- `paymentRisk.config.js`: default `paymentRiskLimits` setting shape and validation.
- `paymentRisk.service.js`: rolling-window risk evaluation before gateway intent creation.
- `payment.controller.js`: customer/admin response handling.
- `payment.routes.js`: `/api/payments` customer/dev routes.
- `payment.webhook.routes.js`: unauthenticated Network and Paymento webhook routes.
- `payment.webhook.service.js`: shared-header/HMAC verification, event persistence, dedupe, payment resolution, provider re-fetch, and webhook audit.
- `paymentWebhookEvent.model.js`: safe webhook event persistence.
- `gateways/`: mock gateway, Network International Hosted Payment Page adapter, Paymento hosted USDT adapter, and remaining real-gateway placeholders.

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

For Network and Paymento payments, `amount`, `feeAmount`, `totalAmount`, and `currency` remain the customer requested wallet top-up values. The provider charge is stored as a safe snapshot under `metadata.gatewayCurrencyConversion`, for example:

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
- Hosted checkout payments may move from `REQUIRES_ACTION` to `PENDING` when a provider reports partial payment or waiting-for-confirmation status. This still never credits the wallet.

## Wallet Credit

Mock success confirmation and verified provider status sync call the wallet service with:

- legacy `type`: `CREDIT`
- `semanticType`: `CARD_PAYMENT_SUCCESS`
- `sourceType`: `PAYMENT`
- `sourceId`: payment id
- `direction`: `CREDIT`
- `idempotencyKey`: `payment:<paymentId>:wallet-credit`

Mock failure does not create a wallet ledger entry because no money moved.

For Network and Paymento payments, wallet credit uses the intended `Payment.amount` and `Payment.currency` values that were validated at intent creation. Gateway charge fields are an authorization/checkout snapshot only; the wallet is not credited in the gateway fiat amount merely because the provider charged that amount.

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

## Network Webhooks And Reconciliation

Phase 2.5Q adds Network webhook intake:

- `POST /api/webhooks/payments/network`

The route is intentionally unauthenticated because provider webhooks do not carry user JWTs. If `NETWORK_INTERNATIONAL_WEBHOOK_SECRET` is configured, the route requires a matching shared secret header. The header name is `NETWORK_INTERNATIONAL_WEBHOOK_SECRET_HEADER` or `x-network-webhook-secret` by default. Comparison uses timing-safe equality. If the secret is not configured, the route accepts events in documented unverified mode but still never trusts the payload for wallet credit.

Webhook events are stored in `PaymentWebhookEvent` with:

- `provider`
- `eventId`
- `dedupeKey`
- `paymentId`
- `gatewayPaymentId`
- `gatewayReference`
- `orderReference`
- `eventType`
- `providerStatus`
- `status`
- `processingStatus`
- safe `httpHeaders`
- `payloadHash`
- safe `payloadSummary`
- `attempts`
- `receivedAt`
- `lastReceivedAt`
- `processedAt`
- safe `errorCode` / `errorMessage`

The full raw payload is not stored. The summary intentionally keeps only extracted identifiers/status/amount fields and payload key names after sensitive-key redaction. Authorization headers, webhook secret headers, card/PAN/CVV/expiry fields, access tokens, API keys, and raw provider headers are not stored.

Dedupe key order:

1. Network event id when present.
2. Order/reference + event type + status + timestamp when present.
3. Payload hash fallback.

Duplicate events increment `attempts`, update `lastReceivedAt`, write a safe audit event, and do not re-run wallet credit.

Payment resolution uses internal merchant order reference/payment id, `gatewayPaymentId`, `gatewayReference`, and stored Network order metadata. If no payment is matched, the event is stored as `UNMATCHED` and no gateway fetch or wallet credit occurs.

For matched payments, webhook processing calls the same authoritative Network status sync path used by `POST /api/payments/:id/sync-status`. The webhook payload can trigger verification but cannot mark success by itself. Successful provider states credit the wallet once through the existing payment credit path; failed/canceled/expired states update the payment without credit.

Admin reconciliation route:

- `POST /api/admin/payments/:id/sync-status`

Admins and supervisors with `payments.view` can trigger the same authoritative status sync. Customers can still sync only their own payment through `POST /api/payments/:id/sync-status`.

## Paymento USDT Gateway

Phase 2.5W adds Paymento hosted USDT wallet top-ups:

- `PAYMENTO` is an operational gateway adapter.
- Customers select Paymento only through backend-configured payment methods.
- `POST /api/payments/intents` validates payments enabled, gateway allow-list, amount, currency, user wallet currency, and payment risk limits before any Paymento HTTP call.
- The backend converts the requested wallet top-up amount to `PAYMENTO_FIAT_CURRENCY` through the existing platform currency converter. No crypto or fiat exchange rate is calculated in the frontend.
- The Paymento adapter creates a hosted checkout request with the Paymento `Api-key` header and strict merchant body fields: `fiatAmount`, `fiatCurrency`, `ReturnUrl`, `orderId`, `Speed`, and safe `additionalData`.
- If Paymento returns a token instead of a checkout URL, the backend builds `https://app.paymento.io/gateway?token=<token>` and stores the token as the provider payment id for verify/status calls.
- The adapter stores only safe identifiers, checkout URL, fiat charge snapshot, requested wallet amount snapshot, and allowed crypto preference.
- `Payment.amount` and `Payment.currency` remain the wallet top-up amount/currency used for eventual wallet credit.
- Customer/admin serialized payment responses expose safe charge fields and provider references only. `PAYMENTO_API_KEY`, `PAYMENTO_IPN_SECRET`, raw provider payloads, signatures, and authorization headers are not exposed.

Paymento webhook/IPN route:

- `POST /api/webhooks/payments/paymento`

The route is unauthenticated because provider callbacks do not carry user JWTs. If `PAYMENTO_IPN_SECRET` is configured, the backend requires an HMAC SHA-256 signature in one of the supported Paymento signature headers (`x-paymento-signature`, `x-paymento-hmac-sha256`, `x-signature`, or `signature`). Verification uses the raw request body captured by Express JSON/urlencoded middleware. If no secret is configured, events are accepted in unverified mode but still cannot credit the wallet without an authoritative Paymento verify/status call.

Paymento status mapping:

```txt
Initialize / 0        -> INITIATED
Pending / 1           -> PENDING
PartialPaid / 2       -> PENDING
WaitingToConfirm / 3  -> PENDING
Timeout / 4           -> EXPIRED
UserCanceled / 5      -> CANCELED
Paid / 7              -> SUCCEEDED
Approve / 8           -> SUCCEEDED
Reject / 9            -> FAILED
```

Wallet credit is allowed only after Paymento verify/status returns an authoritative success status (`Paid`, `Approve`, or equivalent success aliases handled by the adapter). Webhook payload status alone, browser return pages, partial paid, pending, waiting confirmation, timeout, canceled, rejected, unmatched, or failed verification never credit the wallet.

Paymento admin reconciliation uses the existing route:

- `POST /api/admin/payments/:id/sync-status`

The route re-fetches Paymento status server-side, updates local status through the shared payment state machine, and credits exactly once only on verified success.

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

This route is authenticated and owner/admin restricted. It re-fetches the provider status through the gateway adapter before applying terminal status changes. For Network and Paymento, wallet credit is only attempted when the provider state maps to `SUCCEEDED`. The credit path is idempotent through `creditedAt`, `walletTransactionId`, and the wallet ledger idempotency key.

Webhook route:

- `POST /api/webhooks/payments/network`
- `POST /api/webhooks/payments/paymento`

Admin reconciliation route:

- `POST /api/admin/payments/:id/sync-status`

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
- `PAYMENTO`

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

The Paymento adapter uses a hosted USDT checkout flow:

1. Builds return/cancel/pending URLs with `paymentId`.
2. Creates a server-side Paymento payment request at `PAYMENTO_CREATE_PATH` using `Api-key`, `fiatAmount`, `fiatCurrency`, `ReturnUrl`, `orderId`, `Speed`, and safe `additionalData`.
3. Converts a Paymento token response into `https://app.paymento.io/gateway?token=<token>`.
4. Stores the provider payment id/reference and hosted checkout URL on `Payment`.
5. Leaves the payment in `REQUIRES_ACTION`; creation never marks Paymento payments successful.
6. Fetches Paymento status through the configured verify/status endpoint with `{ "token": "<stored-paymento-token>" }` for customer return sync, admin reconciliation, and webhook processing.

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
NETWORK_INTERNATIONAL_WEBHOOK_SECRET_HEADER=x-network-webhook-secret
PAYMENTO_ENABLED=false
PAYMENTO_API_BASE_URL=https://api.paymento.io
PAYMENTO_API_KEY=
PAYMENTO_IPN_SECRET=
PAYMENTO_RETURN_URL=http://localhost:5173/payment/success
PAYMENTO_CANCEL_URL=http://localhost:5173/payment/cancel
PAYMENTO_PENDING_URL=http://localhost:5173/payment/pending
PAYMENTO_IPN_URL=http://localhost:5000/api/webhooks/payments/paymento
PAYMENTO_FIAT_CURRENCY=USD
PAYMENTO_ALLOWED_CRYPTO=USDT
PAYMENTO_RISK_SPEED=1
PAYMENTO_CREATE_PATH=/v1/payment/request
PAYMENTO_VERIFY_PATH=/v1/payment/verify
ZIINA_API_KEY=
TAP_SECRET_KEY=
```

Network env is validated only when `NETWORK_INTERNATIONAL` is selected/enabled. If `NETWORK_INTERNATIONAL_BASE_URL` is empty, the adapter defaults to `https://api-gateway.ngenius-payments.com` for `live` and `https://api-gateway.sandbox.ngenius-payments.com` otherwise.

Paymento env is validated only when `PAYMENTO` is selected/enabled. `PAYMENTO_API_KEY` and `PAYMENTO_IPN_SECRET` are backend-only secrets. `PAYMENTO_CREATE_PATH` defaults to `/v1/payment/request`; `PAYMENTO_VERIFY_PATH` defaults to `/v1/payment/verify`. `PAYMENTO_IPN_URL` is configured in the Paymento dashboard/settings unless the merchant API explicitly supports create-time IPN URLs.

## Security Notes

- No card numbers, CVV, or sensitive card data are stored.
- No crypto private keys, seed phrases, or custodial wallet secrets are collected or stored.
- Gateway secrets must not be committed or logged.
- Customer responses omit internal metadata, IP, user agent, and idempotency keys.
- Browser return URLs are never trusted for wallet credit.
- Mock success/failure endpoints are blocked when `NODE_ENV=production`.
- Online payment risk limits are enforced server-side before gateway/payment intent creation.
- A blocked risk check prevents Network token/order HTTP calls.
- Manual deposit remains available when online payment risk limits block a customer.
- Network currency conversion happens on the backend with platform rates; the frontend only displays returned safe charge fields.
- Network webhook payloads never credit the wallet directly; they only trigger backend provider re-fetch.
- Network API key, access token, outlet reference, and raw provider error bodies are not exposed to customer responses.
- Paymento webhook/IPN payloads never credit the wallet directly; they only trigger backend Paymento verify/status re-fetch.
- Paymento API key, IPN secret, raw provider payloads, raw signatures, and authorization headers are not exposed to customer/admin responses.
- Browser success/cancel/pending pages remain informational and display credited success only when backend sync returns `SUCCEEDED` with `creditedAt`.
- Production should configure `NETWORK_INTERNATIONAL_WEBHOOK_SECRET` and confirm the Network portal header/signature contract before relying on webhook delivery.

## Future Reserved Work

- Gateway-specific webhook signature verification if Network provides a signed payload contract.
- Payment reconciliation tooling.
- Gateway fees, FX markup, and settlement reconciliation rules.
- Admin payment operations beyond read-only inspection.
