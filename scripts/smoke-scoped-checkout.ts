/**
 * Proves a SCOPED checkout buys what it named and leaves the rest of the cart alone.
 *
 *   pnpm run db:smoke-scoped-checkout
 *
 * WHAT IT IS REALLY GUARDING is one line of `confirmCheckout`. It used to delete every line of the
 * cart — `WHERE cart_id = prepare.cart_id` — which was harmless only for as long as every prepare
 * covered every line. With `PrepareCheckoutSchema.items` a prepare can cover one, and that same
 * statement would silently empty the rest of the buyer's cart: they buy one chair and lose the four
 * lines they were still deciding on.
 *
 * ⚠️ THE ROUTE SUITE CANNOT CATCH THIS. It stubs the checkout service wholesale, so what it proves
 * is the boundary — which bodies parse, which refusal maps to which status. The cart-clearing
 * predicate, the reservation lifecycle and the seller grouping only exist against a real database.
 *
 * ⚠️ IT WRITES REAL ORDERS, and `commerce_order` is append-only, so they cannot be removed
 * afterwards. That is the same bargain every `smoke-store-phase-*` script makes; run it on a dev
 * database. It resets the buyer's CART first, so anything sitting in the demo buyer's cart is lost.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";

import { db, pool } from "#src/db/index.js";
import * as cartService from "#src/modules/store/orders/commerce-cart.service.js";
import * as checkoutService from "#src/modules/store/orders/commerce-checkout.service.js";

const ACTOR = {
  organizationId: "store_demo_org_buyer",
  memberId: "store_demo_member_store_demo_org_buyer",
  memberRole: "owner" as const,
  actorUserId: "zqKIGb1vMVhULR4BzWKFeobuGlMeRjb4",
};

/** Two products, two DIFFERENT sellers, same currency — the case the bug fix is about. */
const BOUGHT_PRODUCT = "devseed_prod_condenser-coil"; // devseed_org_atlas
const KEPT_PRODUCT = "devseed_prod_gasket-set"; // devseed_org_kestrel

async function cartLines(): Promise<readonly string[]> {
  // No row-type generic: a declared shape is a CLAIM about driver values, not a guarantee, and
  // asserting one here is what lets lint delete the conversion that makes it true.
  const rows = await db.execute(
    sql`SELECT l.product_id FROM commerce_cart_product_line l
        JOIN commerce_cart c ON c.id = l.cart_id
        WHERE c.buyer_organization_id = ${ACTOR.organizationId}
        ORDER BY l.product_id`,
  );
  return rows.rows.map((row) => String(row.product_id));
}

async function resetCart(): Promise<void> {
  await db.execute(
    sql`DELETE FROM commerce_cart_product_line
        WHERE cart_id IN (SELECT id FROM commerce_cart WHERE buyer_organization_id = ${ACTOR.organizationId})`,
  );
}

function check(label: string, passed: boolean, detail: string): boolean {
  console.log(`${passed ? "  ok  " : "  FAIL"}  ${label} — ${detail}`);
  return passed;
}

async function main(): Promise<void> {
  let failures = 0;

  await resetCart();
  for (const productId of [BOUGHT_PRODUCT, KEPT_PRODUCT]) {
    const added = await cartService.setCartItem(ACTOR, productId, 5);
    if (!added.success) {
      console.log(`could not seed cart with ${productId}:`, added.error);
      await pool.end();
      return;
    }
  }
  console.log("cart seeded:", await cartLines());

  // 1. A selector naming a line that is not in the cart is REFUSED, not narrowed.
  const bogus = await checkoutService.prepareCheckout(
    ACTOR,
    { items: [{ productId: "product-that-is-not-there" }] },
    `verify-bogus-${String(Date.now())}`,
  );
  if (
    !check(
      "a selector matching nothing is refused",
      !bogus.success && bogus.error.type === "CHECKOUT_ITEMS_NOT_IN_CART",
      bogus.success ? "PREPARED ANYWAY" : bogus.error.type,
    )
  )
    failures += 1;

  if (!check("the refusal left the cart alone", (await cartLines()).length === 2, "2 lines")) {
    failures += 1;
  }

  // 2. Scoped prepare + confirm.
  const prepared = await checkoutService.prepareCheckout(
    ACTOR,
    { items: [{ productId: BOUGHT_PRODUCT }] },
    `verify-scoped-${String(Date.now())}`,
  );
  if (!prepared.success) {
    console.log("  FAIL  scoped prepare —", prepared.error);
    await pool.end();
    return;
  }
  if (
    !check(
      "the prepare covers ONE line",
      prepared.value.items.length === 1 && prepared.value.items[0]?.productId === BOUGHT_PRODUCT,
      `${String(prepared.value.items.length)} item(s)`,
    )
  )
    failures += 1;

  const heldBefore = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM commerce_inventory_reservation
        WHERE checkout_prepare_id = ${prepared.value.prepareId} AND state = 'held'`,
  );
  if (
    !check(
      "stock is held for the bought line only",
      heldBefore.rows[0]?.n === 1,
      `${String(heldBefore.rows[0]?.n)} reservation(s)`,
    )
  )
    failures += 1;

  const confirmed = await checkoutService.confirmCheckout(
    ACTOR,
    { prepareId: prepared.value.prepareId },
    `verify-confirm-${String(Date.now())}`,
  );
  if (!confirmed.success) {
    console.log("  FAIL  scoped confirm —", confirmed.error);
    await pool.end();
    return;
  }
  if (
    !check(
      "exactly ONE order, for the right seller",
      confirmed.value.orders.length === 1,
      `${String(confirmed.value.orders.length)} order(s)`,
    )
  )
    failures += 1;

  // 3. THE ASSERTION THIS WHOLE CHANGE IS ABOUT.
  const remaining = await cartLines();
  if (
    !check(
      "the OTHER seller's cart line SURVIVED",
      remaining.length === 1 && remaining[0] === KEPT_PRODUCT,
      `cart now holds [${remaining.join(", ")}]`,
    )
  )
    failures += 1;

  if (
    !check(
      "the bought line is gone",
      !remaining.includes(BOUGHT_PRODUCT),
      remaining.includes(BOUGHT_PRODUCT) ? "still there" : "removed",
    )
  )
    failures += 1;

  const consumed = await db.execute(
    sql`SELECT state::text AS state FROM commerce_inventory_reservation
        WHERE checkout_prepare_id = ${prepared.value.prepareId}`,
  );
  if (
    !check(
      "its reservation went held → consumed",
      consumed.rows.every((row) => String(row.state) === "consumed"),
      consumed.rows.map((row) => String(row.state)).join(", "),
    )
  )
    failures += 1;

  // 4. The unscoped path still clears the whole cart.
  const wholeCart = await checkoutService.prepareCheckout(
    ACTOR,
    {},
    `verify-whole-${String(Date.now())}`,
  );
  if (!wholeCart.success) {
    console.log("  FAIL  unscoped prepare —", wholeCart.error);
    await pool.end();
    return;
  }
  const wholeConfirm = await checkoutService.confirmCheckout(
    ACTOR,
    { prepareId: wholeCart.value.prepareId },
    `verify-whole-confirm-${String(Date.now())}`,
  );
  if (!wholeConfirm.success) {
    console.log("  FAIL  unscoped confirm —", wholeConfirm.error);
    await pool.end();
    return;
  }
  if (
    !check(
      "an UNSCOPED checkout still empties the cart",
      (await cartLines()).length === 0,
      "cart empty",
    )
  )
    failures += 1;

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${String(failures)} CHECK(S) FAILED`}`);
  await pool.end();
}

await main();
