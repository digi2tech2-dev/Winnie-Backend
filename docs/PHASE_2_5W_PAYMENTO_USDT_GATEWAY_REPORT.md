# Phase 2.5W Paymento USDT Gateway Report

## Scope

Implemented Paymento hosted USDT wallet top-ups for the existing payments module.

Paymento is wallet top-up only. USDT/crypto checkout is hosted by Paymento; the frontend does not collect crypto private data, calculate crypto rates, or credit the wallet locally.

## Files Changed

- `src/modules/payments/payment.constants.js`
- `src/modules/payments/payment.service.js`
- `src/modules/payments/payment.webhook.controller.js`
- `src/modules/payments/payment.webhook.routes.js`
- `src/modules/payments/payment.webhook.service.js`
- `src/modules/payments/gateways/gateway.factory.js`
- `src/modules/payments/gateways/paymento.gateway.js`
- `src/config/config.js`
- `src/app.js`
- `src/tests/paymentoPayment.test.js`
- `src/tests/paymentoWebhook.test.js`
- `Frontend/src/api/paymentMethods.js`
- `Frontend/src/api/adminPayments.js`
- `Frontend/src/pages/customer/CustomerWalletTopUp.jsx`
- `Frontend/src/pages/admin/AdminPaymentsPage.jsx`
- `.env.example`
- `docs/PAYMENTS_ARCHITECTURE.md`
- `docs/PHASE_2_FEATURE_TODO.md`

## Environment

```env
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
```

Backend-only secrets:

- `PAYMENTO_API_KEY`
- `PAYMENTO_IPN_SECRET`

The default merchant API paths are `PAYMENTO_CREATE_PATH=/v1/payment/request` and `PAYMENTO_VERIFY_PATH=/v1/payment/verify`.

## Create Intent Flow

1. Customer selects an admin-configured payment method with `gateway: PAYMENTO`.
2. Frontend calls `POST /api/payments/intents` with the selected gateway.
3. Backend validates global payments setting, gateway allow-list, amount, currency, user, wallet currency, and payment risk limits before any Paymento HTTP call.
4. Backend converts the requested wallet amount/currency to `PAYMENTO_FIAT_CURRENCY` through the existing platform currency converter.
5. Backend creates a local `Payment` with existing idempotency behavior.
6. Paymento adapter creates a hosted checkout request server-side using the `Api-key` header and a strict request body with `fiatAmount`, `fiatCurrency`, `ReturnUrl`, `orderId`, `Speed`, and safe `additionalData`.
7. Paymento may return a token instead of a checkout URL; the backend builds `https://app.paymento.io/gateway?token=<token>` and stores the token only as the provider payment id needed for later verify/status calls.
8. Backend stores safe metadata only: provider reference/id, checkout URL presence, requested/gateway amount snapshots, allowed crypto, and redirect/IPN configuration.
9. Local status remains `REQUIRES_ACTION`.
10. Frontend redirects with `window.location.assign(checkoutUrl)`.

## Webhook/IPN Verification Flow

Added:

`POST /api/webhooks/payments/paymento`

The route is unauthenticated because provider IPNs do not carry user JWTs.

If `PAYMENTO_IPN_SECRET` is configured, the backend verifies HMAC SHA-256 against the raw request body. Supported signature headers are:

- `x-paymento-signature`
- `x-paymento-hmac-sha256`
- `x-signature`
- `signature`

Invalid signatures are rejected with `PAYMENTO_WEBHOOK_INVALID_SIGNATURE`; no event is stored and no wallet credit occurs.

Valid or unverified-mode events are stored in `PaymentWebhookEvent` with safe summaries only. Duplicate events increment `attempts` and do not re-run provider verify or wallet credit.

Matched events call the Paymento verify/status API server-side with `{ "token": "<stored-paymento-token>" }`. Unmatched events are marked `UNMATCHED` and never credit the wallet.

## Status Mapping

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

Success aliases handled by the adapter include `SUCCESS`, `SUCCESSFUL`, and `COMPLETED`.

## Wallet Credit Rule

Wallet credit happens only after authoritative Paymento verify/status returns success.

