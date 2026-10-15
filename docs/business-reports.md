# Dashboard business reports

Open Management → Reports. Every existing active staff session has access; customers and anonymous visitors do not. The feature does not change order, payment, stock, checkout, email, or affiliate payout behavior.

## Date and store filters

MTD, YTD, last month, last year, last 30 days, any calendar month, and custom dates are supported. Dates are inclusive in America/New_York, including DST. All-store and individual-store views are available. Ranges are limited to ten years.

## Available reports

- Overview: net product sales, verified net cash, paid orders, stock units, average product order, new/returning customers, and sales trend.
- Sales: monthly and daily summaries, paid-order details, orders placed by current status.
- Products: items and stock units sold, allocated discounts, net sales, known COGS, and product gross profit.
- Marketing: affiliate attribution, store commission estimates, promo-code performance, and recorded marketing spend.
- Customers: paid purchases, first verified purchase date, new/returning classification, and spending. Email matching is case-insensitive.
- Financials: management P&L, staff-recorded cash movements, payment-method totals, sales tax charged by shipping state, and current rewards exposure.
- Current operations: unpaid submitted orders and age, additional payments/refunds to settle, available inventory valuation.
- Costs and expenses: effective-dated product costs, paid operating expense entry, expense audit history, and voids with reasons.
- Detailed tables offer CSV exports. Exports include dates, timezone, store and generation time. Monetary columns are dollar decimals; missing product costs are explicit. Text is quoted and spreadsheet-formula prefixes are escaped. Tables show up to 100 rows; CSV includes all rows. Print/PDF prints the displayed report view; CSV is the full-detail export.

## Calculation basis

Only `is_test === false` orders with a valid `paid` timestamp contribute sales. The sale date is when staff verified the initial payment, not the order-creation date. Pending/unverified, canceled unpaid, expired unpaid and test orders are not sales.

Sales use **current paid-order values**. Later order changes restate the original payment period. Product subtotal minus promo and rewards discounts gives net product sales. Shipping and tax are separate. Discounts are allocated to products in whole cents with largest-remainder rounding; recorded promo exclusions are honored.

The cash ledger separately reconstructs the initial verified payment from cumulative verified payment less recorded additions plus recorded refunds, then includes each additional payment/refund on its own recorded date. It includes movements on older orders outside the selected sale window. Refunds are not subtracted twice from current adjusted sales. These are staff-recorded amounts, not bank reconciliation or payment-provider settlements.

The management P&L is net product sales plus shipping charged, less effective-dated product costs, the store's estimated affiliate commissions, and recorded operating expenses. Sales tax is excluded from income. An order with unpaid adjustments is still reported at its current value, with the outstanding balance in Current operations.

Product costs are per **stock unit**, not per kit. A quantity-two kit with ten stock units uses twenty times its effective unit cost. Costs take effect on the payment-verification date. Backdating/revising a cost recalculates affected historical reports; previous cost versions, actor and notes are retained. Unknown costs are not treated as zero: gross/operating profit is withheld until all sold product costs are present. A known zero cost must be entered explicitly.

Record paid operating expenses with date, category, store, vendor, amount and reference. Do not also record inventory purchases as expenses (COGS is already counted), or affiliate payouts (commissions are already estimated). Financing principal, owner withdrawals and capital purchases are not supported operating expenses. Posted expense amounts cannot be overwritten: void and replace, retaining the original. UUID IDs reject duplicate submissions, and revisions prevent stale edits.

All-store P&L includes shared expenses. Individual-store views exclude shared expenses and display their amount; no allocation is guessed.

Inventory, unpaid queues, adjustments due and rewards are **current snapshots**, unaffected by the date filter. Inventory counts each shared-stock pool once, uses stock available after reservations, and withholds valuation for missing/inconsistent costs or stock. Rewards exposure includes wallet balances and unclaimed non-held imported balances once; held email-review balances are separately disclosed. This is potential redemption face value, not an accounting liability calculation.

## Deliberate limits

This is management reporting, not a general ledger, bank-reconciled accounting system, tax filing, or formal financial statement. No WooCommerce history or external data is imported. GoAffPro remains the official commissions and payout ledger. Advertising sessions/conversions, campaign ROI, bank balances, complete cash-flow statement, balance sheet, accounts payable, income tax, depreciation and formal accounting for rewards require additional data and accounting policy. Unrecorded costs/fees make estimates incomplete even after product-cost coverage is complete.

## Verification

`node --test tests/store/business-reports*.test.cjs` covers exact-cent totals, exclusions, DST and range validation, historical payment/refund timing, effective costs, kits, missing costs, shared inventory, store filters, customers, rewards exposure, authenticated and revoked staff access, same-origin protection, expense duplicates/revisions/voids, UI views, CSV exports and stale report response races.
