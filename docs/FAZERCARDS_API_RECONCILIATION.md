# FazerCards API Reconciliation / Gap Report

Date: 2026-08-15

Sources checked:
- Official Swagger UI: https://api.fzr.cards/public/docs#/
- Official OpenAPI JSON: https://api.fzr.cards/public/docs/openapi.json
- Official webhook guide: https://reseller.fazercards.com/en/docs/webhooks
- Current Winnie backend/frontend code in `Backend` and `Frontend`

Scope guard:
- No provider order/buy endpoints were called.
- No env gates were enabled.
- No production behavior was changed.
- This report is a code/docs reconciliation only.

## Executive Summary

Current readiness, honestly separated:

- Catalog/admin/customer purchase readiness with manual fallback: about 80%.
- Fully automated provider execution readiness against the official docs: about 55%.
- Confirmed catalog coverage: TOPUPS, GIFTCARDS, GAME_KEYS, TELEGRAM, STEAM_TOPUP, MANUAL_SERVICES.
- Account-specific unavailable catalog: STEAM_GIFTS is in docs but previously returned 404 for this account, so keep it disabled.
- Confirmed payload builders in code: TOPUPS, GIFTCARDS, GAME_KEYS only.
- Missing before broad AUTO_PROVIDER go-live: default documented order status client using `GET /api/v2/orders/{orderId}`, FazerCards webhook receiver/signature verification, and response fixture/live verification for delivered code shapes.

Production-ready today:

- Read-only account/balance checks.
- Topup/GiftCard/GameKey catalog sync/import/publish UI.
- Customer purchase flow with manual fallback.
- Encrypted code storage and customer reveal endpoint for CODE_DELIVERY.
- Safety gates, idempotency keys, max-cost guards, balance preflight, no blind refund on unknown provider outcome.
- Admin manual order queue, complete/fail/note, encrypted manual delivered-code storage.

Not fully ready:

- Webhook receiver is not implemented for FazerCards.
- Generic order status endpoints from docs are not implemented directly; status sync depends on optional `FAZERCARDS_TOPUP_ORDER_STATUS_PATH` and is topup-named.
- Telegram, Steam Topup, Steam Gifts, and Manual Services provider order endpoints are documented but not implemented.
- Manual Services chat endpoints are documented but not implemented.
- Topup `validate-id` endpoints are documented but not implemented.
- GameKeys region restriction endpoint is documented but not consumed.

Can we safely open AUTO_PROVIDER now?

- TOPUPS: PARTIAL. Payload and initial response mapping exist, but status polling/webhook must be reconciled with docs before broad auto go-live.
- GIFTCARDS: PARTIAL. Payload, idempotency, encrypted code storage exist. Need response-shape verification and status/webhook reconciliation before broad auto go-live.
- GAME_KEYS: PARTIAL. Same as GiftCards.
- TELEGRAM / STEAM_TOPUP / MANUAL_SERVICES: NO. Keep as normal customer purchase with internal/manual processing until endpoint contracts are implemented.
- STEAM_GIFTS: NO. Docs present, account access/catalog unavailable.

## Master API Matrix

Legend:
- Backend: YES, PARTIAL, NO.
- Frontend: YES, PARTIAL, NO.
- Auto safety: YES, NO, PARTIAL, NEEDS_VERIFY, N/A.
- `DOCS_PRESENT_ACCESS_UNCONFIRMED` means official docs list the endpoint but current account access was not confirmed or returned 403/404 previously.

