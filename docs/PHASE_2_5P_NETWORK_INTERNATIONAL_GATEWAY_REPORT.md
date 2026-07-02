# Phase 2.5P Network International Gateway Report

## Scope

Implemented Network International / N-Genius Hosted Payment Page for customer wallet top-up only. The integration keeps card entry on Network hosted pages, preserves Phase 2.5N risk checks before gateway calls, and does not affect manual deposits or order wallet-debit flows.

## Environment

Added backend env support:

```env
NETWORK_INTERNATIONAL_ENABLED=false
NETWORK_INTERNATIONAL_ENV=sandbox
NETWORK_INTERNATIONAL_BASE_URL=
NETWORK_INTERNATIONAL_API_KEY=
NETWORK_INTERNATIONAL_OUTLET_REF=
NETWORK_INTERNATIONAL_CURRENCY=AED
NETWORK_INTERNATIONAL_RETURN_URL=http://localhost:5173/payment/success
NETWORK_INTERNATIONAL_CANCEL_URL=http://localhost:5173/payment/cancel
NETWORK_INTERNATIONAL_WEBHOOK_SECRET=
```

`NETWORK_INTERNATIONAL_BASE_URL` remains overrideable. If empty, `live` uses `https://api-gateway.ngenius-payments.com`; other environments use `https://api-gateway.sandbox.ngenius-payments.com`.

## Hosted Payment Flow

1. `POST /api/payments/intents` validates payments enabled, gateway allow-list, amount, currency, wallet currency, and payment risk limits.
2. If risk allows, the Network adapter requests an access token from `POST {baseUrl}/identity/auth/access-token`.
3. The adapter creates a hosted order at `POST {baseUrl}/transactions/outlets/{outletRef}/orders`.
4. The backend stores provider order id/reference and checkout URL on `Payment`.
5. The payment remains `REQUIRES_ACTION`; wallet credit is not attempted during creation.
6. The frontend redirects the customer to the hosted checkout URL.

## Access Token

The access-token request uses:

- `Authorization: Basic {NETWORK_INTERNATIONAL_API_KEY}`
- `Content-Type: application/vnd.ni-identity.v1+json`

API keys and access tokens are not logged or returned in customer/admin serialized payment responses.

## Order Creation

Network order creation sends:

- `action: SALE`
- AED minor units, using 2 decimal places
- internal payment id as `merchantOrderReference`
- configured return/cancel URLs with `paymentId` query parameter

The first implementation requires Network currency to match configured `NETWORK_INTERNATIONAL_CURRENCY`, currently AED.

## Status Verification

Added `POST /api/payments/:id/sync-status`.

This endpoint is authenticated and owner/admin restricted. It fetches Network order status before changing a real-gateway payment. Successful wallet credit is allowed only for authoritative provider states mapped to success: `PURCHASED`, `CAPTURED`, `SUCCESS`, or `SUCCESSFUL`.

Webhook handling remains intentionally reserved until the Network merchant portal webhook/header contract is confirmed. The webhook secret env exists for future use, but no unsigned webhook success path was added.

## Wallet Credit Rule

Wallet credit happens only after:

- non-production mock confirmation, or
- verified Network status sync maps to `SUCCEEDED`.

Browser return/cancel URLs never credit the wallet. Wallet credit is idempotent through payment `creditedAt`, `walletTransactionId`, and wallet ledger idempotency key `payment:<paymentId>:wallet-credit`.

## Security Notes

- No card number, CVV, expiry, or sensitive card data is collected or stored.
- Network API key, access token, outlet reference, and raw provider errors are not exposed to frontend responses.
- Risk blocks occur before Network token/order calls.
- Manual deposit and order wallet debit flows were not changed.
- Ziina/Tap remain placeholder adapters.

## Tests And Checks Run

- `npm.cmd run lint`: passed.
- `npm.cmd test -- --runInBand`: passed, 27 suites / 695 tests.
- `git diff --check`: passed.

Focused tests added in `src/tests/networkInternationalPayment.test.js` cover missing config, Basic auth token request, AED minor units/order payload, checkout URL storage, no wallet credit on create, risk-before-Network behavior, unsupported currency, secret non-exposure, idempotency, and one-time wallet credit after verified status sync.

## Limitations

- No production webhook endpoint yet.
- No reconciliation dashboard or scheduled polling yet.
- No FX conversion into AED; Network requires the payment currency to be AED for this phase.
