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
- Referral commissions.
- Group-change or sub-agent workflows.

## Module Layout

`src/modules/payments/`

- `payment.constants.js`: purposes, gateways, methods, statuses, transitions.
- `payment.model.js`: wallet top-up payment intent model.
- `payment.validation.js`: request validation.
- `payment.service.js`: payment state machine, mock confirmation/failure, wallet credit.
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

## Idempotency

Payment creation accepts an optional `Idempotency-Key` header or `idempotencyKey` body field. If the same user repeats a create request with the same key, the existing payment is returned.

Mock success confirmation is protected by:

- payment `status`
- `creditedAt`
- `walletTransactionId`
- the wallet ledger idempotency key
- a MongoDB transaction/session around payment update and wallet credit

Calling mock confirm twice returns the already credited payment and does not double-credit the wallet.

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
- Real webhooks must be implemented with signature verification and replay protection in a future phase.

## Phase 2.3 Reserved Work

- Real gateway SDK/API integration.
- Hosted checkout/webview return handling.
- Verified payment webhooks.
- Gateway-specific event persistence.
- Payment reconciliation tooling.
- Gateway fees and settlement currency rules.
- Admin payment operations beyond read-only inspection.