| Area | Endpoint | Purpose | Docs request | Backend | Frontend | Current Winnie payload/parser | Idempotency | Wallet/refund | Code storage | Customer fields/UI | Admin UI | Auto safety | Missing work | Risk |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Account | `GET /api/v2/me` | Account/subscription state | none | YES | PARTIAL | Client `getAccount`, adapter health/test connection | N/A | N/A | N/A | none | health/test connection | N/A | none material | LOW |
| Account | `GET /api/v2/balance` | Provider wallet balance | none | YES | YES | Client `getBalance`; used in health/readiness/preflight | N/A | prevents provider call on low/unknown balance | N/A | none | health/balance cards | N/A | none material | LOW |
| Orders | `GET /api/v2/orders` | Provider order list | `page`, `limit` | NO | NO | no client method | N/A | N/A | N/A | none | none | NO | add provider order list/reconcile client for ops | MEDIUM |
| Orders | `GET /api/v2/orders/{orderId}` | Provider order detail/status | `orderId` path | PARTIAL | PARTIAL | `getTopupOrderStatus` only uses configurable `FAZERCARDS_TOPUP_ORDER_STATUS_PATH`; not defaulted to documented path | N/A | unknown -> manual review, failed -> refund-once | code not parsed here | none | sync-status/debug routes exist | PARTIAL | implement documented default path and apply to all families | HIGH |
| Topups | `GET /api/v2/topups` | Topup category catalog | `limit`, `cursor`, `include_ui` | YES | YES | sync-page/sync-all, cursor supported | N/A | N/A | N/A | category fields copied later | family filters/list | N/A | optional `include_ui` not used | LOW |
| Topups | `GET /api/v2/topups/offers` | Topup offers + fields | `category_id`, `include_ui` | YES | YES | normalizes offers into ProviderProduct; fields copied to each offer | N/A | N/A | N/A | requiredFields/orderFields supported | import/publish UI | N/A | optional `include_ui` not used | LOW |
| Topups | `GET /api/v2/topups/validate-id` | List games with ID validation support | none | NO | NO | not implemented | N/A | N/A | N/A | none | none | NEEDS_VERIFY | add admin/customer-safe precheck only after design | MEDIUM |
| Topups | `POST /api/v2/topups/validate-id` | Validate submitted player/account ID | `{ category_id, fields }` | NO | NO | not implemented | N/A | should be pre-order/no debit if used | N/A | would improve topup form | none | NEEDS_VERIFY | implement optional validation before auto go-live | MEDIUM |
| Topups | `POST /api/v2/topups/order` | Create topup order | `{ category_id, offer_id, fields }`; `Idempotency-Key` header | YES | N/A | payload builder preserves string field values; parser maps completed/processing/failed/unknown | YES, `fazercards:topup:<orderId>` | debit occurs via normal order flow; failed refunds once; timeout/unknown manual review | N/A | dynamic fields supported | readiness/dry-run/launch | PARTIAL | status/webhook reconciliation and live fixture validation | HIGH |
| GiftCards | `GET /api/v2/giftcards` | Gift card categories | `limit`, `cursor`, `include_ui` | YES | YES | sync-family/sync-all | N/A | N/A | N/A | quantity-only | family filters/list | N/A | optional `include_ui` not used | LOW |
| GiftCards | `GET /api/v2/giftcards/cards` | Cards/denominations | `category_id`, optional `card_id`, `include_ui` | YES | YES | offers normalized as CODE_DELIVERY ProviderProducts | N/A | N/A | encrypted storage prepared | quantity-only | import/publish UI | N/A | optional single-card filter not used | LOW |
| GiftCards | `POST /api/v2/giftcards/order` | Buy gift card codes | `{ category_id, card_id, quantity }`; `Idempotency-Key` header | YES | N/A | client method, contract payload builder, generic response/code parser | YES, `fazercards:code-delivery:<orderId>` | normal debit; failed refunds once; unknown manual review | YES, `ProviderDeliveredCode` encrypted | quantity-only | live-pilot/admin ops | PARTIAL | verify actual code response shape, status, webhook | HIGH |
| GameKeys | `GET /api/v2/gamekeys` | Game key game catalog | `limit`, `cursor`, `include_ui` | YES | YES | sync-family/sync-all | N/A | N/A | N/A | quantity-only | family filters/list | N/A | optional `include_ui` not used | LOW |
| GameKeys | `GET /api/v2/gamekeys/keys` | Key offers for a game | `game_id`, `include_ui` | YES | YES | keys normalized as CODE_DELIVERY ProviderProducts | N/A | N/A | encrypted storage prepared | quantity-only | import/publish UI | N/A | optional UI metadata not used | LOW |
| GameKeys | `GET /api/v2/gamekeys/region-restriction` | Country availability by game | `game_id` | NO | NO | registry lists optional endpoint but sync does not call it | N/A | N/A | N/A | could warn customer | none | NEEDS_VERIFY | fetch/store restrictions where `region_restriction=true` | MEDIUM |
| GameKeys | `POST /api/v2/gamekeys/order` | Buy game keys | `{ game_id, key_id, quantity }`; `Idempotency-Key` header | YES | N/A | client method, contract payload builder, generic response/code parser | YES, `fazercards:code-delivery:<orderId>` | normal debit; failed refunds once; unknown manual review | YES, encrypted | quantity-only | live-pilot/admin ops | PARTIAL | verify actual key response shape, status, webhook | HIGH |
| Telegram | `GET /api/v2/telegram/stars` | Stars quote/rate catalog | none | YES | PARTIAL | sync creates blocked catalog product with `telegram_username` field | N/A | N/A | no code expected | username field supported | import/publish manual | N/A | none for catalog | LOW |
| Telegram | `GET /api/v2/telegram/premium` | Premium plans catalog | none | YES | PARTIAL | sync creates Premium plan products | N/A | N/A | no code expected | username field supported | import/publish manual | N/A | none for catalog | LOW |
| Telegram | `POST /api/v2/telegram/stars/buy` | Buy Stars | `{ telegram_username, quantity }` | NO | NO | contract still marks payload unconfirmed even though docs define it | not implemented | not implemented | no code expected | UI can collect username/quantity manually | no auto | NO | implement contract/client/parser/gates/status/webhook | MEDIUM |
| Telegram | `POST /api/v2/telegram/premium/buy` | Buy Premium | `{ telegram_username, months: 3/6/12 }` | NO | NO | contract still unconfirmed | not implemented | not implemented | no code expected | UI can collect username manually; months from product | no auto | NO | implement contract/client/parser/gates/status/webhook | MEDIUM |
| Steam Topup | `GET /api/v2/steam-topup/rates` | Steam topup rates | none | YES | PARTIAL | sync creates rate products with required `steamLogin` | N/A | N/A | no code expected | login field supported | import/publish manual | N/A | none for catalog | MEDIUM |
| Steam Topup | `POST /api/v2/steam-topup/check-login` | Login precheck | `{ steamLogin }` | NO | NO | not implemented | N/A | should be pre-order/no debit if used | no code expected | should validate login | none | NEEDS_VERIFY | implement validation before auto | HIGH |
| Steam Topup | `POST /api/v2/steam-topup/order` | Steam wallet topup | `{ steamLogin, currency, amount }`; `Idempotency-Key` header | NO | NO | contract still unconfirmed | not implemented | not implemented | no code expected | login field supported manually | no auto | NO | implement only after check-login/status/webhook plan | HIGH |
| Steam Gifts | `GET /api/v2/steam-gifts/games` | Steam gifts game catalog | `limit` | PARTIAL | PARTIAL | code can call it, but production returned 404; sync-all skips/records unavailable | N/A | N/A | no code expected | disabled | unavailable warning | NO | account access/support confirmation | HIGH |
| Steam Gifts | `GET /api/v2/steam-gifts/games/{appid}` | Steam gift offers | `appid` path | PARTIAL | PARTIAL | code can call after game list; not useful while list 404s | N/A | N/A | no code expected | disabled | unavailable | NO | account access/support confirmation | HIGH |
| Steam Gifts | `POST /api/v2/steam-gifts/order` | Create Steam gift order | `{ invite_url, sub_id, app_id, region }`; `Idempotency-Key` header | NO | NO | disabled | not implemented | not implemented | no code expected | disabled | no auto | NO | keep disabled until catalog works | HIGH |
| Manual Services | `GET /api/v2/manual-services` | Manual service categories | `include_ui` | YES | PARTIAL | sync categories | N/A | N/A | no code expected | fields should be copied from offers response | import/publish manual | N/A | optional UI metadata not used | MEDIUM |
| Manual Services | `GET /api/v2/manual-services/{manualServiceId}/offers` | Offers, category info, possible fields | path id, `include_ui` | PARTIAL | PARTIAL | sync offers, but currently stores `requiredFields: []` and does not copy documented `fields` | N/A | N/A | no code expected | admin must add fields manually | import/publish manual | NO | copy `fields` for replenishment services | HIGH |
| Manual Services | `POST /api/v2/manual-services/order` | Create manual service provider order | `{ manual_service_id, product_id, fields? }`; `Idempotency-Key` header | NO | NO | not implemented | not implemented | not implemented | no code expected | fields needed for replenishment | no auto | NO | implement after chat/status/webhook plan | HIGH |
| Manual Services | `GET /api/v2/manual-services/orders/{orderId}/chat` | Read supplier chat | path order id | NO | NO | not implemented | N/A | N/A | no code expected | admin/customer chat not wired | none | NO | needed before provider-side manual service execution | HIGH |
| Manual Services | `POST /api/v2/manual-services/orders/{orderId}/chat` | Send chat message/attachment | multipart form-data | NO | NO | not implemented | N/A | N/A | no code expected | admin/customer chat not wired | none | NO | needed before provider-side manual service execution | HIGH |
| Webhooks | `GET/PUT/DELETE /api/v2/account/webhook` | Manage registered webhook | PUT `{ url, enabled? }` | NO | NO | no client methods | N/A | N/A | N/A | none | none | NO | configure webhook receiver/secret lifecycle | HIGH |
| Webhooks | `POST /api/v2/account/webhook/test` | Send test event | none | NO | NO | no client method | N/A | N/A | N/A | none | none | NO | implement after receiver exists | MEDIUM |
| Webhooks | `GET /api/v2/account/webhook/deliveries` | Delivery diagnostics | none | NO | NO | no client method | N/A | N/A | N/A | none | none | NO | useful for ops | MEDIUM |
| Webhooks | `POST /api/v2/account/webhook/secret/regenerate` | Rotate signing secret | none | NO | NO | no client method | N/A | N/A | N/A | none | none | NO | add secure secret handling | MEDIUM |

