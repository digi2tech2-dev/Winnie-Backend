# Phase 2.5U - Product Automatic Provider Linking Report

## Files Changed

- `src/modules/admin/admin.catalog.controller.js`
- `src/modules/products/product.service.js`
- `src/tests/catalog.test.js`
- `docs/PHASE_2_5U_PRODUCT_AUTOMATIC_PROVIDER_LINKING_REPORT.md`

## Backend Routes Used / Updated

- `GET /api/admin/product-provider-options`
- `GET /api/admin/product-provider-options/:providerId/products`
- `PATCH /api/admin/products/:id/provider-link`
- `POST /api/admin/products/:id/provider-sync` remains available for existing provider price sync behavior.

No duplicate provider-link routes were added.

## Provider Options Behavior

`GET /api/admin/product-provider-options` returns active provider picker data only:

- `id`
- `name`
- `slug`
- `code`
- `isActive`
- `authType`
- `credentialConfigured`
- `credentialsConfigured`
- `hasCredential`
- `supportedFeatures`

Credential values and encrypted credential fields are not returned.

## Provider Products Behavior

`GET /api/admin/product-provider-options/:providerId/products` supports:

- required provider id path parameter
- optional `search`
- optional `page`
- optional `limit`
- optional `includeInactive=true` for non-supervisor admin callers

The safe picker response includes provider product id aliases, external id, display name, min/max quantity, active state, and admin-safe price/currency when the requester is not a supervisor. Raw provider payloads, provider credentials, and internal mappings are not returned.

## Provider-Link Behavior

`PATCH /api/admin/products/:id/provider-link` now supports:

- automatic mode with `mode: "automatic"` or `fulfillmentMode: "AUTO"`
- manual unlink mode with `mode: "manual"` or `fulfillmentMode: "MANUAL"`
- optional sync flags: `syncPrice`, `syncName`, `syncLimits`

Automatic mode validates that:

- the product exists
- the selected provider product exists
- the provider product belongs to the selected provider
- the provider is active
- the provider product is active

Manual mode clears the provider refs and returns the product to manual execution without deleting customer order fields or dynamic fields.

## Manual vs Automatic Behavior

Manual products remain manual and are not made auto-fulfillable by normal product save requests. Product service now prevents setting `executionType: "automatic"` unless a provider product link is present.

Automatic links set provider/providerProduct refs and automatic execution only through the provider-link path after validation. When `syncPrice` is false, the provider cost snapshot is stored without overwriting the admin product price.

## Security Notes

- Provider credentials are never returned by provider option or provider product option responses.
- Raw provider payloads are not returned by the provider product picker route.
- Supervisor price protections remain in place: provider product price/cost fields are only included for non-supervisor admin-safe responses.
- Provider-link audit metadata stores ids and sync flags only, not credentials.
- Frontend provider selection is backed by backend routes; provider APIs are not exposed to the browser.

## Tests Added / Updated

`src/tests/catalog.test.js` adds coverage for:

- provider serialization exposes credential status without credential secrets
- a manual product cannot be made automatic without a provider link
- automatic provider link with manual pricing preserves the admin price
- automatic provider link with sync pricing uses provider price
- manual unlink clears provider refs and preserves order/dynamic fields

Existing order provider resolution tests continue to cover manual product behavior and provider-linked order resolution.

## Checks Run

- `npm.cmd run lint` - passed
- `npx.cmd jest src/tests/catalog.test.js --runInBand` - passed
- `npm.cmd test -- --runInBand` - passed, 28 suites / 726 tests
- `git diff --check` - passed

## Limitations

- The provider-sync route remains price-focused; broader one-click sync for name, image, category, or mapping is not expanded beyond the provider-link sync flags.
- Field-to-provider parameter mapping remains the existing manual `providerMapping` behavior and was not expanded in this phase.
- Provider product category is returned only when available in the current backend model; no raw provider payload parsing was added.

## Completion Status

Phase 2.5U backend work is complete.
