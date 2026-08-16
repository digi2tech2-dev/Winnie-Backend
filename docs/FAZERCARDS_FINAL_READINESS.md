# FazerCards Final No-Live Readiness

Date: 2026-08-16

Sources checked:
- Local reconciliation report: `Backend/docs/FAZERCARDS_API_RECONCILIATION.md`
- Official Swagger UI: https://api.fzr.cards/public/docs#/
- Official OpenAPI JSON: https://api.fzr.cards/public/docs/openapi.json
- Current Winnie backend and frontend code

Scope guard:
- No real FazerCards order/buy endpoints were called.
- No provider execution gates were enabled.
- No products were auto-enabled or auto-published.
- No customer-facing provider internals should be exposed.

## Executive Summary

The FazerCards integration is internally consistent for a no-live readiness state.

Ready for controlled live testing, with gates still required:
- `TOPUPS`
- `GIFTCARDS`
- `GAME_KEYS`

Contract/dry-run ready but not ready for auto-provider launch:
- `TELEGRAM`
- `STEAM_TOPUP`
- `MANUAL_SERVICES`

Disabled/unavailable:
- `STEAM_GIFTS`

Broad auto-provider go-live should wait until controlled live tests confirm real provider response shapes, status transitions, webhook delivery, and refund behavior for the candidate families. The code keeps environment gates, product-level execution gates, idempotency keys, balance preflight, max-cost guards, encrypted code storage, and no-blind-refund handling.

## Final Family Readiness Table

| Family | Catalog | Payload contract | Status/webhook | Code delivery | Auto-provider allowed | Customer purchase | Readiness |
|---|---|---|---|---|---|---|---|
| `TOPUPS` | Implemented | Confirmed | Implemented | No | Yes, gated | Yes when admin publishes | Controlled-live candidate |
| `GIFTCARDS` | Implemented | Confirmed | Implemented | Encrypted `ProviderDeliveredCode` | Yes, gated | Yes when admin publishes | Controlled-live candidate |
| `GAME_KEYS` | Implemented | Confirmed | Implemented | Encrypted `ProviderDeliveredCode` | Yes, gated | Yes when admin publishes | Controlled-live candidate |
| `TELEGRAM` | Implemented | Confirmed for Stars/Premium | Generic hooks ready | No | No | Yes as team/manual flow | Dry-run ready, not auto |
| `STEAM_TOPUP` | Implemented | Confirmed with check-login preflight | Generic hooks ready | No | No | Yes as team/manual flow | Dry-run ready, high risk |
| `MANUAL_SERVICES` | Implemented | Confirmed for provider order; chat message-only | Generic status and chat hooks ready | No | No | Yes as team/manual flow | Dry-run ready, operations workflow pending |
| `STEAM_GIFTS` | Docs present, account returned 404 | Docs present | Blocked before execution | No | No | No | Disabled/access unconfirmed |

## A) TOPUPS

- Catalog endpoints: `GET /api/v2/topups`, `GET /api/v2/topups/offers`.
- Order endpoint: `POST /api/v2/topups/order`.
- Required customer fields: dynamic `ProviderProduct.requiredFields` from the offers response level.
- Provider identifiers: `category_id`, `offer_id`.
- Provider payload:

```json
{
  "category_id": "8_ball_pool",
  "offer_id": "110_cash",
  "fields": {
    "user_id": "00123456789"
  }
}
```

- Initial response handling: extracts provider order id/status from common `order`, `data`, and top-level paths.
- Status sync handling: generic `GET /orders/{orderId}` parser maps completed/processing/failed/refunded/unknown.
- Webhook handling: signed webhook receiver processes status events idempotently.
- Auto readiness: allowed only for published, visible, customer-enabled products with `providerExecutionEnabled=true`, environment gates enabled, valid cost, balance preflight, and max-cost guard.
- Remaining risks: production target/account ID validation has not been live-tested.

## B) GIFTCARDS

- Catalog endpoints: `GET /api/v2/giftcards`, `GET /api/v2/giftcards/cards`.
- Order endpoint: `POST /api/v2/giftcards/order`.
- Required customer input: quantity only.
- Provider identifiers: `category_id`, `card_id`.
- Provider payload:

```json
{
  "category_id": "acash_my",
  "card_id": "10_myr",
  "quantity": 1
}
```

