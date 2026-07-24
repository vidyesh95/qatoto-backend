import { z } from "zod";

import { config } from "#src/config/index.js";
import type { Result } from "#src/types/index.js";

/**
 * The GitHub adapter (R_AND_D_BACKEND_STRUCTURE.md §9.7, §9.10; PROOF_OF_EFFORT_SPEC.md
 * §4 step 2 — "Did the user push commits to the auth module today? Does the commit
 * signature match their key?").
 *
 * THIS IS THE ONE PLACE §9 TALKS TO A THIRD PARTY, and the shape it has is the shape every
 * later provider gets: plain `fetch`, no SDK, injectable for tests, a hard timeout, and a
 * typed `Result` for every failure a caller must branch on.
 *
 * CONFIGURED OR ABSENT, NEVER HALF-ON. With no `GITHUB_APP_*` the connect route answers
 * `503 INTEGRATION_UNCONFIGURED` and grounding falls back to the evidence links §8 already
 * stored — which resolve `flagged`, so a human reviews, and nothing is silently verified on
 * evidence nobody fetched.
 *
 * WHAT A COMMIT BUYS THAT A LINK DOES NOT: an `author.date` GitHub recorded rather than
 * one a member typed, and a signature verdict. Those are the two inputs temporal analysis
 * and grounding need to reach `passed` instead of `flagged`.
 */

export type FetchImplementation = typeof globalThis.fetch;

export type GitHubError =
  | { type: "GITHUB_UNCONFIGURED" }
  | { type: "GITHUB_UNAUTHORIZED" }
  | { type: "GITHUB_NOT_FOUND"; resource: string }
  | { type: "GITHUB_RATE_LIMITED"; retryAfterSeconds: number | null }
  | { type: "GITHUB_REQUEST_FAILED"; status: number }
  | { type: "GITHUB_RESPONSE_MALFORMED"; issues: readonly string[] };

/** GitHub's own commit shape, narrowed to the fields §9 actually grounds on. */
const GitHubCommitSchema = z.object({
  sha: z.string().min(7),
  html_url: z.string().optional(),
  commit: z.object({
    message: z.string(),
    author: z.object({ name: z.string().optional(), date: z.string() }),
    // Present only on verified-signature repositories; absent is `unknown`, not `invalid`.
    verification: z.object({ verified: z.boolean(), reason: z.string().optional() }).optional(),
  }),
});

const GitHubCommitListSchema = z.array(GitHubCommitSchema);

const GitHubViewerSchema = z.object({ login: z.string() });

const GitHubTokenSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string().optional(),
  token_type: z.string().optional(),
});

export interface GroundedCommit {
  readonly sha: string;
  readonly message: string;
  readonly htmlUrl: string | null;
  /** GitHub's recorded author date — the instant a member cannot author freely. */
  readonly authoredAt: Date;
  readonly signatureStatus: "valid" | "invalid" | "unsigned" | "unknown";
}

