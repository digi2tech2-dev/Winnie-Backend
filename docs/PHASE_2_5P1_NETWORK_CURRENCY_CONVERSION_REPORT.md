# Phase 2.5P.1 Network Currency Conversion Report

## Scope

Implemented Network International / N-Genius gateway currency conversion for wallet top-up only. Customers can request a top-up in their wallet currency while Network is charged in the configured gateway currency from `NETWORK_INTERNATIONAL_CURRENCY`.

This phase does not collect card data, expose Network secrets, credit wallets from browser return pages, bypass payment risk limits, or change manual deposit and order wallet-debit flows.

## Requested And Gateway Amounts

`Payment.amount`, `Payment.totalAmount`, and `Payment.currency` continue to store the customer's requested wallet top-up amount/currency.

For `NETWORK_INTERNATIONAL`, the backend computes:

- `gatewayAmount`: converted charge amount for Network.
- `gatewayCurrency`: `NETWORK_INTERNATIONAL_CURRENCY`, currently AED for the first merchant.

The Network adapter receives the converted gateway amount/currency and sends those values to the hosted order API. The requested wallet amount/currency are kept on the payment and in safe metadata.

## Exchange-Rate Source

Conversion uses existing platform currency helpers from `currencyConverter.service`:

- Requested currency to USD through `convertUserCurrencyToUsd`.
- USD to gateway currency through `convertUsdToUserCurrency`.
- Same-currency requests validate the platform rate and snapshot `exchangeRate: 1`.

No hardcoded EGP/AED exchange rate was added. If the requested or gateway currency rate is missing/inactive, the backend returns `PAYMENT_CURRENCY_CONVERSION_UNAVAILABLE` with the safe customer message:

`Online card payment is temporarily unavailable for this currency. Please try another currency or use manual deposit.`

## Metadata Snapshot

Network payments store a snapshot under `metadata.gatewayCurrencyConversion`:

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

Safe response fields returned to the frontend are limited to requested amount/currency, gateway amount/currency, exchange rate, and exchange-rate source. Raw Network payloads, API keys, access tokens, outlet references, and webhook secrets are not exposed.

## Network Minor Units

The Network order payload uses `gatewayAmount` and `gatewayCurrency`.

The adapter converts gateway amount to minor units using currency decimal precision. AED defaults to two decimals, so `7.34 AED` is sent as `734`.

## Checkout Redirect

The backend still returns the hosted checkout URL after creating the Network order. The payment remains `REQUIRES_ACTION`; creation does not mark the payment successful.

Idempotency remains stable. Reusing the same idempotency key returns the existing payment and checkout URL with the original conversion snapshot instead of creating a duplicate Network order.

## Wallet Credit Rule

Verified Network success credits the wallet using `Payment.amount` and `Payment.currency`, which are the customer's intended wallet top-up values. Browser return/cancel pages never credit the wallet. The existing idempotency protections (`creditedAt`, `walletTransactionId`, and wallet ledger idempotency key) prevent double credit.

## Risk-Limit Compatibility

Phase 2.5N risk checks still run before currency conversion creates a gateway adapter or calls Network. A blocked risk check does not request a Network access token, does not create a Network order, does not create a payment, and does not credit the wallet.

Risk evaluation continues to use the requested top-up amount converted to USD equivalent by the existing risk helper.

## Tests And Checks Run

- `npm.cmd run lint`: passed.
- `npm.cmd test -- --runInBand`: passed, 27 suites / 696 tests.
- `git diff --check`: passed.

Focused Network tests cover AED same-currency checkout, EGP requested top-up converted to AED Network charge, conversion snapshot persistence, Network AED minor-unit payload, safe response charge fields, missing gateway currency rate, risk block before Network calls, no wallet credit on create, idempotent checkout return, one-time wallet credit on verified status sync using requested EGP amount/currency, mock gateway compatibility, and secret non-exposure.

## Limitations

- Exchange rates come from existing platform currency data; there is no live FX feed in this phase.
- No gateway FX markup, settlement reconciliation, or fee accounting was added.
- Production webhook processing remains reserved until the Network portal webhook/header contract is finalized.
