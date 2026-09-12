// ---------------------------------------------------------------------------
// Personal data held as FREE TEXT, and what an erasure does to each column.
//
// ## ⚠️ WHY A SECOND REGISTER EXISTS
//
// `anonymization-manifest.ts` is keyed on FOREIGN KEYS into `user(id)`, and
// `db:verify-anonymization-coverage` finds its candidates by walking those keys. So a
// column holding a person's NAME as text is invisible to both — there is no key to walk —
// and the codebase already knew that about three columns and said so in five places:
//
//   > `user.bio` is a SCALAR COLUMN and therefore invisible to that script — it is
//   > scrubbed by one explicit line in `anonymize-account.service.ts`, and **if that line
//   > were deleted nothing would turn red.**
//
// That was true, and the gap was much wider than three columns. `mintBuyerWorkspace`
// (`commerce-buyer-workspace.service.ts:85-96`) copies `user.name` into THREE columns of an
// auto-provisioned `commerce_organization` — the shell every buyer gets who never declared a
// company — and the search indexer copies it on into three more on `store_search_document`.
// Neither table carries a `user` foreign key, so no FK-walking verifier could ever have
// mentioned either of them.
//
// ⚠️ WHAT THAT EXPOSED, STATED EXACTLY, BECAUSE THE FIRST DRAFT OF THIS OVERSTATED IT.
// `community-forum.service.ts` joins `commerce_organization.display_name` and renders it as
// `authorOrganizationName` on `GET /store/forum/threads`, a PUBLIC read — so a departed
// person's real name was being published on other people's forum pages. The search copy is
// the quieter half: all three indexed columns feed a GENERATED tsvector behind a NON-PARTIAL
// GIN index, but every `/store/search` query filters `is_eligible = true` and an
// auto-provisioned shell is `pending` + `private`, so those documents are not returned today.
// Eligibility is a mutable flag, not a guarantee, and the name was in the table and the index
// either way.
//
// ## WHAT THE SCOPE IS
//
// Text that identifies the ERASING USER and survives their own erasure. Third-party data —
// a delivery recipient, a company officer, an external auditor — is a COLLECTION question,
// not an erasure one, and each such column says so at its own entry rather than being
// filtered out silently.
//
// ## `not_personal_data` IS A DISPOSITION, NOT A REGEX EXCLUSION
//
// A column dropped by a pattern is reasoning nobody can read. A column carrying "this is a
// mesh node's label, not a person's" is reasoning the next reader can check and disagree
// with. It is also what keeps this a COVERAGE check: `db:verify-text-pii-coverage` scans
// Postgres for person-shaped text columns and fails on any that is missing here, so the
// bulk entries are what stop the interesting ones being buried.
//
// ## FIVE KINDS, AND EVERY ONE IS MACHINE-CHECKED
//
// `db:verify-text-pii-coverage` resolves `scrub.stepName` against the step names
// `anonymize-account.service.ts` actually plans, resolves `covered_by_row_delete.manifestKey`
// against `ANONYMIZATION_MANIFEST` (asserting it is `delete_rows` AND that this table is
// reachable from that one by `ON DELETE cascade`), and requires prose on the rest. Then it
// runs the scrub against a probe user in a rolled-back transaction and asserts every `scrub`
// column really stopped holding the probe's name. A disposition here cannot be a wish.
// ---------------------------------------------------------------------------

/** What happens to one free-text column when its subject is anonymized. */
export type TextPiiDisposition =
  /**
   * The erasure overwrites it. `stepName` must be a step the scrub actually plans — which is
   * what finally gives `user.bio` an executable guard.
   */
  | { readonly kind: "scrub"; readonly stepName: string; readonly note: string }
  /**
   * The whole row dies. `manifestKey` must be a `delete_rows` entry in
   * `ANONYMIZATION_MANIFEST` whose table is this table, or one this table cascades from.
   */
  | { readonly kind: "covered_by_row_delete"; readonly manifestKey: string; readonly note: string }
  /** Left in place. `lawfulBasis` cites the limb; `note` says whose interest it protects. */
  | { readonly kind: "retain"; readonly lawfulBasis: string; readonly note: string }
  /**
   * A PERSON'S NAME THAT NO ERASURE REQUEST CAN EVER REACH, because the row provably belongs
   * to nobody with an account. `note` must say what makes that provable — a CHECK constraint,
   * or a table with no `user` reference at all. Distinct from `not_personal_data` on purpose:
   * claiming a person's name is not personal data would be false, and the next reader would
   * rightly stop trusting the rest of this file.
   */
  | { readonly kind: "no_erasure_subject"; readonly note: string }
  /** A company, a product, a category, an asset id, a hash. `note` says what it holds. */
  | { readonly kind: "not_personal_data"; readonly note: string };