## Family-by-Family Status

### Account / Balance

Status: ready for operational use.

Docs define `/me` and `/balance`. Current backend has `FazerCardsClient.getAccount` and `getBalance`, with secret redaction and subscription-inactive mapping. Admin UI uses these through health/balance views. No meaningful gaps.

### Orders / Status

Status: partial, P0 gap.

Docs define:
- `GET /api/v2/orders`
- `GET /api/v2/orders/{orderId}`

Current code has a `getTopupOrderStatus` method, but it requires `FAZERCARDS_TOPUP_ORDER_STATUS_PATH`. It is not defaulted to `/orders/{orderId}` and is topup-named. Status sync/admin debug routes exist, but provider polling/reconcile is not fully aligned to the documented generic order endpoint.

Impact: auto orders can be created behind gates, but ongoing reconciliation depends on initial response, optional configured path, and manual admin review. Webhooks are also missing.

### Topups

Status: catalog/import/customer/manual flow ready; auto execution partial.

Implemented:
- `GET /topups`
- `GET /topups/offers`
- `POST /topups/order`
- dynamic customer fields
- idempotency key `fazercards:topup:<orderId>`
- balance preflight, max-cost guard, no blind refund on unknown

Missing:
- `GET/POST /topups/validate-id`
- documented generic status polling default
- webhook receiver
- live target-ID validation evidence