Wallet credit uses local `Payment.amount` and `Payment.currency`, not the Paymento fiat charge amount. It is idempotent through:

- `Payment.creditedAt`
- `Payment.walletTransactionId`
- wallet ledger idempotency key `payment:<paymentId>:wallet-credit`

No credit occurs for browser return pages, webhook payload alone, pending, partial paid, waiting confirmation, timeout, canceled, rejected, unmatched, or failed verification.

## Admin Reconciliation

Existing route now supports Paymento:

`POST /api/admin/payments/:id/sync-status`

Admin sync re-fetches Paymento status, applies the shared payment state machine, and credits once only on verified success. Customers can sync only their own Paymento payments through `POST /api/payments/:id/sync-status`.

## Frontend Behavior

- Admin payment method forms can select `PAYMENTO`.
- Customer wallet top-up sends `gateway: "PAYMENTO"` through the existing intent endpoint.
- If `checkoutUrl` is returned, the customer is redirected to Paymento hosted checkout.
- Redirect messaging shows the requested wallet amount and backend-returned gateway charge when available.
- The frontend never calculates crypto exchange rates.
- Browser success/cancel/pending pages remain informational and display credited success only when backend sync returns `SUCCEEDED` with `creditedAt`.
- Admin payments can filter Paymento, show safe gateway charge summaries, show webhook summaries returned by the backend, and trigger Sync/Reconcile.

## Security Notes

- No card data, crypto private keys, seed phrases, API keys, IPN secrets, raw provider payloads, raw signatures, access tokens, or authorization headers are exposed to frontend/admin responses.
- Payment risk limits run before Paymento provider calls.
- Paymento IPN payload alone never marks success.
- Paymento browser return/cancel/pending pages never credit the wallet.
- `PAYMENTO_IPN_URL` is retained for Paymento dashboard/settings configuration. It is not sent in the create-payment payload unless the merchant API explicitly supports it.
- Webhook storage keeps safe summaries and payload hashes, not raw payloads.
- Sensitive payload keys are redacted or omitted from summaries.

## Tests And Checks Run

Run during implementation:

- `npm.cmd run lint`: passed.
- `npm.cmd test -- paymentoPayment.test.js --runInBand`: passed.
- `npm.cmd test -- paymentoWebhook.test.js --runInBand`: passed.
- `npm.cmd test -- networkInternationalPayment.test.js --runInBand`: passed.
- `npm.cmd test -- networkInternationalWebhook.test.js --runInBand`: passed.
- `npm.cmd test -- --runInBand`: passed, 30 suites / 756 tests.
- backend `git diff --check`: passed with Git line-ending/safe.directory warnings only.
- frontend `npm.cmd run lint`: passed with existing React hook dependency warnings.
- frontend `npm.cmd run build`: passed with existing Vite chunk-size warning.
- frontend `git diff --check`: passed with Git line-ending/safe.directory warnings only.

## Manual Smoke Test Steps

1. Set `PAYMENT_ALLOWED_GATEWAYS=MOCK,PAYMENTO` and configure Paymento env vars.
2. In admin payment methods, create an active online method with gateway `PAYMENTO`, visible to customers.
3. As a customer, open wallet top-up, choose the Paymento method, enter an amount, and submit.
4. Confirm the page shows the requested amount and gateway charge if returned, then redirects to Paymento checkout.
5. Return to `/payment/success?paymentId=<id>` and verify the page does not claim wallet credit unless backend sync returns `SUCCEEDED` with `creditedAt`.
6. Send a valid Paymento webhook/IPN and confirm the backend calls Paymento verify/status before marking success.
7. Re-send the same webhook and confirm no second wallet transaction is created.
8. Use `/admin/tools/payments` to filter Paymento payments, inspect safe details/webhook summaries, and run Sync/Reconcile.

## Limitations

- The adapter now follows the confirmed Paymento create/verify contract for `/v1/payment/request`, `/v1/payment/verify`, `Api-key`, token checkout URLs, and token-based verify. Production should still confirm merchant-specific status fields and signature header settings with Paymento.
- No scheduled Paymento reconciliation job was added.
- No settlement, fee, or crypto network analytics dashboard was added.
