# Glow GLP’s store replacement — development version 0.2

The replacement is built separately at `/store-next/`. It does not change the live homepage, current checkout, WooCommerce stock script, or existing affiliate page. This preview is deployed on Netlify, while the main store checkout remains unchanged. Payments remain disabled in the preview. Server-side reporting is ready for verified live orders; preview orders are never sent.

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

Checkout starts in preview mode. Dashboard Settings now provides an authenticated preview/live switch. Live activation requires at least one saved payment recipient, an active in-stock product, and explicit confirmation that no sales tax is charged, matching the owner’s current checkout. Existing test orders stay test orders when the mode changes. Live checkout shows only configured payment methods; screenshots require actual image decoding and staff payment verification.

GoAffPro can report verified live orders through the server API. Cancellation/refund synchronization is not implemented yet. Affiliate cookies, affiliate coupon attribution, self-referral rules, commission overrides, full affiliate account sign-in, and account testing still needs to be completed before launch. Approved affiliate profiles can now create named storefronts. Private links allow affiliates to upload their own photo.

ShipStation is not connected. The dry-run payload is a review aid; discount representation, parcel weights/dimensions, carriers/services, store IDs, account API version/permissions, retries, and verified tracking callbacks need implementation. No label purchase happens. Marking an order shipped locally does not yet mean it was dispatched by a carrier.

Automatic email confirmations, per-staff logins/roles, receipt object storage, refunds, returns/restocking, automated tax calculation, and daily expiry/background integration jobs remain to be built. Password reset uses private staff-issued links; screenshots are decoded, re-encoded without metadata, and stored privately in the database. The single-password admin is for development, not the final staff identity system.

## Netlify Database setup

Netlify Database can now be provisioned from Data & storage > Database. The store uses the official @netlify/database pool in Netlify Functions when STORE_DATABASE_URL is not supplied. Netlify applies netlify/database/migrations/0001_glow_store.sql before publishing. This migration creates the store table and imports 58 catalog entries with **zero stock**, preserves existing records, and creates no sample coupons or affiliates. Payments remain disabled pending launch work. No database credentials need to be copied into chat or GitHub.

Configure STORE_ADMIN_PASSWORD (at least 12 characters), STORE_SESSION_SECRET (at least 32 random characters), and STORE_ORIGIN=https://glowglps.com in Netlify for Functions before deployment. Use the actual canonical origin if domain settings redirect elsewhere. Database creation alone does not deploy the store branch. Hosted connection and migration still require a real deploy verification.

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

The 14 backend/migration checks and frontend DOM/HTTP checks passed. The latter exercise the catalog, cart/coupon calculation, checkout rendering, order confirmation, admin authentication, dollar-price display and management views against a running local API. They do not replace a visual browser review. Chromium could not be executed in this environment, so rendered desktop/mobile layout and image-loading checks remain unverified. The existing catalog build passed; generated changes were restored as described above.

## GoAffPro connection check

The management Affiliates tab can verify the GoAffPro credential and preview the first 100 approved profiles (ID, name, referral code and status). The connection check is read-only. A separate Create approved storefronts action creates local named storefronts from approved GoAffPro profiles. The storefront importer does not synchronize coupons or report orders. Reporting is a separate server-side workflow; payouts are not automated.

Create a restricted API key in GoAffPro Settings → Developer. `affiliate.profile.read` is used by this check; `sales.read` and `sales.write` are reserved for the upcoming paid-order integration. Save the private X-GOAFFPRO-ACCESS-TOKEN value as `GOAFFPRO_ACCESS_TOKEN` in Netlify's production Functions environment, preferably marked as a secret. Never commit the value or put it in browser code. Redeploy after adding it, then sign in at `/store-next/admin`, open Affiliates, and click Check GoAffPro connection.

Connection verification is tied to a hash of the currently configured key. Replacing the key requires another check. The public token is not used in this phase. Verified live-order reporting is implemented; test orders are never reported as genuine sales. Existing WooCommerce affiliate tracking remains separate until the eventual checkout cutover.