Auto status: READY_AFTER_SMALL_FIX, not READY_NOW.

### GiftCards

Status: catalog/import/customer/code storage ready; auto execution partial.

Implemented:
- `GET /giftcards`
- `GET /giftcards/cards`
- `POST /giftcards/order`
- quantity-only customer UI
- encrypted `ProviderDeliveredCode`
- reveal endpoint with ownership/completed checks
- idempotency key `fazercards:code-delivery:<orderId>`

Missing:
- provider response fixture/live verification for exact code fields
- generic status sync via `/orders/{orderId}`
- webhook receiver

Auto status: READY_AFTER_SMALL_FIX.

### GameKeys

Status: catalog/import/customer/code storage ready; auto execution partial.

Implemented:
- `GET /gamekeys`
- `GET /gamekeys/keys`
- `POST /gamekeys/order`
- quantity-only customer UI
- encrypted code/key storage

Missing:
- `GET /gamekeys/region-restriction`
- provider response fixture/live verification for exact key fields
- generic status sync via `/orders/{orderId}`
- webhook receiver

Auto status: READY_AFTER_SMALL_FIX.

### Telegram

Status: catalog/import/manual customer purchase ready; auto execution not implemented.

Docs define:
- `GET /telegram/stars`
- `GET /telegram/premium`
- `POST /telegram/stars/buy` with `{ telegram_username, quantity }`
- `POST /telegram/premium/buy` with `{ telegram_username, months }`

Current code syncs Stars/Premium and supports manual customer fields. The contract currently marks payload unconfirmed; this is now stale relative to docs and should be updated only when implementation starts.

Auto status: NEEDS_IMPLEMENTATION.

### Steam Topup

Status: catalog/import/manual customer purchase ready; auto execution not implemented.

Docs define:
- `GET /steam-topup/rates`
- `POST /steam-topup/check-login` with `{ steamLogin }`
- `POST /steam-topup/order` with `{ steamLogin, currency, amount }`

Current code syncs rates and creates Steam Login customer fields, but does not implement check-login or order. High risk because customer account identifiers are involved.

Auto status: NEEDS_IMPLEMENTATION.

### Steam Gifts

Status: disabled/unavailable.

