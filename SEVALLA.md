# Sevalla recovery build

This branch starts from GitHub commit `11bce3602049d3498df9e82a8deb498c48eedb12`, including the database bandwidth repair. The old Netlify deployment is unchanged. The code repository is not a backup of the live database.

## Application

Use **Application hosting**, Node 24, and the included Dockerfile. The process listens on `0.0.0.0:$PORT` (default 8080). Custom start command if not using Docker: `npm start`. No Netlify build service or Netlify database adapter is needed by this process. The existing API URLs remain supported so saved links and checkout code need not change.

Keep the application on its Sevalla preview address until data and checkout have been verified. Use `/health/live` for process health; `/health/ready` checks the database table. Files in tools, tests, netlify, private directories and environment files are not served publicly.

## Private database and secrets

Create a managed PostgreSQL database and link it to the app using Sevalla's internal network. Set its connection URL as `STORE_DATABASE_URL`. Set `STORE_ORIGIN` to the exact HTTPS preview origin (no trailing slash) during verification, then the canonical live origin at cutover. Configure `STORE_ADMIN_PASSWORD` (12+ characters) and `STORE_SESSION_SECRET` (32+ random characters) privately. Do not set `STORE_LOCAL` or commit credentials.

For a NEW database, run `npm run store:init-db` once, then `npm run store:recover-catalog`. Recovery populates the saved catalog, Glow Fuel spotlight and apparel variants. All stock is zero, checkout is disabled, payment links are empty, and no sample customers, rewards, affiliates or coupons are created. It refuses an existing/partially imported database and suppresses the old automatic shirt-opening-stock routine. **Do not run `store:seed` in production:** that older development command creates demonstration inventory and affiliates.

If the Netlify database remains locked, recover the catalog from repository migrations and verified owner records. Enter confirmed inventory and current prices through management or a reviewed import. Keep checkout disabled until that verification is complete. Historical orders, accounts/password hashes, rewards, affiliates, coupons, uploaded photos/receipts and saved integration settings require a database export or another verified backup. Do not invent balances, substitute sample customers or treat old seed stock as available stock.

Preserving the original session secret is necessary for existing encrypted email jobs and some private links. Without it, require new sign-ins/setup links and review old jobs rather than automatically resending them. Third-party API keys must be configured privately in Sevalla. Use `STORE-NEXT.md` and the integration modules for the full variable list; live provider tests remain required.

## Background tasks and payments

Scheduled jobs are separate one-shot commands:

* `npm run store:worker -- email` — every minute.
* `npm run store:worker -- shipping` — every minute; may purchase labels when the existing saved shipping settings enable this.
* `npm run store:worker -- calls` — hourly at minute 15; existing code selects noon Eastern.

They refuse to run unless `STORE_WORKERS_ENABLED=1`. Enable only after checking settings and stopping the corresponding Netlify workers to avoid duplicate integrations. Run only one instance of each scheduled job. The existing Stripe webhook path is supported and still verifies signatures and the invoice with Stripe before marking an order paid. Verify webhook configuration after domain cutover; do not simulate real payments.

## Release checks still required

Verify private PostgreSQL connectivity, initialized catalog and actual stock; owner/staff/customer sign-in; English/Spanish and affiliate links; product photos; quotes/coupons/rewards and free shipping after discounts; screenshot upload; email delivery; shipping and paid-order integration; and canonical-domain TLS/DNS. Keep Netlify and its data intact until reconciliation is complete. Existing orders must not be reset or re-invoiced during recovery.
