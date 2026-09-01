import { randomUUID } from "node:crypto";

import { relations, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  integer,
  index,
  uniqueIndex,
  check,
  pgEnum,
} from "drizzle-orm/pg-core";

import { user } from "#src/db/schema/_core.js";

// ---------------------------------------------------------------------------
// Support cases — a person with a problem, and the staff member who answers.
//
// ## WHY THIS IS NOT ANY OF THE FIVE REPORT TABLES
//
// `user_report`, `video_content_report`, `commerce_content_report`,
// `community_content_report` and `research_program_content_report` all end in a verdict
// ABOUT a piece of content or a person, and each is scoped to the surface that owns that
// thing. A support case ends in nobody being judged: it is a CONVERSATION between one
// account and staff, and it is about whatever the person could not solve on their own. It
// belongs beside `platform_feedback` — platform-wide, owned by no one domain — with the one
// difference that feedback is a note nobody answers and this is a thread somebody does.
//
// ## ⚠️ NOTHING HERE MOVES MONEY, AND `payment_problem` IS WHY THAT MUST BE SAID
//
// The commonest reason a person writes in is "I paid and the other side says they did not
// receive it". Qatoto holds no funds (docs/ESCROW_LEDGER_STRUCTURE.md: "the provider is
// authoritative for cash"), so a support case cannot refund, release or reverse anything. It
// can find out what happened and point at the surface that records it — the order's payment
// panel, the settlement attestations, a dispute between the two parties. A case that implied
// otherwise would be a promise this platform is not able to keep.
//
// ## `order_reference` IS TEXT, AND DELIBERATELY NOT A FOREIGN KEY TO `commerce_order`
//
// Three reasons, any one of them sufficient. First, orders are ORGANIZATION-scoped and a
// case is USER-scoped: "may this person attach this order" is a membership question whose
// answer CHANGES over time, so a member who leaves an organization would keep reading
// order-derived staff replies on a case they opened while inside it. Second, validating an
// id at open time turns `POST /support/cases` into an existence oracle — 201 for a real
// order and 422 for a fabricated one is the probe the 404-never-403 rule exists to prevent.
// Third, an FK would drag this table into the commerce trigger and audit machinery for a
// value that is only ever read by a human. Staff paste the reference into the console they
// already have.
// ---------------------------------------------------------------------------

export const supportCaseCategoryEnum = pgEnum("support_case_category", [
  "payment_problem",
  "order_problem",
  "account_problem",
  "content_problem",
  "technical_problem",
  "other",
]);

/**
 * The state machine, and it is a conversation rather than a queue verdict.
 *
 *   `open`          — waiting on staff. Where every case lands, and where a reply from the
 *                     person puts it back.
 *   `awaiting_user` — staff answered and the ball is with the person. Purely informational:
 *                     nothing expires and nothing is refused in this state.
 *   `resolved`      — staff decided it is done. NOT terminal: the person can reply and
 *                     reopen it, because "resolved" is a claim by one side of a conversation
 *                     and the other side may disagree.
 *   `closed`        — terminal. Nobody writes to a closed case, staff included.
 */
export const supportCaseStateEnum = pgEnum("support_case_state", [
  "open",
  "awaiting_user",
  "resolved",
  "closed",
]);

/**
 * WHICH SIDE WROTE A MESSAGE, snapshotted rather than derived.
 *
 * A staff member's platform role is revocable, so deriving "this was a staff reply" at read
 * time would rewrite history the moment somebody's role changed — the same reasoning behind
 * `platform_audit_entry.actorRoleSnapshot` and the buyer name snapshots in commerce.
 */
export const supportCaseAuthorKindEnum = pgEnum("support_case_author_kind", [
  "case_opener",
  "staff",
]);

