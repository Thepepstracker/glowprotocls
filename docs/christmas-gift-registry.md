# Glow Christmas gift registry

## Customer experience

Open **My wish list** in the Glow header or account dashboard (`/store-next/?wishlist=mine`). Each verified customer has one personal list with up to 100 distinct catalog products/variants. Use **Save to wish list** on catalog cards or the variant/product chooser in the editor. Customers can add/remove products and edit the public title. No desired/purchased quantity or fulfillment state exists: even six purchases of one favorite leave it on the list.

Lists start private. **Create sharing link** produces a URL such as `/store-next/#registry=<random-token>`. Copy, native sharing, text-message and email buttons open the customer's own apps; no message is sent by the server. The customer selects recipients and sends. Anyone holding the link can view the title and selected products without signing in. The title is explicitly public; the account name is never copied into it. **Replace sharing link** invalidates the previous link, and **Turn sharing off** revokes it.

Guests add individual items to their normal bag and use the existing checkout with their own contact and shipping details. There is no automatic access to the owner's address, account, rewards, orders, purchases or buyer names. Shipping to the buyer for gift delivery works without contacting the owner. The registry does not provide hidden-address shipping to the owner.

Inactive/deleted products remain as unavailable placeholders. Active sold-out products retain current names/prices but cannot be added to the bag. Lists refer to product IDs; prices, kits/bundles and availability are resolved from the current catalog rather than stored snapshots. Checkout rechecks actual inventory and applies existing prices, coupons, rewards, shipping, invoice/screenshot payment and order validation. Saving a favorite does not reserve stock.

## Integration and privacy

- `gift-registry.cjs` owns `gift_registries`, `registry_links` and `registry_limits` record kinds in the existing `glow_store_records` table. No schema migration, customer rewrite or data backfill is needed.
- `GET /api/registry` reads only the signed-in customer's list. `POST /api/registry` accepts a specific action and expected revision, never a caller-specified owner. Supported actions: `add`, `remove`, `rename`, `share`, `rotate`, `unshare`.
- Existing verified, revocable customer sessions authorize editing. Existing POST request-header/origin/fetch-site protection applies. Serialized transactions and expected revisions prevent lost edits. Edits are limited to 60 per customer per minute.
- `GET /api/registry/shared` takes `X-Registry-Token`. Its response is explicitly allowlisted to title and product ID/name/current price/image/availability. Missing, invalid, revoked and unknown tokens return a generic 404. Other brands cannot access Glow registries.
- Sharing capabilities use 32 cryptographically random bytes (256 bits). The public index is keyed by SHA-256. The private owner record retains the raw token so the owner can copy it later; treat registry storage/backups as confidential. Avoid logging `X-Registry-Token`.
- Tokens stay in the URL fragment, never the query string or path. Shared reads omit account cookies. Responses are `no-store` and `noindex`; existing HTML servers use `Referrer-Policy: no-referrer`. A person can forward an active capability link; revocation stops subsequent retrieval but cannot erase screenshots or previously viewed content.
- Registry routes dispatch before account reconciliation, order expiration or legacy migrations. Registry reads/writes never run those unrelated jobs. They do not create/change customers, orders, payment settings or inventory.
- Sharing preserves the current resolved affiliate context as a `ref` when present. Opening a shared link follows the same existing referral restoration and coupon-over-link precedence as ordinary shopping. No registry owner identity becomes a checkout identity, and no new commission logic is introduced.
- `registry.js` loads before `app.js` in each app shell. The existing SPA route, API, bag and checkout are retained. The local development adapter now recognizes `/api/*`, matching the Sevalla frontend.

## Hosting verification (October 29, 2026)

The inspected `main` commit was `11bce3602049d3498df9e82a8deb498c48eedb12`. The `sevalla-recovery` branch was `84ec539234e668ae82e44db2541148685223ffd2` and contains `Dockerfile`, `SEVALLA.md`, `tools/sevalla/server.cjs`, PostgreSQL access via `STORE_DATABASE_URL`, and `npm start`.

Read-only public observations:

- `https://glowglps.com/` returned HTTP 200, Cloudflare proxy headers and `Cache-Control: no-store`.
- `https://glowglps.com/health/live` returned `ok`; `/health/ready` returned `ready`, consistent with that Node server and its database readiness probe.
- The live `/store-next/app.js` and `sevalla-recovery` file had the same SHA-256: `737f7367e90452d3e97c2f2fe8757238dfa177275e828d2d3ec1dc2a18395e9e`.

This establishes a matching public frontend and compatible active server routes. It does not independently prove the Sevalla dashboard's selected branch, exact deployed backend commit, database identity, worker schedules or deployment settings. No dashboard configuration, environment variable, DNS record, deployment, production API write or database operation was performed. No production catalog/account/order API was queried during this review.

The pull request targets `sevalla-recovery`, avoiding a regression to the Netlify-only main branch. Review and test the proposed commit in an isolated staging environment with fixture data before choosing a release. Confirm the deployment branch/commit in the hosting dashboard before merging into any auto-deployed branch. Do not run seed/recovery/import commands on the existing production database. This feature needs no hosting migration, payment change or new service.

## Validation

Run `node --test tests/store/gift-registry*.test.cjs` for API/SQLite isolation, ownership, CSRF, revision conflicts, limits, capability security/revocation, unavailable products/kit/bundle availability, six duplicate guest purchases, existing affiliate/discount/payment behavior, Sevalla HTTP routing and owner/guest DOM behavior. UI tests also execute the real app startup and click dispatcher, verifying that shared purchases keep the buyer's affiliate context. All use disposable fixture data or mocks, never production credentials.

The full `npm run store:test` suite has seven failures also reproduced on an untouched checkout of `84ec539`: dashboard product/coupon rendering (missing `productOfferFields` fixture), two email/order flow expectations, two invoice/order UI expectations, catalog import expectations, and a stock-adjustment fixture. They are pre-existing and outside this registry change. The separate legacy `store:test-ui` harness also fails on the untouched branch (`setInterval` is not supplied to its VM); registry DOM tests supply their own current environment. Browser-rendered layout, actual mobile messaging apps, real provider payments and production PostgreSQL integration have not been exercised.
