import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { and, asc, eq, sql } from "drizzle-orm";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import { artifactEvidence, effortClaim, integrationConsentGrant } from "#src/db/schema.js";
import {
  encryptToken,
  isTokenEncryptionConfigured,
  TOKEN_KEY_VERSION,
} from "#src/lib/token-encryption.js";
import { appendAuditEntry } from "#src/modules/rnd/projects/project-audit.service.js";
import type { ProjectAccessError } from "#src/modules/rnd/projects/project-membership.service.js";
import type { Result } from "#src/types/index.js";

/**
 * Integration consent (R_AND_D_BACKEND_STRUCTURE.md §9.10).
 *
 * CONSENT IS A TRIPLE — (project, member, provider) — NEVER A PAIR. A member on three
 * projects who connects GitHub creates three independently revocable grants with
 * independently narrowed `allowedResourceIds`. A grant for the solar project must never be
 * readable by the drone project's pipeline, and `integration_consent_grant_triple_unq` is
 * what makes that structural rather than a promise the service layer keeps.
 *
 * SCOPE NARROWING IS THE DIFFERENCE between "Qatoto reads your work" and "Qatoto reads
 * your GitHub". Default to the narrowest scope the provider supports — a repo-scoped
 * installation token, never a user PAT.
 *
 * **REVOCATION DESTROYS THE EVIDENCE, NEVER THE EQUITY.** Every `slice_ledger_entry` is
 * untouched; slices awarded stay awarded, forever. `artifact_evidence.rawPayloadJson` goes
 * NULL while the hash, the provider's id, the label, the occurrence instant and the
 * signature status are RETAINED — so the claim stays provable ("commit abc123 was signed,
 * valid, at 14:02, hashing to 9f2e…") without the platform holding a copy of anyone's
 * code.
 *
 * WHY NOT CLAW THE SLICES BACK — two symmetric attacks, both fatal. MEMBER-SIDE: revoke on
 * the way out to force a re-verification that must now fail, then dispute the zero; equity
 * becomes hostage to consent. FOUNDER-SIDE: pressure a member into revoking to zero out
 * their contribution, which is founder fiat arriving through a side door. Slicing Pie
 * agrees: a slice records RISK ALREADY TAKEN, and risk taken in March is not undone by a
 * token revoked in July.
 *
 * The consequence a human must accept, and which this service reports at the moment of
 * revocation: a dispute against a purged claim can resolve `upheld` or `voided` ONLY.
 */

export type IntegrationProvider = (typeof integrationConsentGrant.$inferSelect)["provider"];

export type IntegrationError =
  | ProjectAccessError
  | { type: "INTEGRATION_UNCONFIGURED"; provider: IntegrationProvider }
  | { type: "GRANT_NOT_FOUND"; provider: IntegrationProvider }
  | { type: "GRANT_NOT_YOURS" }
  | { type: "OAUTH_STATE_INVALID" };

export interface IntegrationGrantView {
  readonly id: string;
  readonly provider: IntegrationProvider;
  readonly status: (typeof integrationConsentGrant.$inferSelect)["status"];
  readonly allowedResourceIds: readonly string[];
  readonly externalAccountLabel: string | null;
  readonly grantedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  /** True only when a token is actually held. The ciphertext itself never leaves the row. */
  readonly hasStoredToken: boolean;
}

/**
 * Whether a provider can be connected at all in this deployment.
 *
 * TWO conditions, both required: the provider's own credentials, AND a key to encrypt the
 * resulting token with. Storing an org-scoped token in plaintext because one env var was
 * forgotten is the failure this function exists to prevent.
 */
export function isProviderConfigured(provider: IntegrationProvider): boolean {
  if (!isTokenEncryptionConfigured()) {
    return false;
  }
  switch (provider) {
    case "github":
      return Boolean(
        config.GITHUB_APP_ID && config.GITHUB_APP_CLIENT_ID && config.GITHUB_APP_CLIENT_SECRET,
      );
    case "gitlab":
    case "figma":
    case "jira":
    case "linear":
      // Declared in the enum so the schema does not need a migration to add them, and
      // deliberately unbuilt: an adapter that cannot fetch anything is worse than none,
      // because it produces a grant a member believes is doing something.
      return false;
    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(
        `isProviderConfigured: unhandled provider ${JSON.stringify(exhaustiveCheck)}`,
      );
    }
  }
}

