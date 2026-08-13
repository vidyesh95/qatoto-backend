-- Appendix A17, finished — the ceiling that makes "a sample is the negation of bulk" true.
--
-- 0061 gave the cart, prepare, order and reservation lines an `is_sample` flag, and
-- `commerce-pricing` prices a sample line at `minimum_order_quantity: 1`, skipping the tier
-- ladder. Nothing ever bounded it from above. `SetCartItemSchema.quantity` is a positive
-- integer, the service ceiling is MAXIMUM_CART_LINE_QUANTITY = 1,000,000, and a sample line
-- of 1,000 is a bulk order wearing a sample's pricing — with the MOQ bypassed by design.
--
-- The sharp end is `refundable`. `mintSampleCreditsForOrder` mints a credit worth the SUM of
-- the sample line totals, i.e. quantity x sample_price_in_cents. Order 1,000 samples, take
-- delivery, receive a credit for the entire amount, spend it whole against a second order
-- with the same seller. Roughly half price at scale, against a rebate the seller offered for
-- one unit.
--
-- HAND-WRITTEN, like every store-phase migration since 0046.
--
-- Additive and safe on landing: the column defaults to 1, so every existing listing gets
-- Alibaba's ordinary case (one sample, priced per piece) rather than an open door, and no
-- seller has to act for the hole to close.

-- 20 keeps a legitimate "sample pack" expressible while keeping the cap itself from being set
-- to a number that reopens the hole it exists to close.
ALTER TABLE "product" ADD COLUMN "maximum_sample_quantity" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_maximum_sample_quantity_ck" CHECK (maximum_sample_quantity BETWEEN 1 AND 20);