/** `"<table>.<column>"` — the same key shape the coverage script builds from Postgres. */
export type TextPiiColumnKey = `${string}.${string}`;

/**
 * Split a key the way the coverage script and the register agree on.
 *
 * TAKES `string`, NOT `TextPiiColumnKey`, because the callers that matter get their keys from
 * `Object.entries` — which returns `string` — and from Postgres. Validating here and throwing is
 * the honest signature; widening at the call site with an assertion would move the same check
 * somewhere it could be skipped.
 */
export function parseTextPiiColumnKey(key: string): {
  readonly tableName: string;
  readonly columnName: string;
} {
  const separatorIndex = key.indexOf(".");
  if (separatorIndex <= 0 || separatorIndex === key.length - 1) {
    throw new Error(`text-pii-register: "${key}" is not a "<table>.<column>" key`);
  }
  return {
    tableName: key.slice(0, separatorIndex),
    columnName: key.slice(separatorIndex + 1),
  };
}

/** Shared prose, because the same sentence is the honest answer for a dozen columns. */
const TRANSACTION_RECORD_NOTE =
  "Part of a transaction record the counterparty also holds, and which a dispute may still be open against.";
const PLATFORM_ARTWORK_NOTE =
  "A hosted image asset on platform-authored merchandising, not a person's photo.";