export const supportCase = pgTable(
  "support_case",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /**
     * `cascade`, like `notification.recipient_user_id` and unlike every moderation table.
     *
     * A support case is the person's OWN conversation about their own problem. Nobody else's
     * record depends on it: there is no counterparty holding the other half, no equity whose
     * denominator it is, and no enforcement action taken about somebody else. So it dies with
     * the account, and the anonymization manifest says `delete_rows` — which is also the only
     * disposition that scrubs the FREE TEXT, since nulling an FK leaves a description that
     * may hold a bank reference sitting in the table forever.
     */
    openedByUserId: text("opened_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    category: supportCaseCategoryEnum("category").notNull(),
    state: supportCaseStateEnum("state").default("open").notNull(),
    subject: text("subject").notNull(),
    description: text("description").notNull(),
    /** Free text the person pasted. A pointer for a human, never a join. See the header. */
    orderReference: text("order_reference"),
    /**
     * `restrict`, the `commerce_dispute.decided_by_user_id` posture: a decision taken about
     * somebody else's problem must stay attributable, so the account that took it cannot be
     * removed out from under it.
     */
    decidedByUserId: text("decided_by_user_id").references(() => user.id, { onDelete: "restrict" }),
    decisionNote: text("decision_note"),
    /**
     * `precision: 3` — LOAD-BEARING. Both list reads are keyset-paginated with a millisecond
     * cursor (`src/lib/instant-cursor.ts`), and a microsecond column makes rows unreachable at
     * every page boundary.
     */
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
    /** The activity clock. Every write in this module touches the case row so it moves. */
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    decidedAt: timestamp("decided_at"),
  },
  (table) => [
    // The opener's own list, newest first.
    index("support_case_opener_createdAt_idx").on(table.openedByUserId, table.createdAt, table.id),
    // The staff queue: filter by state, page by (created_at, id).
    index("support_case_state_createdAt_idx").on(table.state, table.createdAt, table.id),
    index("support_case_category_state_idx").on(table.category, table.state, table.createdAt),
    // Each mirrors the Zod schema the controller parses with. The schema is the polite
    // refusal; this is the one that cannot be bypassed.
    check("support_case_subject_ck", sql`char_length(subject) BETWEEN 1 AND 200`),
    check("support_case_description_ck", sql`char_length(description) BETWEEN 1 AND 4000`),
    check(
      "support_case_order_reference_ck",
      sql`order_reference IS NULL OR char_length(order_reference) BETWEEN 1 AND 100`,
    ),
    check(
      "support_case_decision_note_ck",
      sql`decision_note IS NULL OR char_length(decision_note) BETWEEN 1 AND 2000`,
    ),
    /**
     * A DECIDED CASE NAMES ITS DECIDER AND ITS INSTANT; A LIVE ONE HAS NEITHER.
     *
     * This is what makes a REOPEN honest. Replying to a `resolved` case clears all three
     * columns in the same statement that sets `open` — without this constraint a reopened
     * case could keep a stale `decided_at`, and the queue would show a live conversation
     * wearing a verdict nobody had reached.
     */
    check(
      "support_case_decision_ck",
      sql`(state IN ('resolved', 'closed'))
          = (decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL)`,
    ),
  ],
);

/**
 * The thread. Append-only: nothing here is edited or deleted, because a support case is a
 * record of what each side actually said.
 */
export const supportCaseMessage = pgTable(
  "support_case_message",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    caseId: text("case_id")
      .notNull()
      .references(() => supportCase.id, { onDelete: "cascade" }),
    /** Gapless per case, assigned under the case row's `FOR UPDATE` lock. */
    sequence: integer("sequence").notNull(),
    authorKind: supportCaseAuthorKindEnum("author_kind").notNull(),
    /**
     * `set null`, like `notification.actor_user_id`: the fact that something was said
     * outlives the account that said it, and `author_kind` still records which side wrote it.
     */
    authorUserId: text("author_user_id").references(() => user.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (table) => [
    /**
     * THE RACE-SAFE AUTHORITY, not the lock. The lock makes two concurrent replies serialize;
     * this makes a bug that skips the lock fail loudly instead of silently interleaving.
     */
    uniqueIndex("support_case_message_sequence_uidx").on(table.caseId, table.sequence),
    check("support_case_message_sequence_ck", sql`sequence >= 1`),
    check("support_case_message_body_ck", sql`char_length(body) BETWEEN 1 AND 4000`),
  ],
);

export const supportCaseRelations = relations(supportCase, ({ one, many }) => ({
  openedBy: one(user, {
    fields: [supportCase.openedByUserId],
    references: [user.id],
    relationName: "supportCaseOpener",
  }),
  decidedBy: one(user, {
    fields: [supportCase.decidedByUserId],
    references: [user.id],
    relationName: "supportCaseDecider",
  }),
  messages: many(supportCaseMessage),
}));

export const supportCaseMessageRelations = relations(supportCaseMessage, ({ one }) => ({
  supportCase: one(supportCase, {
    fields: [supportCaseMessage.caseId],
    references: [supportCase.id],
  }),
  author: one(user, {
    fields: [supportCaseMessage.authorUserId],
    references: [user.id],
  }),
}));
