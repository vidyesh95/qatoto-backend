-- ---------------------------------------------------------------------------
-- 0028 — a shared rate-limit store (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 7).
--
-- WHY. Every one of the 36 Express limiters used express-rate-limit's default
-- in-process MemoryStore. That is not a bound once more than one instance runs —
-- two instances mean double every documented limit, and an attacker who can pick
-- an instance multiplies by the fleet size. Worse, memory counters RESET ON
-- RESTART, so each deploy handed a fresh OTP and credential-stuffing budget to
-- anyone watching. §11l.2 recorded only the multi-instance half of that.
--
-- WHY POSTGRES AND NOT REDIS. The no-new-infrastructure doctrine, and a hard
-- constraint: the managed instance reports max_connections = 20 FOR THE WHOLE
-- SERVER (src/db/index.ts). A store sharing the existing pool costs one query on
-- an already-DB-bound request and zero new sockets; a library that opens its own
-- pool converts an in-pool wait into "sorry, too many clients already".
--
-- WHY A COMPOSITE PK RATHER THAN A CONCATENATED KEY. `emailKey` derives its
-- bucket key from the request BODY. With a "namespace:key" delimiter, an email of
-- "otpRequestIp:1.2.3.4" would land in the per-IP limiter's bucket and let one
-- caller spend another's budget. Two columns cannot be collided that way. The PK
-- prefix also makes resetAll a plain DELETE and `GROUP BY namespace` an answer to
-- "which limiter is hot".
--
-- WHY THE LENGTH CHECK. That same body field is unbounded, and a btree index row
-- caps at roughly 2704 bytes — an oversized key would be an attacker-triggerable
-- write failure on the OTP path. The store hashes anything over 256 chars to
-- `sha256:<hex>` first, so this CHECK asserts the normalizer ran rather than
-- validating user input.
--
-- NO id, NO created_at, NO FK. Nothing references a bucket. The row is UPDATEd in
-- place across many windows, so a created_at would record the first hit ever and
-- read as the window start; the real window start is expires_at minus windowMs.
-- And the key is a user id OR an IP OR an email, so no FK could hold for all three.
--
-- THIS IS A CACHE. Truncating it resets every live window and loses nothing else.
-- Expired rows are swept hourly by `pnpm db:cleanup-rate-limit-buckets`; only
-- ABANDONED keys accumulate, since a live key rewrites its own row in place.
--
-- Tuning lever, deliberately NOT set on day one: most updates touch only
-- hit_count, which is unindexed and therefore HOT-eligible, so
-- `ALTER TABLE rate_limit_bucket SET (fillfactor = 70);` would keep those updates
-- on-page if the table ever proves hot in production.
-- ---------------------------------------------------------------------------

CREATE TABLE "rate_limit_bucket" (
	"namespace" text NOT NULL,
	"bucket_key" text NOT NULL,
	"hit_count" integer NOT NULL,
	"expires_at" timestamp NOT NULL,
	CONSTRAINT "rate_limit_bucket_namespace_bucket_key_pk" PRIMARY KEY("namespace","bucket_key"),
	CONSTRAINT "rate_limit_bucket_key_ck" CHECK (char_length(bucket_key) BETWEEN 1 AND 256),
	CONSTRAINT "rate_limit_bucket_hits_ck" CHECK (hit_count >= 0)
);
--> statement-breakpoint
CREATE INDEX "rate_limit_bucket_expiresAt_idx" ON "rate_limit_bucket" USING btree ("expires_at");