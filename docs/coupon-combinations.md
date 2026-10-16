# Coupon combinations

Management → Coupons → Edit → **Can this coupon be used with other offers?**

- **No** (default): the coupon can be used alone, but not alongside another coupon code.
- **Yes**: the coupon can be combined with other codes that also have Yes selected.
- Existing coupons with no stored setting remain exclusive. Saving through an older client without the field preserves an existing choice.
- Rewards points are exempt from coupon exclusivity, preserving the existing loyalty program.
- Existing product promo exclusions apply to every coupon; shipping and tax are not discounted.
- The rule controls coupon combinations. It does not infer or alter sale prices already entered on products.

Customers apply codes one at a time in the bag and can remove individual codes. Up to five distinct codes are supported. Applying an incompatible code keeps the previous valid cart and displays an error.

Percentage discounts are applied sequentially (not added), sorted by code for deterministic rounding; fixed-dollar discounts follow, sorted by code. Each step rounds down to whole cents and is capped at the remaining eligible product amount. For example, $100 eligible products with 20% off, then 10% off, then $5 off gives $67 in products before shipping, tax or rewards.

Every coupon must separately pass store, active, expiry, minimum and usage checks. Coupons belonging to different affiliates cannot combine; same-affiliate or general coupons may combine when permitted. Attribution is assigned server-side. GoAffPro receives the full code list.

`coupon` retains the first code for older clients. `coupons` contains the full list. `coupon_discounts` records the calculation breakdown. Usage is reserved/released for every code on order creation, draft editing, cancellation, expiry and staff reinstatement. Transactions prevent concurrent final-use redemptions. Reinstatement keeps its existing staff override behavior and original order amounts.

Sales reports show coupon combinations as one group, so an order's sales are not counted multiple times. General store data and existing saved coupons are not migrated or automatically enabled for stacking by deployment.

Validation: `node --test tests/store/coupon-stacking*.test.cjs` exercises admin controls, legacy defaults, server-side enforcement, totals, exclusions, loyalty points, limits, edits, cancellation, expiry, reinstatement, concurrency, GoAffPro payloads, and bag behavior.