## Named storefronts and affiliate photos

In management → Affiliates, **Create approved storefronts** imports approved profiles in pages of 100, up to 10,000 profiles per run. Each local storefront gets a friendly unique name-based slug, the GoAffPro affiliate ID, a blank editable introduction, and a 15% local estimate. This estimate does not change GoAffPro commissions. Existing records matched by GoAffPro ID retain their slug, name, introduction, estimate and enabled/disabled state on repeat imports. The importer does not automatically disable profiles later removed from GoAffPro; staff must disable them locally until continuous status synchronization is implemented.

Use **Copy store link** to share `/store-next/<slug>`. Editing an existing storefront locks its slug in the form to preserve links. Public profile responses contain only its display name, introduction and photo URL; the whole affiliate roster and internal IDs are not included in the public catalog. Orders snapshot the GoAffPro affiliate ID internally at creation, alongside storefront attribution.

Use **Photo upload link** to generate a private link for an affiliate at `/store-next/profile/<slug>#<token>`. Only the staff dashboard can issue these links. They expire after 30 days and issuing a new one immediately invalidates the previous one. Staff must share this link directly with the correct affiliate; the public storefront link and private photo link serve different purposes. The fragment token is removed from the address bar after opening and kept in that browser's session storage. The server stores only its hash and expiry.

The private page can upload or remove only that affiliate's photo. It cannot edit products, prices, inventory, commissions or orders. Accepted still JPEG/PNG/WebP inputs are limited to 3 MB and 25 million pixels. Sharp decodes them, applies orientation, crops to 512×512, and encodes a new JPEG without retaining EXIF/location metadata or original bytes. Photos are stored separately from affiliate records and shown publicly only on active storefronts. Native sharp and its Linux x64 image libraries are packaged with the Netlify function. Link authorization, cross-site rejection, image decoding, metadata removal and ownership isolation are covered by local tests. Actual affiliate imports and photo uploads should be verified in the signed-in production dashboard after deployment.


## Verified-order GoAffPro reporting

The server calls the official `/v1/admin/orders` API after staff confirm payment, using the affiliate ID snapshotted on the order. Current checkout is still a demo: new orders are marked `is_test:true` by the server, and older records without an explicit `is_test:false` also remain excluded. Staff can enable live checkout in Settings after the readiness checks pass; existing demo orders cannot be converted into real orders.

Before launch, use **Check order reporting permissions** in management → Affiliates. The private key needs `sales.read`, `sales.write`, `affiliate.profile.read`, and `affiliate.email.read`. The permission check reads order lookup and an approved affiliate's email without sending sales. The first eligible live sale still needs a real GoAffPro round-trip check to validate the write permission and the existing program's commission rules. The email scope is used only on the server to block exact email self-purchases and is never included in the public affiliate profile or the permissions-check response.

The payload uses decimal USD amounts converted from integer cents, the product subtotal after discounts as the commission base, separate shipping/tax amounts, proportionally allocated line discounts, namespaced product IDs, and `forceSDK:true` to bypass WooCommerce platform enrichment. It does not supply a commission override. GoAffPro's rules determine the actual commission; local dashboard values are estimates. Storefront attribution is supported; affiliate cookies, coupon-only referrals and full refund/cancellation synchronization remain separate launch work.

Paid order details show **GoAffPro reporting**, a dry-run payload preview, and a report/reconciliation button for live orders. A persistent outbox and a 90-second claim prevent concurrent sends. Reporting first checks for an existing sale with the same order number, amount, discounted subtotal and affiliate. Before POST, the outbox commits `post_started:true`. Any timeout, unexpected response, crash, or missing remote confirmation after this point requires read-only reconciliation; it never blindly repeats the POST. A definite HTTP 401/403 denial allows a retry after correcting the key. Conflicting existing sales require staff review. If a sale remains invisible after an ambiguous request, staff must resolve it with GoAffPro; the store deliberately has no force-resend button. Changing the API key after an uncertain send also requires review to avoid reconciling against a different account.