Docs define:
- `GET /steam-gifts/games`
- `GET /steam-gifts/games/{appid}`
- `POST /steam-gifts/order` with `{ invite_url, sub_id, app_id, region }`

Production discovery previously returned HTTP 404 for this account. Current code keeps this family disabled.

Auto status: NOT_AVAILABLE_FOR_ACCOUNT / keep disabled.

### Manual Services

Status: catalog/import/manual customer purchase partially ready; provider execution/chat not implemented.

Docs define:
- `GET /manual-services`
- `GET /manual-services/{manualServiceId}/offers`, including possible `fields`
- `POST /manual-services/order`
- `GET/POST /manual-services/orders/{orderId}/chat`

Current code syncs categories/offers but does not copy documented `fields` into ProviderProduct required fields. Admin can still add order fields manually, but provider-side manual-service execution and chat are not present.

Auto status: KEEP_MANUAL/TEAM_FULFILLMENT.

### Webhooks

Status: not implemented, P0/P1 gap for automated provider reliability.

Docs say webhook events include:
- `order.created`
- `order.status_changed`
- `manual_service.chat.message`
- `manual_service.chat.waiting_reply`

Webhook payload includes `event`, `event_id`, `timestamp`, and `data` with `order_id`, `type`, `status`, and possibly `previous_status`. Signature header is `X-Webhook-Signature` / `x-webhook-signature`, value `sha256=<hmac_sha256(rawBody, secret)>`. Retry policy is up to 3 retries with exponential backoff at 1 minute, 5 minutes, and 30 minutes; after 50 consecutive failures, webhook auto-disables.

Current Winnie has payment webhooks only. No FazerCards webhook route, no signature verification, no event idempotency table, no webhook-based order status updates.

## Special Checks

### A) Auto Provider Eligibility

READY_NOW:
- None, if "ready" means docs-aligned status plus webhook plus verified response handling.

READY_AFTER_SMALL_FIX:
- TOPUPS: add documented `/orders/{orderId}` default status client, tests, and webhook receiver/status processing.
- GIFTCARDS: same, plus response fixture/live validation for delivered code extraction.
- GAME_KEYS: same, plus response fixture/live validation for delivered key extraction and region restriction consideration.

NEEDS_IMPLEMENTATION:
- TELEGRAM: docs payload is clear; implement client/contract/parser/status/webhook.
- STEAM_TOPUP: docs payload is clear but high risk; implement check-login before order.
- MANUAL_SERVICES: implement fields copy, provider order, and chat workflow.

NOT_AVAILABLE_FOR_ACCOUNT:
- STEAM_GIFTS: docs present but catalog previously returned 404 in production.

KEEP_MANUAL/TEAM_FULFILLMENT:
- TELEGRAM, STEAM_TOPUP, MANUAL_SERVICES until implemented.
- STEAM_GIFTS disabled.

### B) Status Handling

Current coverage:
- Initial response status mapping exists for topups and code-delivery families.
- Unknown/timeout provider outcomes move to manual review and do not blindly refund.
- Definite failed outcomes trigger refund-once behavior.
- Admin sync-status/debug routes exist.

Gaps:
- `GET /orders/{orderId}` is not the default status endpoint in the client.
- `GET /orders` list/reconciliation is not implemented.
- FazerCards webhooks are not implemented.
- Status parser is generic because OpenAPI says `order` is `additionalProperties`; needs response fixture/live verification per family.

### C) Code Delivery

Current coverage:
- GiftCards/GameKeys encrypted storage uses `ProviderDeliveredCode` and AES-GCM via `secretEncryption`.
- Customer plaintext reveal is only from `GET /api/orders/:id/delivered-codes`, `GET /api/orders/my/:id/delivered-codes`, or `GET /api/me/orders/:id/delivered-codes`.
- Reveal requires order ownership, completed status, and code-delivery product/order.
- Normal order list/detail do not return plaintext delivered codes.

Gaps:
- Exact provider response code/key paths are not specified in OpenAPI, so parser is conservative and must be verified.
- Admin debug/list endpoints do not reveal plaintext, which is good; admin reveal/audit is not a broad feature and should stay restricted.

### D) Customer Safety

Current coverage:
- Customer product/order sanitizers remove provider cost, ProviderProduct refs, rawPayload, provider order id/status, provider API ids, and execution internals.
- Hidden/inactive/unavailable or `customerPurchaseEnabled=false` FazerCards products are filtered from customer product APIs.
- Plaintext code is returned only from explicit reveal endpoint.

