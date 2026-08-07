-- Store Appendix A8 — reviews become readable.
--
-- Before this migration `POST /commerce/completions/:completionId/reviews` was the ONLY
-- review route in the codebase. A buyer could write a review and nothing could ever
-- display it; only `averageRating` and `reviewCount` surfaced. This adds the depth the
-- ratings section needs — media, named sub-scores, helpful votes and a seller reply —
-- plus the keyset indexes that make a public read possible at all.
--
-- Depends on 0064 for `commerce_review_media_kind` and `commerce_review_score_axis`.
-- Both are CREATE TYPE, not ADD VALUE, so using them here in the same migrate
-- transaction is safe.
--
-- Rollback: dropping the four tables, the two columns and the two new triggers is
-- clean (nothing references them), and the narrowed guard can be restored to whole-row.

-- ---------------------------------------------------------------------------
-- Denormalized counters on commerce_review.
--
-- Columns rather than count(*) because BOTH are ordering/filtering inputs on the
-- public read: "most helpful" is a sort chip and a keyset cursor needs its sort key
-- stored and indexed on the ordered table, and `media_count > 0` is sargable in a
-- partial-index predicate where EXISTS(...) is not.
--
-- ADD COLUMN ... DEFAULT is metadata-only on PG 11+, so no table rewrite, and no
-- backfill is needed: there are no vote or media rows to count.
-- ---------------------------------------------------------------------------
ALTER TABLE "commerce_review" ADD COLUMN "helpful_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_review" ADD COLUMN "media_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "commerce_review" ADD CONSTRAINT "commerce_review_helpful_count_ck" CHECK (helpful_count >= 0);--> statement-breakpoint
ALTER TABLE "commerce_review" ADD CONSTRAINT "commerce_review_media_count_ck" CHECK (media_count BETWEEN 0 AND 6);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Review media.
--
-- CASCADE, and it is the only cascade in the trust slice. Every other commerce FK is
-- `restrict` because an order line or a journal entry references the row; review media
-- has no downstream reference and `restrict` would make a review undeletable forever.
-- `product_image -> product` made the same call.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_review_media" (
  "id" text PRIMARY KEY NOT NULL,
  "review_id" text NOT NULL,
  "media_kind" "commerce_review_media_kind" DEFAULT 'photo' NOT NULL,
  "url" text,
  "youtube_video_id" text,
  "width_px" integer,
  "height_px" integer,
  "position" integer NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "commerce_review_media_position_ck" CHECK (position BETWEEN 0 AND 5),
  CONSTRAINT "commerce_review_media_supply_ck" CHECK (
    (media_kind = 'photo') = (url IS NOT NULL AND width_px IS NOT NULL AND height_px IS NOT NULL)
    AND (media_kind = 'youtube_video') = (youtube_video_id IS NOT NULL)
  ),
  CONSTRAINT "commerce_review_media_url_ck" CHECK (
    url IS NULL OR (url LIKE 'https://%' AND char_length(url) <= 2048)
  ),
  CONSTRAINT "commerce_review_media_youtube_ck" CHECK (
    youtube_video_id IS NULL OR youtube_video_id ~ '^[a-zA-Z0-9_-]{11}$'
  ),
  CONSTRAINT "commerce_review_media_dimensions_ck" CHECK (
    (width_px IS NULL OR width_px BETWEEN 1 AND 20000)
    AND (height_px IS NULL OR height_px BETWEEN 1 AND 20000)
  )
);--> statement-breakpoint
ALTER TABLE "commerce_review_media" ADD CONSTRAINT "commerce_review_media_review_id_commerce_review_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."commerce_review"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commerce_review_media_position_uidx" ON "commerce_review_media" USING btree ("review_id","position");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Named sub-scores. Composite PK, no surrogate id: the row IS the (review, axis)
-- fact, and a surrogate plus a unique index would state one rule twice. No created_at
-- either — written inside its review's transaction, never changed.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_review_score" (
  "review_id" text NOT NULL,
  "axis" "commerce_review_score_axis" NOT NULL,
  "score" integer NOT NULL,
  CONSTRAINT "commerce_review_score_review_id_axis_pk" PRIMARY KEY("review_id","axis"),
  CONSTRAINT "commerce_review_score_ck" CHECK (score BETWEEN 1 AND 5)
);--> statement-breakpoint
ALTER TABLE "commerce_review_score" ADD CONSTRAINT "commerce_review_score_review_id_commerce_review_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."commerce_review"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commerce_review_score_axis_idx" ON "commerce_review_score" USING btree ("axis","review_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Helpful votes. No `value` column: there is one kind of vote, and a +1/-1 integer
-- would smuggle a downvote product decision in as a nullable field. Row presence IS
-- the vote. Keyed on the organization to mirror one-review-per-organization and to
-- cap farming behind the cost of a verified commerce organization.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_review_vote" (
  "review_id" text NOT NULL,
  "voter_organization_id" text NOT NULL,
  "voter_member_id" text NOT NULL,
  "voter_user_id" text NOT NULL,
  "created_at" timestamp(3) DEFAULT now() NOT NULL,
  CONSTRAINT "commerce_review_vote_review_id_voter_organization_id_pk" PRIMARY KEY("review_id","voter_organization_id")
);--> statement-breakpoint
ALTER TABLE "commerce_review_vote" ADD CONSTRAINT "commerce_review_vote_review_id_commerce_review_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."commerce_review"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_review_vote" ADD CONSTRAINT "commerce_review_vote_voter_organization_id_commerce_organization_id_fk" FOREIGN KEY ("voter_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_review_vote" ADD CONSTRAINT "commerce_review_vote_voter_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("voter_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_review_vote" ADD CONSTRAINT "commerce_review_vote_voter_user_id_user_id_fk" FOREIGN KEY ("voter_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commerce_review_vote_organization_idx" ON "commerce_review_vote" USING btree ("voter_organization_id","created_at");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Seller reply. review_id is the PRIMARY KEY, not a surrogate with a unique index —
-- "one reply per review" becomes unrepresentable rather than merely rejected.
-- No visibility column: a reply only renders beside its review, so hiding the review
-- hides the reply, and one visibility flag means one place to get it wrong.
-- ---------------------------------------------------------------------------
CREATE TABLE "commerce_review_reply" (
  "review_id" text PRIMARY KEY NOT NULL,
  "responder_organization_id" text NOT NULL,
  "responder_member_id" text NOT NULL,
  "body" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "commerce_review_reply_body_ck" CHECK (char_length(body) BETWEEN 1 AND 2000)
);--> statement-breakpoint
ALTER TABLE "commerce_review_reply" ADD CONSTRAINT "commerce_review_reply_review_id_commerce_review_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."commerce_review"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_review_reply" ADD CONSTRAINT "commerce_review_reply_responder_organization_id_commerce_organization_id_fk" FOREIGN KEY ("responder_organization_id") REFERENCES "public"."commerce_organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commerce_review_reply" ADD CONSTRAINT "commerce_review_reply_responder_member_id_commerce_organization_member_id_fk" FOREIGN KEY ("responder_member_id") REFERENCES "public"."commerce_organization_member"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commerce_review_reply_organization_idx" ON "commerce_review_reply" USING btree ("responder_organization_id","created_at");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Keyset indexes for the four public sorts.
--
-- Every one is PARTIAL on visibility = 'visible', so a hidden review never enters a
-- public scan rather than being filtered after the fact, and every one ends in `id` —
-- §7's rule that an order must end in a unique column so cursor pagination cannot skip
-- rows with equal sort keys.
--
-- The pre-existing `commerce_review_subject_idx` is unordered and cannot serve a
-- keyset. It stays, because the aggregate in commerce-trust-metrics.service.ts uses it.
-- ---------------------------------------------------------------------------
CREATE INDEX "commerce_review_product_recent_idx" ON "commerce_review" USING btree ("product_id","created_at" DESC,"id") WHERE visibility = 'visible' AND product_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "commerce_review_product_helpful_idx" ON "commerce_review" USING btree ("product_id","helpful_count" DESC,"id") WHERE visibility = 'visible' AND product_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "commerce_review_product_rating_idx" ON "commerce_review" USING btree ("product_id","rating" DESC,"created_at" DESC,"id") WHERE visibility = 'visible' AND product_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "commerce_review_product_media_idx" ON "commerce_review" USING btree ("product_id","created_at" DESC,"id") WHERE visibility = 'visible' AND product_id IS NOT NULL AND media_count > 0;--> statement-breakpoint
CREATE INDEX "commerce_review_subject_recent_idx" ON "commerce_review" USING btree ("subject_organization_id","created_at" DESC,"id") WHERE visibility = 'visible';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- NARROW the existing relationship guard from whole-row to the identity columns.
--
-- 0053 created it as BEFORE INSERT OR UPDATE with no column list, so EVERY update to a
-- review row re-runs two point lookups re-validating linkage that is structurally
-- immutable. Today that already costs a moderator flipping `visibility`; once helpful
-- and media counters move on this table it would fire on every vote.
--
-- The function body is UNCHANGED. Only the trigger's column scope narrows, and it
-- still fires on every INSERT and on any change to a column the guard actually checks.
--
-- `verify-store-phase-10-constraints` asserts pg_trigger.tgattr is non-empty for this
-- trigger — that is the check proving the narrowing landed rather than the guard having
-- been silently dropped.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS commerce_review_relationship_guard ON "commerce_review";--> statement-breakpoint
CREATE TRIGGER commerce_review_relationship_guard
BEFORE INSERT OR UPDATE OF completion_id, reviewer_organization_id, reviewer_member_id, subject_organization_id, product_id
ON "commerce_review"
FOR EACH ROW EXECUTE FUNCTION commerce_validate_review_relationship();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Self-vote guard.
--
-- The rule spans two tables, so it cannot be a CHECK. A voter organization equal to
-- the review's REVIEWER organization is voting for itself; equal to the review's
-- SUBJECT organization is a seller upvoting reviews of itself, which is the exact
-- farming a public "most helpful" sort invites. Both are refused, and the member is
-- re-bound to the organization it claims — the service checks all three too, but a
-- service check alone is not what makes an invariant true.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION commerce_validate_review_vote_relationship()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  authoritative_reviewer_organization_id text;
  authoritative_subject_organization_id text;
  voter_member_organization_id text;
BEGIN
  SELECT reviewer_organization_id, subject_organization_id
    INTO authoritative_reviewer_organization_id,
         authoritative_subject_organization_id
    FROM commerce_review
   WHERE id = NEW.review_id;

  IF NEW.voter_organization_id IN (
       authoritative_reviewer_organization_id,
       authoritative_subject_organization_id
     ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A review party cannot vote on its own review.';
  END IF;

  SELECT organization_id
    INTO voter_member_organization_id
    FROM commerce_organization_member
   WHERE id = NEW.voter_member_id;

  IF voter_member_organization_id IS DISTINCT FROM NEW.voter_organization_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Review vote member does not belong to the voting organization.';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER commerce_review_vote_relationship_guard
BEFORE INSERT ON "commerce_review_vote"
FOR EACH ROW EXECUTE FUNCTION commerce_validate_review_vote_relationship();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Reply authority guard. Only the organization the review is ABOUT may answer it.
-- Also spans two tables, so also a trigger. BEFORE INSERT OR UPDATE because a reply
-- body is editable and the responder columns must stay bound across an edit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION commerce_validate_review_reply_relationship()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  authoritative_subject_organization_id text;
  responder_member_organization_id text;
BEGIN
  SELECT subject_organization_id
    INTO authoritative_subject_organization_id
    FROM commerce_review
   WHERE id = NEW.review_id;

  IF authoritative_subject_organization_id IS DISTINCT FROM NEW.responder_organization_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Only the reviewed organization may reply to a review.';
  END IF;

  SELECT organization_id
    INTO responder_member_organization_id
    FROM commerce_organization_member
   WHERE id = NEW.responder_member_id;

  IF responder_member_organization_id IS DISTINCT FROM NEW.responder_organization_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Review reply member does not belong to the responding organization.';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER commerce_review_reply_relationship_guard
BEFORE INSERT OR UPDATE ON "commerce_review_reply"
FOR EACH ROW EXECUTE FUNCTION commerce_validate_review_reply_relationship();