Reporting failure never reverses saved payment verification. Failures are visible on the order and can be checked from its detail page. There is no scheduled retry worker yet, and no browser conversion script is installed, which avoids reporting an order both on the thank-you page and on payment verification. Tests use mocked GoAffPro responses and real local persistence; they cover successful reporting, amount conversion, discount allocation, test/legacy suppression, self-purchases, concurrent requests, pre-existing sales, uncertain sends/reconciliation, conflicts and definite credential rejections. No real sale or commission was created by these tests.


## Customer accounts and rewards

- `/store-next/account` provides account setup requests, sign-in, point balance, ledger and associated orders. `/store-next/account-setup#<customer-id>.<token>` lets the email recipient choose a password. Account setup links are private, single-use, rotated when reissued, and expire after 24 hours. Customer passwords use salted asynchronous scrypt; hashes never leave the backend. Customer cookies are HttpOnly, SameSite=Strict, Secure in production, revocable, and expire after seven days. A password reset invalidates every earlier session.
- Automatic customer email delivery is **not configured**. Under Dashboard → Customers, staff create a setup/reset link and send it only to the email shown, using the trusted business email channel. Do not send a link to a requester at an unrelated address. The recipient sets the password through the private link; the storefront does not reveal unverified balances.
- Rewards use whole points: one point per whole dollar of the product subtotal after all discounts, excluding tax and shipping. Each point redeems for five cents; single-point increments are allowed. Points stack with one coupon, never expire, and have no active membership tiers. Fractional earning dollars are rounded down per order. Confirm these rounding/increment choices against the old program before live launch.
- On order submission, redemption is reserved atomically with stock and coupon usage. Cancellation/expiration releases the hold; uploaded receipts remain pending staff review. Verified payment settles redemption and awards earnings exactly once. Test and legacy orders never earn or spend real rewards. Discounts reduce the affiliate commission basis and shipping-threshold subtotal. Balances and money are calculated on the server.
- Dashboard → Customers accepts the saved migration JSON containing `customers` with `email`, `source_name`, integer `points`, and `redeem_points` (integer or null). Preview first, then import. Repeated identical imports never credit twice; conflicting prior balances stop the transaction. Imported unheld rows create pending accounts; matching balances become available after email setup. Historical redeemed points are preserved as history, never subtracted again. `gmail.coml` is held for manual email review. Similar but distinct addresses remain separate. A missing historical redeemed amount is preserved as null. Verify the WP Swings Points column represents the available balance before importing.
- The migration JSON contains customer information: **never commit it to GitHub, embed it in public assets or add it to a Netlify migration**. Upload it through the authenticated admin form. This feature does not import any customers automatically from the source code.
- Staff can enter signed point adjustments with a required reason; each adjustment is recorded in the append-only ledger. A negative correction may leave a debt; availability is clamped at zero and future earnings offset it. Refunds, cancellation after paid, and GoAffPro commission reversals still require separate staff handling; there is no automatic refund processor.
- Live ordering requires server-owned `settings.demo=false`, `settings.checkout_enabled=true` and `settings.tax_mode=none`, saved through the authenticated Checkout mode form. The old environment-only activation flag is no longer required. This code deployment does not change the production mode or inventory. GoAffPro’s first eligible live report, manual account-email delivery and manual shipment handling remain operational requirements.

## Dashboard and checkout completion

Business metrics exclude test and legacy orders without explicit `is_test:false`. Orders can be searched by number, name, email or affiliate, and filtered by status and live/test type. US state/territory and ZIP syntax are validated before inventory reservation; this is not carrier address verification. Receipt processing preserves the complete screenshot without cropping, caps dimensions and removes embedded metadata. Staff must still verify funds in the receiving account.