export const TEXT_PII_REGISTER: Readonly<Record<TextPiiColumnKey, TextPiiDisposition>> = {
  // -------------------------------------------------------------------------
  // THE IDENTITY ITSELF — `scrubUserAndComplete`, the last step of the run.
  // -------------------------------------------------------------------------
  "user.name": {
    kind: "scrub",
    stepName: "scrub_user",
    note: "Set to 'Deleted user'. NOT NULL, so it needs a value rather than a NULL.",
  },
  "user.email": {
    kind: "scrub",
    stepName: "scrub_user",
    note: "citext NOT NULL UNIQUE, so it is re-derived from the id as 'anonymized+<id>@deleted.qatoto.invalid' — RFC 2606's reserved TLD, so a misconfigured mailer resolves nothing rather than delivering an erasure notice to a stranger.",
  },
  "user.handle": {
    kind: "scrub",
    stepName: "scrub_user",
    note: "Nulled, which makes the channel unreachable. The string itself is then parked forever by `burn_handle` — see `handle_reservations.reserved_handle`.",
  },
  "user.image": {
    kind: "scrub",
    stepName: "scrub_user",
    note: "The avatar URL. The Cloudinary BYTES are deleted separately by `deleteUserAvatar`, because SQL cannot reach object storage.",
  },
  "user.bio": {
    kind: "scrub",
    stepName: "scrub_user",
    note: "⚠️ THE COLUMN THIS FILE EXISTS FOR. Public free text the person wrote about themselves, and until this register it had no executable guard except one assertion in `scripts/smoke-privacy.ts`.",
  },
  "user.location_label": {
    kind: "scrub",
    stepName: "scrub_user",
    note: "Self-declared, free text, and no pattern scan would ever catch the word 'label'. It is here because it is a column the scrub writes, not because it looked like a name.",
  },
  "user.is_channel_listed": {
    kind: "scrub",
    stepName: "scrub_user",
    note: "NOT TEXT, and in this register anyway: `GET /channels` reads it to build the public sitemap, so leaving it true would keep advertising an erased person's channel to search engines. It shared `bio`'s blind spot and now shares its guard.",
  },
  "handle_reservations.reserved_handle": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(e)",
    note: "PARKED ON PURPOSE. The `burn_handle` step re-inserts it with `expires_at = 'infinity'` after the manifest has deleted the live reservation. Releasing it would point every historical @mention at whoever claimed it next, which harms both of them.",
  },

  // -------------------------------------------------------------------------
  // AUTHORED FREE TEXT — the tombstone steps, which run FIRST because the manifest
  // severs the authorship link they need.
  // -------------------------------------------------------------------------
  "video_comment.body_text": {
    kind: "scrub",
    stepName: "tombstone:video_comment",
    note: "Emptied. `video_comment_body_ck` demands the empty string once `is_deleted` is true, so the text genuinely leaves the table rather than being hidden by a rendering convention.",
  },
  "community_forum_reply.body": {
    kind: "scrub",
    stepName: "tombstone:community_forum_reply",
    note: "Replaced with '[removed]'. NOT NULL with `char_length BETWEEN 2 AND 10000`, so it cannot be emptied, and the `hidden` state is CHECK-paired with a moderator id a scheduled job must not invent.",
  },
  "community_forum_thread.title": {
    kind: "scrub",
    stepName: "tombstone:community_forum_thread",
    note: "Replaced with '[removed]', which is 9 characters against a CHECK of 8..200.",
  },
  "community_forum_thread.body": {
    kind: "scrub",
    stepName: "tombstone:community_forum_thread",
    note: "CHECK is 20..20000, so '[removed]' is too short and a full sentence is required.",
  },
  "community_forum_thread.slug": {
    kind: "scrub",
    stepName: "tombstone:community_forum_thread",
    note: "The title is duplicated into this UNIQUE, publicly-routable slug, so leaving it would keep the text in a URL. Re-derived from the row's own uuid: unique and CHECK-valid by construction.",
  },

  // -------------------------------------------------------------------------
  // ⚠️ THE COMMERCE NAME CHAIN. `user.name` -> an auto-provisioned organization shell ->
  // the public search index. Five hops, three scrubbable, and hop 3 provably not.
  // -------------------------------------------------------------------------
  "commerce_organization.display_name": {
    kind: "scrub",
    stepName: "tombstone:commerce_organization",
    note: "HOP 2. Scoped to `provisioning_origin = 'auto_provisioned'`, because that shell IS the person — `mintBuyerWorkspace` put their `user.name` in it. A `self_declared` row is a real company other people trade with and is left alone.",
  },
  "commerce_organization.legal_name": {
    kind: "scrub",
    stepName: "tombstone:commerce_organization",
    note: "HOP 2, same write, same scope. NOT NULL with `char_length BETWEEN 1 AND 200`.",
  },
  "commerce_organization.normalized_legal_name": {
    kind: "scrub",
    stepName: "tombstone:commerce_organization",
    note: "HOP 2. A fixed literal is safe here only because there is NO unique index on this column — verified; the table's one unique index besides the slug is on the auto-provisioned owner, which the step does not touch.",
  },
  "store_search_document.title": {
    kind: "scrub",
    stepName: "tombstone:store_search_document",
    note: "⚠️ THE COLUMN NO PATTERN WOULD EVER HAVE CAUGHT, and the highest-weighted one. `refreshOrganizationSearchDocument` sets `title = row.displayName`, so on an ORGANIZATION document this holds the person's name at tsvector weight 'A'. Scrubbed only for `document_kind = 'organization'` — on a product document the title is the product's.",
  },
  "store_search_document.organization_display_name": {
    kind: "scrub",
    stepName: "tombstone:store_search_document",
    note: "HOP 5. Weight 'B' in the GENERATED `search_document` tsvector, behind the non-partial `store_search_document_fts_idx`. Not returned by `/store/search` today because the shell's document is ineligible — see this file's header for why that is not the same as safe.",
  },
  "store_search_document.search_text": {
    kind: "scrub",
    stepName: "tombstone:store_search_document",
    note: "HOP 5. The indexer concatenates the display AND legal names into it; weight 'C' in the same tsvector, and matched directly by the ILIKE fallback at `store-search.service.ts:478`. Scrubbed by a targeted `replace` of the old name rather than an overwrite, because on a product document this column also carries the product and its categories.",
  },
  "commerce_order.buyer_legal_name_snapshot": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(b) and (e)",
    note: "HOP 3, AND IMPOSSIBLE RATHER THAN UNWANTED. `commerce_prevent_order_snapshot_mutation` (drizzle/0045_tough_sunfire.sql:600-625) names this column in its immutability list and raises 23514 on UPDATE — and on DELETE. `retain` is the only executable disposition, and it is also the lawful one.",
  },
  "commerce_order.counterparty_legal_name_snapshot": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(b) and (e)",
    note: "HOP 3. Same trigger, same SQLSTATE, same clause of the immutability list.",
  },
  "commerce_dispute.order_snapshot_json": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(b) and (e)",
    note: "HOP 4. An immutable JSON copy of the order snapshot above, on a row whose `decided_by_user_id` is itself `retain` in the FK manifest. A blob, so there is nothing to scrub column-wise even if the limb did not apply.",
  },
  "commerce_order.buyer_address_snapshot": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(b)",
    note: "COARSE GEOGRAPHY ONLY, BY DESIGN: country, region, locality, postal code. Street lines, recipient name and phone are excluded from the snapshot and encrypted on the address row — `store.ts:6319-6323` states this and `deliveryAddressId` is how a seller reaches the rest.",
  },
  "commerce_order.counterparty_address_snapshot": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(b)",
    note: "Same redacted shape as the buyer snapshot above, for the other side of the trade.",
  },
  "commerce_checkout_group.delivery_address_snapshot": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(b)",
    note: "The same redacted coarse-geography snapshot, on the confirmed checkout that produced the order.",
  },
  "commerce_checkout_prepare.delivery_address_snapshot": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(b)",
    note: "The same redacted coarse-geography snapshot, taken one step earlier in checkout.",
  },
  "commerce_checkout_prepare.delivery_address_id": {
    kind: "not_personal_data",
    note: "A foreign key to `commerce_organization_address`, not an address. The pattern scan catches it on 'address'.",
  },
  "commerce_order.delivery_address_id": {
    kind: "not_personal_data",
    note: "A foreign key to `commerce_organization_address`, not an address.",
  },
  "commerce_rfq.destination_address_id": {
    kind: "not_personal_data",
    note: "A foreign key to `commerce_organization_address`, not an address.",
  },

  // -------------------------------------------------------------------------
  // CREDITS AND INVITES — the erasing user named in free text on SOMEBODY ELSE'S row,
  // where there is no foreign key to walk, or the FK is a `null_out` that severs the link.
  // -------------------------------------------------------------------------
  "video_collaborator.invited_email": {
    kind: "scrub",
    stepName: "tombstone:video_collaborator",
    note: "NOT NULL citext under a unique (video_id, invited_email) index, so the replacement is derived from the row id on `user.email`'s precedent. The step ALSO matches on the address itself, because an invite that was never accepted has a NULL `user_id` and is therefore invisible to every FK walk.",
  },
  "video_team_member.member_name": {
    kind: "scrub",
    stepName: "tombstone:video_team_member",
    note: "NOT NULL beside a `null_out` FK. `studio.ts:719` says the link is set null 'because deleting a user must never erase the credit itself' — which is right about the credit and wrong about the name, so the credit stays and the name goes.",
  },
  "showcase_launch_team_member.display_name": {
    kind: "scrub",
    stepName: "tombstone:showcase_launch_team_member",
    note: "⚠️ NO FOREIGN KEY AT ALL — a maker types a collaborator's name and handle by hand, so this is the erasing user's name on another person's public launch page with nothing to walk. Matched by the handle instead, which is exact: handles are unique platform-wide and this job burns the one it matched.",
  },
  "showcase_launch_team_member.handle": {
    kind: "scrub",
    stepName: "tombstone:showcase_launch_team_member",
    note: "NOT NULL, CHECK 1..64 on `^[A-Za-z0-9_.-]+$`, and unique per launch on the normalized form — so the replacement is derived from the row's uuid, whose hex and hyphens that charset already admits.",
  },
  "showcase_launch_team_member.handle_normalized": {
    kind: "scrub",
    stepName: "tombstone:showcase_launch_team_member",
    note: "GENERATED ALWAYS AS `lower(handle)`, so it cannot be written directly and follows the column above. Listed anyway: it is the one the unique index reads, and a reader checking coverage should find it classified rather than absent.",
  },

  // -------------------------------------------------------------------------
  // COVERED BY A ROW DELETE — verified `delete_rows` in the FK manifest, and for a child
  // table, verified reachable by `ON DELETE cascade`.
  // -------------------------------------------------------------------------
  "account.email": {
    kind: "covered_by_row_delete",
    manifestKey: "account.user_id",
    note: "The Better Auth provider row, including the address the OAuth provider returned.",
  },
  "session.ip_address": {
    kind: "covered_by_row_delete",
    manifestKey: "session.user_id",
    note: "The only raw IP address in this schema that is stored rather than hashed; every engagement table hashes it into a `viewer_fingerprint` instead.",
  },
  "passkey.name": {
    kind: "covered_by_row_delete",
    manifestKey: "passkey.user_id",
    note: "The device nickname the person typed — 'Vinit's MacBook'. Personal, and it dies with the credential.",
  },
  "community_cofounder_profile.display_name": {
    kind: "covered_by_row_delete",
    manifestKey: "community_cofounder_profile.user_id",
    note: "A co-founder-search profile is a possession, not a shared record: `store.ts:10944` explains why the key cascades.",
  },
  "community_cofounder_profile.avatar_url": {
    kind: "covered_by_row_delete",
    manifestKey: "community_cofounder_profile.user_id",
    note: "Dies with the profile row above. The hosted bytes are the avatar the account already owns.",
  },
  "community_cofounder_prior_venture.name": {
    kind: "covered_by_row_delete",
    manifestKey: "community_cofounder_profile.user_id",
    note: "A venture's name rather than a person's, and it cascades from the profile — verified `ON DELETE cascade` on `profile_id`.",
  },
  "showcase_launch.heading_image_url": {
    kind: "covered_by_row_delete",
    manifestKey: "showcase_launch.author_user_id",
    note: "The launch row dies; `deleteShowcaseImages` deletes the Cloudinary bytes separately, before the row that names them.",
  },
  "showcase_launch.heading_image_public_id": {
    kind: "covered_by_row_delete",
    manifestKey: "showcase_launch.author_user_id",
    note: "The Cloudinary handle the byte-deletion step reads. Collected BEFORE the row delete, which is why that step is not in the manifest loop.",
  },
  "video.contact_email": {
    kind: "covered_by_row_delete",
    manifestKey: "video.creator_id",
    note: "A creator's business address on their own video. `studio.ts` calls a video 'a possession that dies with the account', and the manifest agrees.",
  },
  "video.original_file_name": {
    kind: "covered_by_row_delete",
    manifestKey: "video.creator_id",
    note: "The uploader's own filename, which routinely carries a real name. Dies with the video row.",
  },
  "video_document.file_name": {
    kind: "covered_by_row_delete",
    manifestKey: "video.creator_id",
    note: "Cascades from `video` — verified `ON DELETE cascade` on `video_id`. The bytes are deleted by their own step first, because SQL cannot reach object storage.",
  },

  // -------------------------------------------------------------------------
  // RETAINED, WITH A LIMB — the erasing user's own data.
  // -------------------------------------------------------------------------
  "pitch_funding_outcome.funder_name_text": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(b) and (e)",
    note: "The schema's own stated decision, already quoted at `pitch_funding_outcome.funder_user_id` in the FK manifest: a recorded funding event is a claim other people rely on, and an unattributable one cannot be checked.",
  },
  "project_audit_entry.actor_name_snapshot": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(e)",
    note: "INSIDE THE HASH CHAIN and pseudonymous at write time — verified: `project-audit.service.ts:204` writes `pseudonymousActorLabel(projectId, actorUserId)` and never `user.name`. `rnd.ts:3581-3584` states the rule this column exists under. Editing it would break the chain for nothing.",
  },
  "physical_work_receipt.stored_image_url": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(e)",
    note: "A photograph submitted as evidence of logged effort behind an equity claim. The claim outlives the account by design (rule R1) and the evidence is what makes it defensible; the `restrict` keys on `project_id` and `member_id` say the same thing.",
  },
  "physical_work_receipt.stored_image_public_id": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(e)",
    note: "The Cloudinary handle for the evidence above. Deleting the bytes would destroy the claim's proof, not the person's identity.",
  },
  "pitch.external_contact_url": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(e)",
    note: "⚠️ A NAMED GAP, NOT A CLEAN ANSWER. A link to a surface the founder owns — `rnd.ts:8485-8487` notes Qatoto hosts no inbox precisely so this is a URL and not an address. But `pitch` carries no `user` reference, so no erasure path reaches it: a pitch is a project-owned public offer that outlives any one founder, and withdrawing it is the project's decision. A pitch-withdrawal flow is the right owner.",
  },
  "workshop_file.file_name": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(e)",
    note: "Project work product, keyed on `project_id` with `restrict` and attributed to a `project_member`, not a user. The filename belongs to the project's shared record; `workshop_file.removed_by_user_id` is the only user reference and is a `null_out`.",
  },
  "commerce_encrypted_document.original_file_name_encrypted": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(b) and (e)",
    note: `${TRANSACTION_RECORD_NOTE} Encrypted at rest under the AES-256-GCM envelope in src/lib/commerce-pii-encryption.ts, and its \`uploaded_by_user_id\` is itself \`retain\`.`,
  },
  "commerce_connector_outbox.last_error": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(e)",
    note: "NOT A NAME COLUMN — the scan catches it on the 'last' token. A provider's failure message on a fulfilment job, truncated to 2000 chars at write (`commerce-connector.service.ts:339`). Registered rather than excluded so the next reader re-checks whether any writer has started putting an address in it.",
  },
  "commerce_payment_outbox.last_error": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(e)",
    note: "As above, truncated to 1000 chars at `commerce-payments.service.ts:1763`, on a payment job whose operational record is part of the transaction.",
  },
  "daily_log_transcript_segment.speaker_label": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(e)",
    note: "May be a diarizer placeholder ('Speaker 1') or a typed name; nothing constrains it, and no manifest entry deletes daily logs because they are the Proof of Effort record. Registered so the ambiguity is on the page rather than in nobody's head.",
  },
  "integration_consent_grant.external_account_label": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(b)",
    note: "A member's off-platform login label. The grantee is a `project_member.id` whose `user_id` is `retain`, so no erasure path reaches it today. A consent-revocation flow is the right owner of this column, not the anonymizer.",
  },

  // -------------------------------------------------------------------------
  // ⚠️ THIRD PARTIES. Somebody else's personal data on a row the erasing user created.
  // Out of THIS job's scope, and each note says why the exposure is a COLLECTION question.
  // -------------------------------------------------------------------------
  "commerce_organization_stakeholder.full_name": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(b)",
    note: "⚠️ A COMPANY OFFICER WHO NEVER CONSENTED, named by somebody else during onboarding. Out of scope here because it is not the erasing user's data — but that makes it a collection problem rather than a non-problem, and `store.ts:2407` already flags the portrait's EXIF for the same reason.",
  },
  "commerce_organization_stakeholder.photo_url": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(b)",
    note: "The officer's portrait, same third party as above. `store.ts:2407` flags that the uploaded file may carry EXIF location.",
  },
  "commerce_organization_address.recipient_name_encrypted": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(b)",
    note: `A DELIVERY RECIPIENT — frequently not the account holder at all. ${TRANSACTION_RECORD_NOTE} Encrypted at rest.`,
  },
  "commerce_organization_address.address_line_one_encrypted": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(b)",
    note: `A shipping destination the seller must still be able to reach for a live order. ${TRANSACTION_RECORD_NOTE} Encrypted at rest.`,
  },
  "commerce_organization_address.address_line_two_encrypted": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(b)",
    note: `The second line of the destination above. ${TRANSACTION_RECORD_NOTE} Encrypted at rest.`,
  },
  "commerce_organization_address.phone_encrypted": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(b)",
    note: `The courier's contact number for the recipient, who may be a third party. ${TRANSACTION_RECORD_NOTE} Encrypted at rest.`,
  },
  "commerce_organization_site_audit.auditor_name": {
    kind: "retain",
    lawfulBasis: "Art. 17(3)(b) and (e)",
    note: "An external auditor named in a statement the platform made and stands behind — `store.ts:2291`. Not the erasing user, and an unattributable audit finding is worthless to the buyer relying on it.",
  },

  // -------------------------------------------------------------------------
  // A PERSON'S NAME WITH NO ACCOUNT BEHIND IT. Provable, in both cases, from structure.
  // -------------------------------------------------------------------------
  "case_study.author_display_name": {
    kind: "no_erasure_subject",
    note: "PROVABLE FROM A CHECK: `case_study_author_arm_ck` makes `author_user_id` and this byline mutually exclusive, and `case-study-submission.service.ts:175-178` always writes the FK arm and NULLs this one. A row holding this text therefore has no account — these hold the ten seeded fixture writers. An account-authored row dies outright: `case_study.author_user_id` is `delete_rows`.",
  },
  "case_study.author_handle": {
    kind: "no_erasure_subject",
    note: "The same exclusive arm as the display name above. Not a Qatoto handle — no FK, no reservation, nothing resolves it.",
  },
  "case_study.author_avatar_url": {
    kind: "no_erasure_subject",
    note: "The same exclusive arm. A fixture portrait on a row with no account.",
  },
  "teardown.author_display_name": {
    kind: "no_erasure_subject",
    note: "PROVABLE FROM THE SCHEMA: `teardown` and all ten `teardown_*` tables carry NO `user` reference of any kind, so no erasure can reach them and no byline here can belong to an account. These hold the seeded blueprint authors.",
  },
  "teardown.author_handle": {
    kind: "no_erasure_subject",
    note: "As above — the teardown tables have no `user` foreign key at all.",
  },
  "teardown.author_avatar_url": {
    kind: "no_erasure_subject",
    note: "As above — the teardown tables have no `user` foreign key at all.",
  },

  // -------------------------------------------------------------------------
  // NOT PERSONAL DATA. The bulk, and the reason the interesting entries above are findable.
  // -------------------------------------------------------------------------
  "anonymization_step_log.step_name": {
    kind: "not_personal_data",
    note: "The name of a step in this very job — 'tombstone:video_comment'. A literal from the code.",
  },
  "anonymization_step_log.table_name": {
    kind: "not_personal_data",
    note: "A Postgres table name, from the manifest.",
  },
  "job_failure.queue_name": { kind: "not_personal_data", note: "A queue name, from the code." },
  "project_chain_head.last_anchored_hash": {
    kind: "not_personal_data",
    note: "A 64-character hex digest. Caught by the scan on the 'last' token.",
  },
  "case_study_evidence_company.name": {
    kind: "not_personal_data",
    note: "A company a case study cites. Withheld from readers when the author asks, which is a confidentiality rule rather than a personal-data one — see case-study-public-read.service.ts.",
  },
  "commerce_category.name": { kind: "not_personal_data", note: "A catalogue category." },
  "commerce_category.image_url": { kind: "not_personal_data", note: PLATFORM_ARTWORK_NOTE },
  "commerce_category_request.proposed_name": {
    kind: "not_personal_data",
    note: "A category somebody proposed adding. The requester is a `null_out` FK; the proposal is a word like 'Gaskets'.",
  },
  "commerce_checkout_prepare_product_line.variant_name_snapshot": {
    kind: "not_personal_data",
    note: "A product variant — '2mm, black'.",
  },
  "commerce_order_product_line.variant_name_snapshot": {
    kind: "not_personal_data",
    note: "A product variant, snapshotted onto the order line.",
  },
  "commerce_product_variant.name": { kind: "not_personal_data", note: "A product variant." },
  "commerce_external_provider.display_name": {
    kind: "not_personal_data",
    note: "A payment or logistics provider — a company Qatoto integrates with.",
  },
  "commerce_freight_rate_card.source_forwarder_name": {
    kind: "not_personal_data",
    note: "The freight forwarder a rate card came from. A company.",
  },
  "commerce_organization_certification.issuer_name": {
    kind: "not_personal_data",
    note: "The body that issued a certificate — a standards organization.",
  },
  "commerce_organization_certification.standard_name": {
    kind: "not_personal_data",
    note: "A standard — 'ISO 9001'.",
  },
  "commerce_organization_media.image_url": {
    kind: "not_personal_data",
    note: "A factory or product photo on a seller's public page.",
  },
  "commerce_organization_production_line.name": {
    kind: "not_personal_data",
    note: "A production line inside a factory — 'CNC cell 2'.",
  },
  "commerce_organization_site_access.facility_name": {
    kind: "not_personal_data",
    note: "A factory site a buyer was granted access to inspect.",
  },
  "commerce_organization_site_audit.auditor_organization_name": {
    kind: "not_personal_data",
    note: "The audit firm. The individual auditor's name is the entry above, and it is retained for a different reason.",
  },
  "commerce_product_document.file_name": {
    kind: "not_personal_data",
    note: "A spec sheet or datasheet on a product listing, uploaded by an organization.",
  },
  "commerce_product_model.file_name": {
    kind: "not_personal_data",
    note: "A CAD or 3D model file on a product listing.",
  },
  "commerce_product_highlight.image_url": {
    kind: "not_personal_data",
    note: "Product photography on a listing.",
  },
  "commerce_product_highlight.image_cloudinary_public_id": {
    kind: "not_personal_data",
    note: "The Cloudinary handle for the product photograph above.",
  },
  "commodity_trade_flow.source_name": {
    kind: "not_personal_data",
    note: "The dataset a trade-flow figure came from — a statistics agency.",
  },
  "market_insight.source_name": {
    kind: "not_personal_data",
    note: "The publication a market figure was taken from.",
  },
  "domestic_substitute_mapping.evidence_source_name": {
    kind: "not_personal_data",
    note: "The publication behind a substitution claim.",
  },
  "supplier.name": { kind: "not_personal_data", note: "A supplier company." },
  "content_category.image_url": { kind: "not_personal_data", note: PLATFORM_ARTWORK_NOTE },
  "anime_hero_slide.image_url": { kind: "not_personal_data", note: PLATFORM_ARTWORK_NOTE },
  "promotional_slide.image_url": { kind: "not_personal_data", note: PLATFORM_ARTWORK_NOTE },
  "store_hero_slide.image_url": { kind: "not_personal_data", note: PLATFORM_ARTWORK_NOTE },
  "store_pathway.card_image_url": { kind: "not_personal_data", note: PLATFORM_ARTWORK_NOTE },
  "store_pathway.card_image_cloudinary_public_id": {
    kind: "not_personal_data",
    note: "The Cloudinary handle for the pathway card artwork.",
  },
  "store_pathway.hero_image_url": { kind: "not_personal_data", note: PLATFORM_ARTWORK_NOTE },
  "store_pathway.hero_image_cloudinary_public_id": {
    kind: "not_personal_data",
    note: "The Cloudinary handle for the pathway hero artwork.",
  },
  "daily_log.analysis_model_name": {
    kind: "not_personal_data",
    note: "The AI model that analysed the log — 'claude-opus-5'. A model, not a person.",
  },
  "localization_pathway_suggestion.model_name": {
    kind: "not_personal_data",
    note: "The AI model that produced the suggestion.",
  },
  "optimization_suggestion.model_name": {
    kind: "not_personal_data",
    note: "The AI model that produced the suggestion.",
  },
  "receipt_forensics_check.model_name": {
    kind: "not_personal_data",
    note: "The AI model that ran the forensics check.",
  },
  "verification_step.model_name": {
    kind: "not_personal_data",
    note: "The AI model that ran the verification step.",
  },
  "research_program_product_opportunity.product_name": {
    kind: "not_personal_data",
    note: "A product a research program identified as worth building.",
  },
  "research_project.name": {
    kind: "not_personal_data",
    note: "A project's name. The project outlives any one member by design (rule R1).",
  },
  "research_project.cover_image_url": {
    kind: "not_personal_data",
    note: "A project's cover art, owned by the project rather than a member.",
  },
  "research_project.cover_image_public_id": {
    kind: "not_personal_data",
    note: "The Cloudinary handle for the project cover art.",
  },
  "teardown.provenance_subject_product_name": {
    kind: "not_personal_data",
    note: "The product that was taken apart.",
  },
  "teardown.provenance_licence_name": {
    kind: "not_personal_data",
    note: "The licence the teardown photographs are published under — 'CC BY-SA 4.0'.",
  },
  "teardown_part.node_name": {
    kind: "not_personal_data",
    note: "A node in the exploded assembly tree — 'M3 retaining screw'.",
  },
};

/**
 * The same narrowing `anonymization-manifest.ts` uses, for the same reason: `Object.keys`
 * returns `string[]`, and the register is keyed on a template-literal type, so the shape has to
 * be re-established rather than asserted.
 */
function isTextPiiColumnKey(key: string): key is TextPiiColumnKey {
  const separatorIndex = key.indexOf(".");
  return separatorIndex > 0 && separatorIndex < key.length - 1;
}

/** Keys whose column the erasure overwrites. Derived — never hand-listed. */
export const SCRUBBED_TEXT_COLUMN_KEYS: readonly TextPiiColumnKey[] = Object.keys(TEXT_PII_REGISTER)
  .filter(isTextPiiColumnKey)
  .filter((key) => TEXT_PII_REGISTER[key].kind === "scrub");