- Supported code response shapes: `code`, `cardCode`, `card_code`, `giftCode`, `gift_code`, `activationCode`, `activation_code`, `licenseKey`, `license_key`, `codes[]`, `cards[]`, `items[]`, nested `order.*` and `data.*` variants.
- Encrypted storage: `ProviderDeliveredCode`; plaintext is not returned by list/detail/debug endpoints.
- Reveal behavior: customer-owned completed CODE_DELIVERY order can reveal through the explicit delivered-codes endpoint; reveal count/timestamp/user are recorded.
- Status/webhook handling: completed requires recognized/stored code payload; completed without code goes to manual review and does not blindly refund.
- Auto readiness: controlled-live candidate, still globally/product gated.
- Remaining risks: actual production code payload shape must be confirmed with a real low-value order.

## C) GAME_KEYS

- Catalog endpoints: `GET /api/v2/gamekeys`, `GET /api/v2/gamekeys/keys`.
- Optional docs endpoint: `GET /api/v2/gamekeys/region-restriction`.
- Order endpoint: `POST /api/v2/gamekeys/order`.
- Required customer input: quantity only.
- Provider identifiers: `game_id`, `key_id`.
- Provider payload:

```json
{
  "game_id": "against_the_storm_cis",
  "key_id": "keepers_of_the_stone",
  "quantity": 1
}
```

- Supported key/code response shapes: `key`, `code`, `licenseKey`, `license_key`, `activationCode`, `activation_code`, `keys[]`, `codes[]`, `cards[]`, `items[]`, nested `order.*` and `data.*` variants.
- Encrypted storage: `ProviderDeliveredCode`; plaintext is reveal-only.
- Reveal behavior: same as GiftCards.
- Region restriction status: endpoint is documented but not yet consumed; current region/platform metadata is catalog-derived only.
- Status/webhook handling: same safe code-delivery completion rules as GiftCards.
- Auto readiness: controlled-live candidate, still globally/product gated.
- Remaining risks: actual production key payload shape and region-restriction behavior need live verification.

## D) TELEGRAM

- Stars quote endpoint: `GET /api/v2/telegram/stars`.
- Premium quote endpoint: `GET /api/v2/telegram/premium`.
- Stars buy endpoint: `POST /api/v2/telegram/stars/buy`.
- Premium buy endpoint: `POST /api/v2/telegram/premium/buy`.
- Required customer fields:
  - `telegram_username`
  - Stars: `quantity` between `50` and `10000`
  - Premium: `months` in `3`, `6`, `12`
- Payloads:

```json
{
  "telegram_username": "@customer",
  "quantity": 100
}
```

```json
{
  "telegram_username": "@customer",
  "months": 3
}
```

- Async behavior: provider debits immediately; local status should rely on initial response, status sync, and webhook updates.
- Status/webhook handling: generic parser can process completed/processing/failed/unknown; no code delivery expected.
- Auto readiness: not bulk-enabled and `AUTO_PROVIDER` is not allowed by contract yet.
- Why still not bulk-enabled: no controlled Telegram live validation has confirmed order creation/status/webhook behavior for this account.

## E) STEAM_TOPUP

- Rates endpoint: `GET /api/v2/steam-topup/rates`.
- Check-login endpoint: `POST /api/v2/steam-topup/check-login`.
- Order endpoint: `POST /api/v2/steam-topup/order`.
- Required customer field: `steamLogin`.
- Required provider metadata: `currency`, `amount`.
- Payload:

```json
{
  "steamLogin": "customer_login",
  "currency": "USD",
  "amount": 10
}
```

- Check-login requirement: future auto execution must run `check-login` successfully before order creation.
- Async/status/webhook behavior: generic status and webhook parser can update local orders safely.
- Auto readiness: not allowed by contract yet.
- Why high-risk: wrong Steam login can deliver value to the wrong recipient; account/login precheck must be verified live before automation.

## F) MANUAL_SERVICES

- Catalog endpoint: `GET /api/v2/manual-services`.
- Offers endpoint: `GET /api/v2/manual-services/{manualServiceId}/offers`.
- Fields copying behavior: provider offer/category fields are normalized into `ProviderProduct.requiredFields`, then copied to Product `orderFields`/`dynamicFields` on import.
- Order endpoint: `POST /api/v2/manual-services/order`.
- Chat endpoints:
  - `GET /api/v2/manual-services/orders/{orderId}/chat`
  - `POST /api/v2/manual-services/orders/{orderId}/chat`