/** Every provider the enum knows, as a runtime list a type guard can check against. */
const KNOWN_PROVIDERS: readonly IntegrationProvider[] = [
  "github",
  "gitlab",
  "figma",
  "jira",
  "linear",
];

function isKnownProvider(candidate: string): candidate is IntegrationProvider {
  return KNOWN_PROVIDERS.some((provider) => provider === candidate);
}

/** How long a signed OAuth `state` is accepted. §11e: signed, single-use, ten minutes. */
const OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;

interface OauthStateClaims {
  readonly projectId: string;
  readonly memberId: string;
  readonly provider: IntegrationProvider;
  readonly nonce: string;
  readonly issuedAtMs: number;
}

/**
 * Mints the signed `state` an authorize URL carries.
 *
 * THE STATE IS THE IDENTITY. §11e is explicit that the callback's identity comes from the
 * state, not from a session — a provider redirect arrives with whatever cookies the
 * browser had, which may be a different member's or none at all. Signing it with HMAC is
 * what makes "this callback belongs to that member, on that project" a fact the server can
 * check rather than infer.
 */
export function signOauthState(claims: Omit<OauthStateClaims, "nonce" | "issuedAtMs">): string {
  const secret = config.INTEGRATION_TOKEN_SECRET ?? config.BETTER_AUTH_SECRET;
  const payload: OauthStateClaims = {
    ...claims,
    // Single-use in practice: the nonce makes two states for the same member differ, so a
    // replayed callback is detectable against the grant's own status.
    nonce: randomBytes(16).toString("hex"),
    issuedAtMs: Date.now(),
  };

  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded, "utf8").digest("base64url");
  return `${encoded}.${signature}`;
}

/**
 * Verifies and decodes a `state`.
 *
 * Compared with `timingSafeEqual`, not `===`: a byte-by-byte early return on a signature
 * comparison leaks the correct prefix to anyone willing to measure, and a forged state is
 * a forged identity here.
 */
export function verifyOauthState(state: string): Result<OauthStateClaims, IntegrationError> {
  const secret = config.INTEGRATION_TOKEN_SECRET ?? config.BETTER_AUTH_SECRET;
  const [encoded, signature] = state.split(".");

  if (!encoded || !signature) {
    return { success: false, error: { type: "OAUTH_STATE_INVALID" } };
  }

  const expected = createHmac("sha256", secret).update(encoded, "utf8").digest("base64url");
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(signature, "utf8");

  if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) {
    return { success: false, error: { type: "OAUTH_STATE_INVALID" } };
  }

  try {
    const claims: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (
      typeof claims !== "object" ||
      claims === null ||
      !("issuedAtMs" in claims) ||
      typeof claims.issuedAtMs !== "number" ||
      Date.now() - claims.issuedAtMs > OAUTH_STATE_TTL_MS
    ) {
      return { success: false, error: { type: "OAUTH_STATE_INVALID" } };
    }
    // Every field re-checked rather than asserted. The HMAC already proved this server
    // minted the string, but a state signed by an EARLIER deploy could carry an older
    // shape — and an assertion would let those fields through as undefined into an
    // authorization decision.
    if (
      !("projectId" in claims) ||
      typeof claims.projectId !== "string" ||
      !("memberId" in claims) ||
      typeof claims.memberId !== "string" ||
      !("provider" in claims) ||
      typeof claims.provider !== "string" ||
      !isKnownProvider(claims.provider) ||
      !("nonce" in claims) ||
      typeof claims.nonce !== "string"
    ) {
      return { success: false, error: { type: "OAUTH_STATE_INVALID" } };
    }

    // Narrowed by the guard above rather than asserted, so an unknown provider name in an
    // old state cannot reach a switch that has no case for it.
    const parsedProvider = claims.provider;

    return {
      success: true,
      value: {
        projectId: claims.projectId,
        memberId: claims.memberId,
        provider: parsedProvider,
        nonce: claims.nonce,
        issuedAtMs: claims.issuedAtMs,
      },
    };
  } catch {
    return { success: false, error: { type: "OAUTH_STATE_INVALID" } };
  }
}