async function requestGitHub(
  path: string,
  accessToken: string,
  fetchImplementation: FetchImplementation,
): Promise<Result<unknown, GitHubError>> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), config.INTEGRATION_HTTP_TIMEOUT_MS);

  try {
    const response = await fetchImplementation(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "Qatoto-ProofOfEffort",
      },
      signal: abortController.signal,
    });

    // 401 is PERMANENT (§9.7): the consent was revoked upstream, and retrying cannot help.
    // 403/429 with a rate-limit header is retryable. Conflating them burns five backoff
    // attempts on a token that will never work again.
    if (response.status === 401) {
      return { success: false, error: { type: "GITHUB_UNAUTHORIZED" } };
    }
    if (response.status === 404) {
      return { success: false, error: { type: "GITHUB_NOT_FOUND", resource: path } };
    }
    if (response.status === 429 || response.status === 403) {
      const retryAfter = response.headers.get("retry-after");
      return {
        success: false,
        error: {
          type: "GITHUB_RATE_LIMITED",
          retryAfterSeconds: retryAfter === null ? null : Number(retryAfter),
        },
      };
    }
    if (!response.ok) {
      return { success: false, error: { type: "GITHUB_REQUEST_FAILED", status: response.status } };
    }

    return { success: true, value: await response.json() };
  } catch {
    // A timeout or a network fault. Retryable, and reported as a 5xx-shaped failure so the
    // caller's branch is the same one it takes for a genuine server error.
    return { success: false, error: { type: "GITHUB_REQUEST_FAILED", status: 0 } };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Exchanges an OAuth callback code for an access token.
 *
 * The client secret never leaves this function, and the token it returns goes straight
 * into `encryptToken` — it is never logged, never returned to a client, and never written
 * to a column in the clear (§9.10).
 */
export async function exchangeCodeForToken(
  code: string,
  fetchImplementation: FetchImplementation = globalThis.fetch,
): Promise<Result<{ readonly accessToken: string }, GitHubError>> {
  if (!config.GITHUB_APP_CLIENT_ID || !config.GITHUB_APP_CLIENT_SECRET) {
    return { success: false, error: { type: "GITHUB_UNCONFIGURED" } };
  }

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), config.INTEGRATION_HTTP_TIMEOUT_MS);

  try {
    const response = await fetchImplementation("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: config.GITHUB_APP_CLIENT_ID,
        client_secret: config.GITHUB_APP_CLIENT_SECRET,
        code,
      }),
      signal: abortController.signal,
    });

    if (!response.ok) {
      return { success: false, error: { type: "GITHUB_REQUEST_FAILED", status: response.status } };
    }

    const parsed = GitHubTokenSchema.safeParse(await response.json());
    if (!parsed.success) {
      // GitHub answers 200 with `{error: "bad_verification_code"}` for a replayed or
      // expired code, so a schema miss here is the ordinary failure rather than an outage.
      return {
        success: false,
        error: {
          type: "GITHUB_RESPONSE_MALFORMED",
          issues: parsed.error.issues.map((issue) => issue.message),
        },
      };
    }

    return { success: true, value: { accessToken: parsed.data.access_token } };
  } catch {
    return { success: false, error: { type: "GITHUB_REQUEST_FAILED", status: 0 } };
  } finally {
    clearTimeout(timeout);
  }
}

/** The connected account's login, stored as the grant's human-readable label. */
export async function fetchViewerLogin(
  accessToken: string,
  fetchImplementation: FetchImplementation = globalThis.fetch,
): Promise<Result<string, GitHubError>> {
  const response = await requestGitHub("/user", accessToken, fetchImplementation);
  if (!response.success) return response;

  const parsed = GitHubViewerSchema.safeParse(response.value);
  if (!parsed.success) {
    return {
      success: false,
      error: {
        type: "GITHUB_RESPONSE_MALFORMED",
        issues: parsed.error.issues.map((issue) => issue.message),
      },
    };
  }
  return { success: true, value: parsed.data.login };
}

/**
 * Commits by one author on one repository, inside a window.
 *
 * SCOPED THREE WAYS, all server-derived: the repository must be one the member named in
 * their grant's `allowedResourceIds`, the author is the grant's own login, and the window
 * is the claimed day. A caller cannot widen any of them.
 */
export async function fetchAuthoredCommits(
  input: {
    readonly repositoryFullName: string;
    readonly authorLogin: string;
    readonly since: Date;
    readonly until: Date;
  },
  accessToken: string,
  fetchImplementation: FetchImplementation = globalThis.fetch,
): Promise<Result<readonly GroundedCommit[], GitHubError>> {
  const query = new URLSearchParams({
    author: input.authorLogin,
    since: input.since.toISOString(),
    until: input.until.toISOString(),
    // A day's honest work does not produce more than this, and an unbounded page is how a
    // fan-out job turns into an outage.
    per_page: "100",
  });

  const response = await requestGitHub(
    `/repos/${input.repositoryFullName}/commits?${query.toString()}`,
    accessToken,
    fetchImplementation,
  );
  if (!response.success) return response;

  const parsed = GitHubCommitListSchema.safeParse(response.value);
  if (!parsed.success) {
    return {
      success: false,
      error: {
        type: "GITHUB_RESPONSE_MALFORMED",
        issues: parsed.error.issues.map((issue) => issue.message),
      },
    };
  }

  return {
    success: true,
    value: parsed.data.map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message.slice(0, 500),
      htmlUrl: commit.html_url ?? null,
      authoredAt: new Date(commit.commit.author.date),
      signatureStatus: toSignatureStatus(commit.commit.verification),
    })),
  };
}

/**
 * GitHub's verification block, mapped onto §9's four states.
 *
 * `unknown` when the field is absent and `unsigned` when it is present and says so: the
 * two are different facts, and collapsing them would let "we did not ask" read as "we
 * checked and there was no signature".
 */
function toSignatureStatus(
  verification: { readonly verified: boolean; readonly reason?: string | undefined } | undefined,
): GroundedCommit["signatureStatus"] {
  if (!verification) return "unknown";
  if (verification.verified) return "valid";
  return verification.reason === "unsigned" ? "unsigned" : "invalid";
}