- Current chat support: message-only client method; attachment upload remains `NEEDS_VERIFY`.
- Required customer fields: dynamic provider fields or admin-defined order fields.
- Payload:

```json
{
  "manual_service_id": "social_boost",
  "product_id": "starter",
  "fields": {
    "account_username": "customer_account"
  }
}
```

- Webhook/chat behavior: `manual_service.chat.message` and `manual_service.chat.waiting_reply` create safe admin notes/diagnostics; raw provider chat is not exposed to customers.
- Why team/manual by default: provider-side manual service automation needs an operations workflow decision before auto execution.

## G) STEAM_GIFTS

- Docs endpoints:
  - `GET /api/v2/steam-gifts/games`
  - `GET /api/v2/steam-gifts/games/{appid}`
  - `POST /api/v2/steam-gifts/order`
- Docs order payload:

```json
{
  "invite_url": "string",
  "sub_id": "string",
  "app_id": "string",
  "region": "string"
}
```

- Current account access behavior: previous production catalog discovery returned HTTP 404.
- Why disabled: docs are present, but account/catalog access is unconfirmed for this reseller account.
- Needed later: confirm catalog access, sync details by `appid`, validate invite URL and region behavior, then implement gated dry-run/execution/status tests.

## Contract Consistency Check

Every family contract now explicitly carries:
- `familyKey`
- `mode`
- `fulfillmentMode`
- `providerEndpoints`
- `requiredProviderIdentifiers`
- `requiredCustomerFields`
- `providerPayloadSchema`
- `expectedResponseSchema`
- `codeDelivery`
- `async`
- `statusWebhookBehavior`
- `autoProviderAllowed`
- `readinessReason`
- `supportStage`
- `executionStage`
- `riskLevel`
- `blockers`
- `warnings`

Payload builders:
- Confirmed: `TOPUPS`, `GIFTCARDS`, `GAME_KEYS`, `TELEGRAM`, `STEAM_TOPUP`, `MANUAL_SERVICES`.
- Explicitly blocked: `STEAM_GIFTS`.

Response parsers:
- Order metadata/status: `TOPUPS`, `TELEGRAM`, `STEAM_TOPUP`, `MANUAL_SERVICES`.
- Code/key delivery: `GIFTCARDS`, `GAME_KEYS`.
- Disabled/manual review placeholder: `STEAM_GIFTS`.

## Auto Provider Rules

Allowed only:
- `TOPUPS`
- `GIFTCARDS`
- `GAME_KEYS`

Blocked from auto-provider:
- `TELEGRAM`: payload contract is documented, but no controlled live validation.
- `STEAM_TOPUP`: high risk; requires verified `check-login` behavior.
- `MANUAL_SERVICES`: provider order/chat exists, but team workflow remains the default.
- `STEAM_GIFTS`: account access unavailable.

Bulk auto launch uses the same contract guard, so unsupported families cannot be bulk-enabled accidentally.

## Dynamic Fields Verification

- Topups: fields come from `/topups/offers` response-level `fields` and are copied to every offer.
- Telegram: `telegram_username` is imported as a required field; Stars quantity uses documented min/max.
- Steam Topup: `steamLogin` is required.
- Manual Services: provider fields are copied from offers/category response into ProviderProduct and imported Product order fields.
- GiftCards/GameKeys: quantity-only unless explicit fields are later added by provider/admin.

## Customer Safety Verification

Customer product/order APIs must continue to hide:
- provider cost
- provider order id
- provider status
- provider raw payload
- provider raw response
- internal provider API ids
- encrypted code fields
- plaintext code/key/pin/serial outside explicit reveal endpoint

Existing code paths sanitize customer product/order responses and delivered code reveal remains the only plaintext path.

## Admin UX / Operations

Default admin UI should remain production-oriented. Advanced/admin-only views may show:
- readiness
- missing identifiers
- webhook/status diagnostics
- sanitized payload previews
- contract state

Admin views must not show:
- FazerCards API key
- webhook secret
- plaintext delivered codes in lists/debug
- raw scary account-access failures in normal/default screens

Launch health should continue to show API connection, balance, gates, webhook status, product counts, auto/manual counts, order counts, and human-readable warnings.

## Final Recommendation

Next controlled live order sequence:
1. GiftCards low-value order.
2. GameKeys low-value order.
3. Topups with a known valid game/account ID.

Keep Telegram, Steam Topup, Manual Services, and Steam Gifts out of auto-provider launch until a dedicated live validation phase confirms each provider flow end-to-end.