/** `GET …/integrations` — the member's own grants on this project. */
export async function listGrants(
  projectId: string,
  memberId: string,
): Promise<readonly IntegrationGrantView[]> {
  const rows = await db
    .select()
    .from(integrationConsentGrant)
    .where(
      and(
        eq(integrationConsentGrant.projectId, projectId),
        eq(integrationConsentGrant.memberId, memberId),
      ),
    )
    .orderBy(asc(integrationConsentGrant.provider));

  return rows.map(toGrantView);
}

export interface AvailableProviderView {
  readonly provider: IntegrationProvider;
  /**
   * Whether this DEPLOYMENT can connect the provider at all — credentials present AND a
   * token-encryption key configured. `isProviderConfigured` is the single source, so a
   * client cannot be told a provider is available and then meet `503
   * INTEGRATION_UNCONFIGURED` when it tries.
   */
  readonly isConfigured: boolean;
  /** The caller's own grant on this project, or null when they have never connected it. */
  readonly grant: IntegrationGrantView | null;
}

/**
 * `GET …/integrations/available` — the provider catalogue (§11l, Appendix D5).
 *
 * **THE RULING THIS SETTLES.** §9.10 left the first authorization's scope implicit, and the
 * consent screen inherited a circularity: `GET …/integrations` returns existing GRANTS only,
 * so a member who has never connected GitHub learns nothing about GitHub — not even whether
 * this deployment has it configured — while `POST …/integrations/:provider/authorize-url`
 * demands `requestedResourceIds[]`, which are the provider's own repos and projects and
 * cannot be enumerated before the OAuth round trip that would grant access to enumerate
 * them.
 *
 * **The first authorization is broad-scope, and narrowing is a second, post-callback step.**
 * That is the only orderable sequence — a member cannot choose among repositories nobody can
 * list — and it is lawful-basis-compatible because the consent that matters is the
 * provider's own screen, which names the scopes and is the member's to refuse. What this
 * read adds is the half that was missing: which providers exist here, which are configured,
 * and what the member has already connected, so the screen states facts instead of guessing.
 * `requestedResourceIds: []` is therefore the CORRECT first call, not a client shortcut.
 *
 * Every enum value is returned, including the four deliberately unbuilt ones — a provider
 * absent from the list is indistinguishable from one this deployment forgot, and
 * `isConfigured: false` is the honest answer to both.
 */
export async function listAvailableProviders(
  projectId: string,
  memberId: string,
): Promise<readonly AvailableProviderView[]> {
  const grants = await listGrants(projectId, memberId);
  const grantByProvider = new Map(grants.map((grant) => [grant.provider, grant]));

  return KNOWN_PROVIDERS.map((provider) => ({
    provider,
    isConfigured: isProviderConfigured(provider),
    grant: grantByProvider.get(provider) ?? null,
  }));
}

function toGrantView(grant: typeof integrationConsentGrant.$inferSelect): IntegrationGrantView {
  return {
    id: grant.id,
    provider: grant.provider,
    status: grant.status,
    allowedResourceIds: grant.allowedResourceIds,
    externalAccountLabel: grant.externalAccountLabel,
    grantedAt: grant.grantedAt,
    expiresAt: grant.expiresAt,
    revokedAt: grant.revokedAt,
    // The ciphertext is NEVER returned, only its existence. A response that carried it
    // would put an org-scoped token in every browser cache and proxy log on the path.
    hasStoredToken: grant.encryptedAccessToken !== null,
  };
}

export interface AuthorizeUrlView {
  readonly provider: IntegrationProvider;
  readonly authorizeUrl: string;
  readonly expiresInSeconds: number;
}

/**
 * `POST …/integrations/:provider/authorize-url` — begins a connection.
 *
 * Creates the grant in `pending` FIRST, so a callback always has a row to attach to and a
 * member can see a half-finished connection rather than nothing. The requested resource
 * ids are recorded now, before any token exists, which is what makes the narrowed scope
 * the member's choice rather than the provider's default.
 */
