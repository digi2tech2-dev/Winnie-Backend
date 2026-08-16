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
- `TELEGRAM`
- `STEAM_TOPUP`
- `STEAM_GIFTS` after explicit appid/offer-region import
- `MANUAL_SERVICES`

Disabled/unavailable:
- None of the documented families are globally disabled in code; `UNKNOWN` remains blocked.

Broad auto-provider go-live should wait until controlled live tests confirm real provider response shapes, status transitions, webhook delivery, and refund behavior for the candidate families. The code keeps environment gates, product-level execution gates, idempotency keys, balance preflight, max-cost guards, encrypted code storage, and no-blind-refund handling.

## Final Family Readiness Table

| Family | Catalog | Payload contract | Status/webhook | Code delivery | Auto-provider allowed | Customer purchase | Readiness |
|---|---|---|---|---|---|---|---|
| `TOPUPS` | Implemented | Confirmed | Implemented | No | Yes, gated | Yes when admin publishes | Controlled-live candidate |
| `GIFTCARDS` | Implemented | Confirmed | Implemented | Encrypted `ProviderDeliveredCode` | Yes, gated | Yes when admin publishes | Controlled-live candidate |
| `GAME_KEYS` | Implemented | Confirmed | Implemented | Encrypted `ProviderDeliveredCode` | Yes, gated | Yes when admin publishes | Controlled-live candidate |
| `TELEGRAM` | Implemented | Confirmed for Stars/Premium | Generic hooks ready | No | Yes, gated | Yes when admin publishes | Controlled-live candidate |
| `STEAM_TOPUP` | Implemented | Confirmed with check-login preflight | Generic hooks ready | No | Yes, gated | Yes when admin publishes | Controlled-live candidate, high risk |
| `MANUAL_SERVICES` | Implemented | Confirmed for provider order; chat message-only | Generic status and chat hooks ready | No | Yes, gated | Yes when admin publishes | Controlled-live candidate; attachment support still needs verify |
| `STEAM_GIFTS` | Read-only access confirmed; appid/on-demand sync only | Confirmed | Generic hooks ready | No | Yes, gated | Yes when admin publishes one on-demand product | Controlled-live candidate, no broad sync |

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
- Auto readiness: `AUTO_PROVIDER` can be enabled only after readiness passes and env gates are enabled externally. Bulk auto may include Telegram, but broken products are skipped/failed by the family guard.
- Remaining risks: no controlled Telegram live validation has confirmed order creation/status/webhook behavior for this account.

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
- Auto readiness: `AUTO_PROVIDER` can be enabled only after readiness passes, including `steamLogin` field and currency/amount metadata. Bulk auto may include Steam Topup, but check-login and provider order execution remain gated.
- Why high-risk: wrong Steam login can deliver value to the wrong recipient; account/login precheck must be verified live before broad automation.

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
- Auto readiness: `AUTO_PROVIDER` can be enabled only after readiness passes, including `manual_service_id`, `product_id`, copied customer fields, valid cost, and provider gates.
- Remaining risks: attachment chat/upload support remains `NEEDS_VERIFY`; message-only chat and status/webhook diagnostics are available for basic provider order automation.

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

- Current account access behavior: read-only production access is now confirmed.
- Observed games list response: `GET /api/v2/steam-gifts/games?limit=10` returned HTTP 200 with `meta.total=174986`, `returned=10`, and `truncated=true`.
- Observed app detail response: `GET /api/v2/steam-gifts/games/730` returned HTTP 200 with `appid=730`, offer `sub_id=54029`, and regions `CIS`, `KZ`, `RU`, `UA` with USD prices.
- Catalog strategy: do not broad-sync the 174986-game catalog. Sync/import a single explicit `appid`, normalize selected offer-region rows into ProviderProducts, then import a selected row as an inactive draft Product.
- Required customer field: `invite_url` / Steam invite link.
- Required provider identifiers: `app_id`, `sub_id`, `region`.
- Example normalized ProviderProduct id: `FAZER_STEAM_GIFT:730:54029:CIS`.
- Auto readiness: `AUTO_PROVIDER` can be enabled after appid/offer-region import, customer field readiness, cost/balance/max guard checks, and env gates are enabled externally. Bulk auto may include Steam Gifts, but only explicit appid/on-demand imported products can pass readiness.
- Bulk catalog behavior: sync-all still does not broad-sync Steam Gifts or fetch the 174986-game catalog.
- Remaining risks: no live Steam Gift order has been validated yet; invite-link recipient and region behavior must be confirmed with one controlled test.

