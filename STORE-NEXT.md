# Glow GLP’s store replacement — development version 0.2

The replacement is built separately at `/store-next/`. It does not change the live homepage, current checkout, WooCommerce stock script, or existing affiliate page. This is an isolated development branch. It is not a live-store release.

## Run locally

Install Node.js 22.13 or newer (Node 24 recommended for this local development build).

```bash
npm ci
npm run store:dev
```

Open the printed store URL and `/store-next/admin`. The terminal prints a random local admin password. Keep the process running while testing. Stop with Ctrl+C. On your own computer, you may set `STORE_ADMIN_PASSWORD` to a password of at least 12 characters before starting; generated credentials are not stored in the repository.

Local data is stored in `.store-data/store.sqlite`. This folder is ignored by Git. Do not use real customer details in this development build. Order confirmations retain their private access token in the current browser session. Order recovery links and email are not implemented yet.

## Working features

- Catalog import from the existing `catalog.json`, using the existing pricing rules and product images. The initial import contains 58 sellable product/size/bundle entries.
- **Demonstration inventory: 10 units per entry. These counts are not WooCommerce stock.**
- Cart, server-calculated cent-accurate totals, flat shipping and a free-shipping threshold based on the discounted product subtotal.
- Single percentage or fixed-dollar coupon; minimum subtotal, use limits, expiration and disabling.
- Private dashboard for products, dollar-based price editing, available stock, coupons, affiliates, payment recipient settings and shipping charge settings.
- Orders, private customer receipt submission (PNG/JPEG/WebP, 3 MB limit), manual payment verification, shipping/tracking entries, cancellation and reservation release.
- Atomic inventory/coupon updates, order submission replay protection and last-unit overselling protection.
- 24-hour expiry for unpaid orders without a receipt, checked on API requests. Receipt-submitted orders stay reserved until staff review/cancellation; they do not silently expire after a customer might have paid.
- Personalized affiliate storefronts at `/store-next/<slug>`, sharing the same catalog and preserving the affiliate on the order. Sample Sarah profile included.
- Stored GoAffPro ID mapping, commission estimates on discounted products (not shipping/tax), and integration preparation records created only after payment verification.
- ShipStation development payload review for paid orders. This is a dry run: nothing is sent. The order number is used as its deterministic external identifier.
- Admin login throttling, private HTTP-only session cookies, session expiry/revocation, request protection header, origin checks, and basic upload signature/size checks.
- Netlify function adapter at `/.netlify/functions/store-next?route=/catalog` and related routes. UI calls this adapter in both local and future hosted setups.

## Important catalog finding

The existing build command regenerates current-site prices and metadata from `catalog.json`. On the baseline checkout, running it changed some generated text, including KPV's advertised $25 sale back to the catalog's $33.99. Those generated changes were restored locally and are **not included** in this replacement change. The new store imports the source catalog price. Heather confirmed KPV is $33.99; the replacement already uses that price. Other catalog prices still need a final migration review.

## What is deliberately disconnected

Actual payments are disabled, regardless of saved recipient links. Taxes are visibly unconfigured and zero for fictional test orders. Setting `settings.demo` to false disables order submission rather than allowing unvalidated live checkout.

GoAffPro has no live conversion or cancellation synchronization yet. Affiliate cookies, affiliate coupon attribution, self-referral rules, commission overrides, profile login/photo upload, and the existing-account migration still need implementation and account testing.

ShipStation is not connected. The dry-run payload is a review aid; discount representation, parcel weights/dimensions, carriers/services, store IDs, account API version/permissions, retries, and verified tracking callbacks need implementation. No label purchase happens. Marking an order shipped locally does not yet mean it was dispatched by a carrier.

Email confirmations, password reset, per-staff logins/roles, secure receipt image decoding, receipt object storage, refunds, returns/restocking, tax configuration, and daily expiry/background integration jobs remain to be built. The single-password admin is for development, not the final staff identity system.

## Hosted persistence preparation

The function can use a private PostgreSQL database through server-only `STORE_DATABASE_URL`. Apply `tools/store/schema.sql`, then seed it with `STORE_DATABASE_URL` set and `npm run store:seed`. A subsequent seed run preserves existing data. PostgreSQL uses a single client per transaction with an advisory transaction lock to keep stock/coupon changes atomic. Local development uses SQLite with a serialized transaction queue.

This is an initial record-oriented schema, intended for testing and small initial workloads, not a high-volume final database design. Receipts are stored with private order records for now. Split receipts into secure object storage, add typed/indexed order/inventory tables and migration/version handling before scaling. PostgreSQL deployment has not been exercised against a real database in this environment.

Set the following **in the server environment only**, never in JavaScript sent to the browser or in GitHub:

- `STORE_DATABASE_URL`: private PostgreSQL connection string with provider-required TLS settings.
- `STORE_ADMIN_PASSWORD`: development password of at least 12 characters.
- `STORE_SESSION_SECRET`: random secret of at least 32 characters.
- `STORE_ORIGIN`: exact HTTPS origin of the isolated test site, for origin verification.

The function fails closed without a connected/initialized database or configured admin credentials. It does not fall back to ephemeral local disk in Netlify. The existing root publish directory is preserved; never create database files, secrets, or real receipt/customer exports inside public deploy output.

## Tests

```bash
npm run store:test
npm run store:test-ui
npm run build
```

The integration suite creates its own temporary database and leaves the development database alone. The existing build command changes generated live-site files; review and restore those unrelated build outputs if testing a separate replacement branch.

See `tests/store/store.test.cjs`. PostgreSQL deployment, live external integrations and carrier dispatch are not verified by local tests.

## Validation in this workspace

The 13 backend integration tests and frontend DOM/HTTP checks passed. The latter exercise the catalog, cart/coupon calculation, checkout rendering, order confirmation, admin authentication, dollar-price display and management views against a running local API. They do not replace a visual browser review. Chromium could not be executed in this environment, so rendered desktop/mobile layout and image-loading checks remain unverified. The existing catalog build passed; generated changes were restored as described above.