Gaps:
- Re-check customer UI after any future exposure of family/fulfillment fields; current backend sanitizers strip these from product/order responses and add safe hints.
- Error messages from provider failures should continue to be normalized before reaching customers.

### E) Admin UX

Current coverage:
- Admin can sync catalog by page/family/all.
- Admin can browse ProviderProducts with filters.
- Admin can import to Winnie Product.
- Admin can publish product and enable auto where current contract allows.
- Admin can view health, pending/failed/manual queue, complete/fail/note, and store encrypted code manually.
- Main admin Orders page has generic order detail/sync controls; FazerCards-specific order debug exists under provider ops routes.

Gaps:
- No direct Provider order detail from FazerCards `/orders/{orderId}`.
- No webhook delivery diagnostics UI.
- Product edit advanced tools still contain dry-run/readiness, which is correct as advanced, but not a substitute for webhook/status ops.

## P0 / P1 / P2 Priority Plan

### P0: Must Do Before Any Broad AUTO_PROVIDER Go-Live

1. Implement documented status client:
   - `GET /api/v2/orders/{orderId}` as the default status endpoint for all FazerCards order families.
   - Keep existing env override only as override, not as required config.
2. Implement FazerCards webhook receiver:
   - Route under Winnie, raw-body HMAC verification with `x-webhook-signature`.
   - Event idempotency by `event_id`.
   - Map `order.status_changed` safely to local order status.
   - Unknown status -> manual review, no blind refund.
3. Add response fixtures for TOPUPS, GIFTCARDS, GAME_KEYS:
   - success/completed
   - processing
   - failed/refunded/cancelled
   - missing order id
   - code/key payload present/missing
4. Confirm code/key delivered payload shapes from a real tiny order or official sample before broad code-delivery auto.

### P1: Must Do Before All-Products Launch

1. Implement Telegram docs-based contracts:
   - `POST /telegram/stars/buy`
   - `POST /telegram/premium/buy`
   - status/webhook handling.
2. Implement Steam Topup safely:
   - `POST /steam-topup/check-login` first.
   - `POST /steam-topup/order` only after validation and high-risk UX review.
3. Copy Manual Services `fields` from offers response into ProviderProduct/Product order fields.
4. Implement Manual Services order/chat only after operational workflow is approved.
5. Implement GameKeys region restriction storage/customer warning.

### P2: Nice-to-Have / Polish

1. Use `include_ui=1` in catalog sync where useful for images/covers.
2. Add admin webhook delivery diagnostics from `/account/webhook/deliveries`.
3. Add admin webhook setup/test/secret rotation tooling.
4. Add optional topup `validate-id` precheck to customer form for supported categories.

## Next Implementation Phases

Phase B: Status + Webhooks
- Add generic `/orders/{orderId}` client/status parser.
- Add signed webhook receiver and event idempotency.
- Update admin sync-status to use generic order status for all auto families.

Phase C: Confirmed Auto Execution Hardening
- Fixture/live-verify TOPUPS, GIFTCARDS, GAME_KEYS provider responses.
- Harden code/key parser against official/observed shapes.
- Enable controlled AUTO_PROVIDER only for verified products/families.

Phase D: Remaining Family Contracts
- Implement Telegram.
- Implement Steam Topup with check-login.
- Backfill Manual Service fields and decide whether to build provider order/chat workflow.
- Keep Steam Gifts disabled until account access is confirmed.

## Test Results

- Backend `npm.cmd run lint`: PASS. Syntax check passed for 258 JavaScript files.
- Backend `npm.cmd test -- providers.test.js --runInBand`: PASS. 1 suite, 127 tests.
- Backend `npm.cmd test -- products.test.js --runInBand`: PASS. 1 suite, 2 tests.
- Backend `npm.cmd test -- order.test.js --runInBand`: PASS. 2 suites, 20 tests.
- Backend `npm.cmd test -- admin.test.js auth.test.js --runInBand`: PASS. 2 suites, 101 tests.
- Backend `npm.cmd test -- provider.test.js --runInBand`: PASS. 1 suite, 54 tests.
- Frontend `npm.cmd run build`: PASS. Vite completed successfully; existing chunk-size warning remains.
- Frontend `npm.cmd run lint`: PASS with 8 existing React hook dependency warnings and 0 errors.

No real FazerCards order/buy endpoint was called during this audit.

## Current Git Status

Backend:

```text
## main...origin/main
?? docs/FAZERCARDS_API_RECONCILIATION.md
```

Frontend:

```text
## main...origin/main
```

No commits were made.