export async function buildAuthorizeUrl(
  context: { readonly projectId: string; readonly memberId: string },
  provider: IntegrationProvider,
  requestedResourceIds: readonly string[],
): Promise<Result<AuthorizeUrlView, IntegrationError>> {
  if (!isProviderConfigured(provider)) {
    return { success: false, error: { type: "INTEGRATION_UNCONFIGURED", provider } };
  }

  await db
    .insert(integrationConsentGrant)
    .values({
      projectId: context.projectId,
      memberId: context.memberId,
      provider,
      status: "pending",
      allowedResourceIds: [...requestedResourceIds],
    })
    .onConflictDoUpdate({
      target: [
        integrationConsentGrant.projectId,
        integrationConsentGrant.memberId,
        integrationConsentGrant.provider,
      ],
      // Re-connecting narrows or widens the scope on the EXISTING row rather than minting
      // a second grant — the triple is unique, and a member re-authorizing is one consent
      // decision revised, not two.
      set: { allowedResourceIds: [...requestedResourceIds], status: "pending" },
    });

  const state = signOauthState({
    projectId: context.projectId,
    memberId: context.memberId,
    provider,
  });

  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", config.GITHUB_APP_CLIENT_ID ?? "");
  authorizeUrl.searchParams.set(
    "redirect_uri",
    `${config.BETTER_AUTH_URL}/integrations/${provider}/callback`,
  );
  authorizeUrl.searchParams.set("state", state);

  return {
    success: true,
    value: {
      provider,
      authorizeUrl: authorizeUrl.toString(),
      expiresInSeconds: OAUTH_STATE_TTL_MS / 1_000,
    },
  };
}

/**
 * Stores an access token against a grant, encrypted.
 *
 * Called by the provider callback once a code has been exchanged. Split out so the
 * exchange (which is provider-specific and network-bound) stays separate from the
 * persistence rule (which is identical for every provider).
 */
export async function completeGrant(
  claims: {
    readonly projectId: string;
    readonly memberId: string;
    readonly provider: IntegrationProvider;
  },
  accessToken: string,
  externalAccountLabel: string | null,
  actorUserId: string,
): Promise<Result<IntegrationGrantView, IntegrationError>> {
  const encrypted = encryptToken(accessToken);
  if (!encrypted.success) {
    return {
      success: false,
      error: { type: "INTEGRATION_UNCONFIGURED", provider: claims.provider },
    };
  }

  const updated = await db.transaction(async (tx) => {
    const grantedAt = new Date();
    const [grant] = await tx
      .update(integrationConsentGrant)
      .set({
        status: "active",
        encryptedAccessToken: encrypted.value,
        tokenKeyVersion: TOKEN_KEY_VERSION,
        externalAccountLabel,
        grantedAt,
        revokedAt: null,
        revokedByUserId: null,
      })
      .where(
        and(
          eq(integrationConsentGrant.projectId, claims.projectId),
          eq(integrationConsentGrant.memberId, claims.memberId),
          eq(integrationConsentGrant.provider, claims.provider),
        ),
      )
      .returning();

    if (!grant) return null;

    await appendAuditEntry(tx, {
      projectId: claims.projectId,
      eventKind: "integration_consent_granted",
      actorUserId,
      actorRoleSnapshot: "member",
      actionLabel: "Connected an integration",
      targetLabel: `${claims.provider} grant`,
      payload: {
        grantId: grant.id,
        provider: claims.provider,
        memberId: claims.memberId,
        // The SCOPE is auditable; the token is not, and never appears in a payload.
        allowedResourceIds: grant.allowedResourceIds.map((resourceId) => resourceId),
      },
      occurredAt: grantedAt,
    });

    return grant;
  });

  if (!updated) {
    return { success: false, error: { type: "GRANT_NOT_FOUND", provider: claims.provider } };
  }
  return { success: true, value: toGrantView(updated) };
}

export interface RevocationOutcome {
  readonly grant: IntegrationGrantView;
  /**
   * How many claims can no longer be re-checked if challenged.
   *
   * Returned so the client can say it out loud at the moment of revocation — §9.10 asks
   * for exactly that sentence: "Revoking means these 47 claims can no longer be re-checked
   * if challenged."
   */
  readonly claimsNoLongerReVerifiable: number;
  readonly evidenceRowsPurged: number;
}

/**
 * `DELETE …/integrations/:provider` — SELF ONLY.
 *
 * Purges the payloads and keeps everything that makes a claim provable. The equity is not
 * touched, and no ledger row is read, written, or even loaded here — which is the clearest
 * possible statement that revocation and equity are unrelated.
 */
