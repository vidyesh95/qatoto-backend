import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pool } from "#src/db/index.js";
const eligible = await db.execute<{ id: string; status: string; slug: string }>(sql`
  SELECT p.id, p.status, coalesce(p.public_slug,'-') AS slug FROM product p
  JOIN commerce_organization o ON o.id = p.seller_organization_id
  JOIN commerce_category c ON c.id = p.category_id
  WHERE p.status='active' AND p.moderation_state='approved' AND p.public_slug IS NOT NULL
    AND o.trade_state='active' AND o.visibility='public' AND c.state='active' LIMIT 2`);
const draft = await db.execute<{ id: string; status: string }>(sql`
  SELECT id, status FROM product WHERE status='draft' LIMIT 2`);
console.log("eligible:", eligible.rows);
console.log("draft:", draft.rows);
console.log("cloudinary:", process.env.CLOUDINARY_CLOUD_NAME ? "configured" : "NOT configured");
const anime = await db.execute<{ c: string }>(sql`SELECT count(*)::text c FROM anime_episode`);
console.log("existing anime_episode rows:", anime.rows[0]?.c);
await pool.end();
