# Phase 2.5Q Network Webhook Reconciliation Report

## Scope

Implemented Network International / N-Genius webhook intake and payment reconciliation for wallet top-up payments only.

This phase keeps Hosted Payment Page card entry on Network, preserves backend-only status verification, and does not change manual deposits, mock payment behavior, order wallet debits, or browser return-page wallet credit rules.

## Webhook Route

Added:

`POST /api/webhooks/payments/network`

The endpoint accepts Network webhook payloads, stores a safe event record, deduplicates repeated events, resolves the matching `Payment` when possible, and re-fetches authoritative Network order status before applying any payment state change.

The response is intentionally minimal and never exposes Network secrets, raw headers, or raw provider payloads.

## Verification Mode

Added env:

```env
NETWORK_INTERNATIONAL_WEBHOOK_SECRET=
NETWORK_INTERNATIONAL_WEBHOOK_SECRET_HEADER=x-network-webhook-secret
```

If `NETWORK_INTERNATIONAL_WEBHOOK_SECRET` is configured, the endpoint requires the configured header name, or `x-network-webhook-secret` by default. The comparison uses `crypto.timingSafeEqual`.

If no secret is configured, webhook intake runs in unverified mode. In that mode the payload is still not trusted for success; the backend must re-fetch Network status before crediting or terminally updating a payment.

No Network-specific signature algorithm was invented.

## Event Persistence Shape

Added `PaymentWebhookEvent` with:

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

The full raw payload is not stored. Sensitive keys such as card/PAN/CVV/expiry/token/API key/authorization/secret are redacted or omitted. The secret header and Authorization header are not stored.

## Dedupe Behavior

Dedupe key priority:

1. Network event id.
2. Order/reference + event type + status + timestamp.
3. SHA-256 payload hash fallback.

Duplicate events increment the existing event `attempts`, set `lastReceivedAt`, audit the duplicate, and do not re-run Network status fetch or wallet credit.

## Network Verification Behavior

Webhook payloads only trigger verification. For matched payments, the webhook service calls the existing `syncPaymentStatus` path with an internal system actor and `source: network_webhook`.

The Network adapter fetches order status with the service account token. Only authoritative successful provider states mapped by the adapter can mark the local payment succeeded.

If the payment cannot be matched, the event is marked `UNMATCHED`, no wallet credit occurs, and the endpoint still returns accepted.

If Network status verification fails, the event is marked `FAILED`, no wallet credit occurs, and manual/admin reconciliation can retry later.

## Wallet Credit Rule

Wallet credit remains centralized in the payment service.

Verified successful Network status credits exactly once using `Payment.amount` and `Payment.currency`, which are the customer's requested wallet top-up values. It does not credit the gateway AED charge amount. Existing protections still apply:

- `creditedAt`
- `walletTransactionId`
- wallet ledger idempotency key `payment:<paymentId>:wallet-credit`

Webhook after manual sync and manual sync after webhook both return already-processed behavior without double credit.

## Admin Reconciliation

Added:

`POST /api/admin/payments/:id/sync-status`

Admins and supervisors with `payments.view` can manually reconcile a Network payment. The route uses the same authoritative provider fetch and idempotent credit path as customer sync and webhook processing.

Customer sync remains:

`POST /api/payments/:id/sync-status`

Customers can only sync their own payment.

## Audit

Added audit constants for:

- `PAYMENT_WEBHOOK_RECEIVED`
- `PAYMENT_WEBHOOK_PROCESSED`
- `PAYMENT_WEBHOOK_DUPLICATE`
- `PAYMENT_WEBHOOK_FAILED`
- `PAYMENT_WEBHOOK_UNMATCHED`
- `PAYMENT_RECONCILIATION_SYNCED`
- `PAYMENT_RECONCILIATION_FAILED`

Audit metadata is safe and does not include secrets or card data.

## Tests And Checks Run

- `npm.cmd run lint`: passed.
- `npm.cmd test -- --runInBand`: passed.
- `git diff --check`: passed.

Focused tests in `networkInternationalWebhook.test.js` cover unmatched event storage, invalid shared secret rejection, unverified-mode verification before credit, successful verified webhook credit, duplicate webhook idempotency, failed authoritative status without credit, payload-alone success prevention when Network verification fails, safe storage without secrets/card data, webhook/manual sync idempotency in both orders, and reconciliation ownership/admin sync behavior.

## Limitations

- Production should configure `NETWORK_INTERNATIONAL_WEBHOOK_SECRET` and confirm the exact Network portal header/signature contract.
- No scheduled reconciliation job or settlement dashboard was added.
- Webhook event storage keeps safe summaries, not raw payload replay data.