export async function revokeGrant(
  context: { readonly projectId: string; readonly memberId: string },
  provider: IntegrationProvider,
  actorUserId: string,
  actorRoleSnapshot: string,
): Promise<Result<RevocationOutcome, IntegrationError>> {
  const [existing] = await db
    .select()
    .from(integrationConsentGrant)
    .where(
      and(
        eq(integrationConsentGrant.projectId, context.projectId),
        eq(integrationConsentGrant.memberId, context.memberId),
        eq(integrationConsentGrant.provider, provider),
      ),
    );

  if (!existing) {
    return { success: false, error: { type: "GRANT_NOT_FOUND", provider } };
  }

  const outcome = await db.transaction(async (tx) => {
    const revokedAt = new Date();

    const [grant] = await tx
      .update(integrationConsentGrant)
      .set({
        status: "revoked",
        // Both must go, or the grant is "revoked" while still holding the credential —
        // `integration_consent_grant_lifecycle_ck` rejects that shape outright.
        encryptedAccessToken: null,
        encryptedRefreshToken: null,
        tokenKeyVersion: null,
        revokedAt,
        revokedByUserId: actorUserId,
      })
      .where(eq(integrationConsentGrant.id, existing.id))
      .returning();

    if (!grant) throw new Error("revokeGrant: update returned no row");

    // THE PURGE. `rawPayloadJson` goes; the hash, the external id, the label, the
    // occurrence instant and the signature status stay. The `artifact_evidence_purge_only`
    // trigger enforces exactly this shape against a DBA too.
    const purged = await tx
      .update(artifactEvidence)
      .set({ rawPayloadJson: null, evidenceRetained: false })
      .where(
        and(
          eq(artifactEvidence.consentGrantId, existing.id),
          eq(artifactEvidence.evidenceRetained, true),
        ),
      )
      .returning({ claimId: artifactEvidence.claimId });

    const affectedClaimIds = [...new Set(purged.map((row) => row.claimId))];

    await appendAuditEntry(tx, {
      projectId: context.projectId,
      eventKind: "integration_consent_revoked",
      actorUserId,
      actorRoleSnapshot,
      actionLabel: "Revoked an integration consent",
      targetLabel: `${provider} grant`,
      detailNote: `${affectedClaimIds.length} claim(s) can no longer be re-verified.`,
      payload: {
        grantId: existing.id,
        provider,
        memberId: context.memberId,
        evidenceRowsPurged: BigInt(purged.length),
        claimsAffected: BigInt(affectedClaimIds.length),
        // Stated in the chain itself, because it is the promise a member is relying on.
        slicesReversed: 0n,
      },
      occurredAt: revokedAt,
    });

    return {
      grant,
      claimsNoLongerReVerifiable: affectedClaimIds.length,
      evidenceRowsPurged: purged.length,
    };
  });

  return {
    success: true,
    value: {
      grant: toGrantView(outcome.grant),
      claimsNoLongerReVerifiable: outcome.claimsNoLongerReVerifiable,
      evidenceRowsPurged: outcome.evidenceRowsPurged,
    },
  };
}

/**
 * How many of a member's claims a revocation would make un-re-verifiable.
 *
 * Read BEFORE revoking, so the confirmation a member sees is the real number rather than a
 * guess (§9.10). Counts distinct claims, not evidence rows: forty commits on one claim is
 * one claim at risk, and saying "40" would misrepresent the consequence.
 */
export async function countClaimsAtRisk(
  projectId: string,
  memberId: string,
  provider: IntegrationProvider,
): Promise<number> {
  const [row] = await db
    .select({ claimCount: sql<number>`count(DISTINCT ${artifactEvidence.claimId})::int` })
    .from(artifactEvidence)
    .innerJoin(
      integrationConsentGrant,
      eq(integrationConsentGrant.id, artifactEvidence.consentGrantId),
    )
    .innerJoin(effortClaim, eq(effortClaim.id, artifactEvidence.claimId))
    .where(
      and(
        eq(integrationConsentGrant.projectId, projectId),
        eq(integrationConsentGrant.memberId, memberId),
        eq(integrationConsentGrant.provider, provider),
        eq(artifactEvidence.evidenceRetained, true),
      ),
    );

  return row?.claimCount ?? 0;
}
