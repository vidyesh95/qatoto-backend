-- ---------------------------------------------------------------------------
-- 0026 — request idempotency (R_AND_D_BACKEND_STRUCTURE.md §11l.2 item 3).
--
-- WHY A TABLE RATHER THAN A COLUMN PER VERB. Four surfaces already carry a
-- body-borne key with its own unique index, and that shape is right where the key
-- is part of the domain row. It does not generalize: a pledge, a finalize, a
-- countersign and a dispute have nowhere natural to put one, and adding a column
-- plus a partial unique index to each is a migration per verb on a list that keeps
-- growing. One table storing the RESPONSE covers all of them, and the frontend
-- already mints a key per attempt that those endpoints ignore today.
--
-- `request_fingerprint` is the part that matters. Without it, a client recycling
-- one key across two different pledges receives the FIRST pledge's receipt for the
-- second and believes both landed.
--
-- 2xx ONLY, by CHECK. Recording a failure would make a retry after a transient 500
-- replay that 500 forever — the opposite of what a retry is for.
--
-- NOT append-only, and no audit weight: this is a replay cache. It cascades with
-- the user and is safe to prune on a retention window.
-- ---------------------------------------------------------------------------

CREATE TABLE "idempotency_record" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_method" text NOT NULL,
	"request_path" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_record_key_ck" CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
	CONSTRAINT "idempotency_record_fingerprint_ck" CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "idempotency_record_status_ck" CHECK (response_status BETWEEN 200 AND 299)
);
--> statement-breakpoint
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_record_userId_key_unq" ON "idempotency_record" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idempotency_record_createdAt_idx" ON "idempotency_record" USING btree ("created_at");