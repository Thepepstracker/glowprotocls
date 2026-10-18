# Zader Health affiliate program

Zader owns this program. Glow keeps its existing GoAffPro integration.

## Staff setup

1. Open https://zaderhealth.com/store-next/admin and choose Affiliates.
2. Add an affiliate with their email and a unique storefront slug, or review an application.
3. Set the commission percentage, select Approved, and save. No rate is assumed. Pending and disabled profiles cannot receive new referrals.
4. Use Email account setup / reset when you want to send their private account email. The affiliate chooses their own password. Existing verified customer accounts use the same login.
5. In Coupons, select Zader Health and choose the affiliate as the owner to create their customer discount code. Coupon combinations retain the two-code maximum and product exclusions.

## Affiliate experience

The application and private dashboard are at https://zaderhealth.com/store-next/affiliate. Applicants must verify their email through the existing customer account system before applying. Their account can edit its own public display name, biography and headshot; it cannot change approval, rate, customer identity or payment records.

Approved affiliates get a personalized storefront, their assigned active discount codes, referral-order summaries, net commissions, payouts and ledger history. Customer contact and shipping data are excluded. Headshots are decoded, resized, re-encoded and stripped of original metadata.

Valid referral links persist for up to 30 days in the same browser when local storage is available. A newer explicit affiliate link wins. Affiliate coupon ownership takes priority over the storefront referral. No cross-device or third-party-cookie attribution is claimed.

## Money and order rules

- Commission uses the product subtotal after all promo and rewards discounts, excluding shipping and tax.
- Each native order snapshots its commission rate. Subsequent staff changes to an affiliate's rate do not change paid orders.
- Payment screenshots alone do not accrue commissions. Staff must verify payment. Test orders and self-referrals cannot earn.
- New native affiliate orders keep the ZDR- prefix and never enqueue GoAffPro sales.
- Commissions are held while an additional payment or refund remains unsettled. Final order adjustments reconcile the ledger using the order's saved rate.
- Ledger entries are append-only; per-order reconciliation prevents duplicate earnings. A later refund can leave a negative affiliate balance if an earlier payout has already been made.
- Disabled affiliates retain their accounts and financial history; new referral checkouts are rejected. Existing valid orders retain their contractual rate.

## Payout records

Staff record externally completed payouts using the actual method, amount and unique transaction reference. No money is transferred and no store-credit coupon is issued by this action. Server-side transaction locking, balance checks, idempotency keys and unique method/reference checks prevent duplicate or overdrawn payouts. Returned or disputed funds require business review; payouts are not silently erased.

## Implementation and validation

Native records use the existing transactional record database and separate native affiliate ledger, per-order reconciliation and payout record kinds. There is no database schema migration. Existing Glow affiliate rows retain their implicit glow brand. Shared staff access, stock and shipping infrastructure are unchanged; this is program separation, not a new staff-permission boundary.

Tests cover native applications and approval, store isolation, self-referrals, coupons, rewards, verified payments, rate snapshots, edits, refunds, concurrent and duplicate payouts, private profiles, decoded photos and browser referral expiry. Existing coupon, account, reporting and dashboard tests are retained. The two existing management-workflow failures (obsolete initial-expiry expectation and an incomplete isolated DOM fixture) were reproduced on the unmodified base commit and are unrelated to this program.