### Steam Gifts Game Index

- Admin-only local index: `FazerCardsSteamGiftGameIndex`.
- Stored fields: game `name`, numeric `appid`, normalized search name, provider/source, `lastSeenAt`, and `indexedAt`.
- Index refresh endpoint: `POST /api/admin/providers/fazercards/steam-gifts/index/refresh`.
- Search endpoint: `GET /api/admin/providers/fazercards/steam-gifts/index/search?q=&limit=20`.
- Refresh calls only `GET /api/v2/steam-gifts/games` once and upserts game names/AppIDs only.
- Refresh does not create ProviderProducts, Winnie Products, Orders, or provider order payloads.
- Search is local-only and never calls FazerCards on each keystroke/search request.
- AppID details remain on-demand through `POST /api/admin/providers/fazercards/catalog/sync-family` with `family=STEAM_GIFTS` and explicit `appid`.
- On-demand details call only `GET /api/v2/steam-gifts/games/{appid}` and normalize offer-region rows into ProviderProducts.
- Sync-all still skips Steam Gifts broad discovery.
- Provider rate limit: Steam Gifts games list is 1 request per 3 minutes per API key, so index refresh is explicit admin action only and rate-protected.
- Optional safety config: `FAZERCARDS_STEAM_GIFTS_INDEX_MAX_RESULTS` may cap refresh size; unset means the explicit admin refresh can request the full provider list.

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
- Confirmed: `TOPUPS`, `GIFTCARDS`, `GAME_KEYS`, `TELEGRAM`, `STEAM_TOPUP`, `MANUAL_SERVICES`, `STEAM_GIFTS`.

Response parsers:
- Order metadata/status: `TOPUPS`, `TELEGRAM`, `STEAM_TOPUP`, `STEAM_GIFTS`, `MANUAL_SERVICES`.
- Code/key delivery: `GIFTCARDS`, `GAME_KEYS`.

## Auto Provider Rules

Bulk auto allowed for all supported documented families that pass readiness:
- `TOPUPS`
- `GIFTCARDS`
- `GAME_KEYS`
- `TELEGRAM`
- `STEAM_TOPUP`
- `STEAM_GIFTS`
- `MANUAL_SERVICES`

Blocked from auto-provider:
- `UNKNOWN`
- Any product/family failing readiness checks: missing identifiers, missing required customer fields, invalid/missing cost, unsupported/blocked ProviderProduct, hidden/inactive/unavailable product, or unsupported execution mode.

Bulk auto launch uses the same contract guard as product-level enablement, so it can include every supported family without blindly enabling broken products.

## Dynamic Fields Verification

- Topups: fields come from `/topups/offers` response-level `fields` and are copied to every offer.
- Telegram: `telegram_username` is imported as a required field; Stars quantity uses documented min/max.
- Steam Topup: `steamLogin` is required.
- Steam Gifts: `invite_url` is required and mapped to the provider `invite_url` payload field.
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

Bulk auto can include all supported families after admin action, but keep environment gates disabled until controlled live validation confirms each provider flow end-to-end. Steam Gifts remains explicit appid/on-demand only for catalog sync, Steam Topup requires check-login before order creation, Telegram is asynchronous and relies on status/webhooks, and Manual Services attachment upload remains `NEEDS_VERIFY`.
