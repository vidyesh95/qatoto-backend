import { passkey } from "@better-auth/passkey";
import { hash, verify } from "@node-rs/argon2";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { anonymous, emailOTP } from "better-auth/plugins";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import { account, user } from "#src/db/schema.js";
import { sendTransactionalEmail } from "#src/lib/email.js";
import { fetchGitHubPrimaryEmail, readGoogleProfileFromIdToken } from "#src/lib/oauth-profile.js";
import { assignPlaceholderHandle } from "#src/services/handle.service.js";

/**
 * Build and send the OTP email for any flow (signup sign-in OTP or forget-password).
 * In development it also logs the code so the flow can be tested without a provider.
 * Returns the send Result; each caller decides how to treat a failure.
 */
async function sendOtpEmail(params: {
  readonly email: string;
  readonly otp: string;
  readonly type: string;
}): Promise<Awaited<ReturnType<typeof sendTransactionalEmail>>> {
  if (config.NODE_ENV === "development") {
    console.log(`OTP for ${params.email} (${params.type}): ${params.otp}`);
  }

  const subject =
    params.type === "forget-password"
      ? "Reset your Qatoto password"
      : "Your Qatoto verification code";

  return sendTransactionalEmail({
    toEmail: params.email,
    subject,
    htmlContent: `<p>Your Qatoto verification code is <strong>${params.otp}</strong>.</p><p>It expires shortly. If you did not request this, ignore this email.</p>`,
    textContent: `Your Qatoto verification code is ${params.otp}. It expires shortly. If you did not request this, ignore this email.`,
  });
}

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  secret: config.BETTER_AUTH_SECRET,
  baseURL: config.BETTER_AUTH_URL,
  trustedOrigins: [config.FRONTEND_URL],
  user: {
    // Expose the user's handle on the session so session.user.handle drives
    // menu/avatar display (the frontend mirrors this via inferAdditionalFields).
    // input:false — the handle is NEVER client-writable through Better Auth's own
    // update/signup paths; it is owned solely by PATCH /users/me/handle, which
    // runs the rate-limit + reservation transaction (src/services/handle.service.ts).
    additionalFields: {
      handle: { type: "string", required: false, input: false },
    },
  },
  // Guards Better Auth's OWN HTTP endpoints (the frontend hits these directly for
  // forgot-password and password login). Note: our /signup/* routes call auth.api
  // server-side, which this does NOT cover — those are rate limited in Express
  // (see src/middleware/rate-limit.ts). Enabled in all envs, not just production.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      // OTP send (forgot-password): tight cap so an inbox can't be flooded.
      "/email-otp/send-verification-otp": { window: 60, max: 3 },
      // OTP code verification: limit brute-force guessing across codes.
      "/sign-in/email-otp": { window: 60, max: 5 },
      "/email-otp/reset-password": { window: 60, max: 5 },
      // Password login: limit credential stuffing.
      "/sign-in/email": { window: 10, max: 5 },
    },
  },
  databaseHooks: {
    user: {
      create: {
        // OAuth (google/github) seeds `image` from the provider profile at first
        // sign-in. Stamp imageSource = "oauth" so the photo is marked
        // provider-owned: a later OAuth sign-in or DELETE /users/me/photo may
        // replace it, but PATCH /users/me/photo flips it to "user" — a lock that
        // OAuth then never overrides (updateUserInfoOnLink is off below). Users
        // created without an image (email/password, anonymous) keep imageSource
        // NULL. Mirrors the nameSetByUser mechanism for the display name.
        after: async (createdUser) => {
          if (createdUser.image) {
            await db.update(user).set({ imageSource: "oauth" }).where(eq(user.id, createdUser.id));
          }

          // Seed a unique randomized temporary handle from the user's name/email
          // (e.g. user_vidyesh_7a9f). Done here so every signup path — Google,
          // GitHub, email/password — gets one. A failure must NOT abort account
          // creation, so we log and move on; the user can still set a handle via
          // PATCH /users/me/handle, and getHandleMetadata tolerates a null handle.
          const placeholderResult = await assignPlaceholderHandle(
            createdUser.id,
            createdUser.name,
            createdUser.email,
          );
          if (!placeholderResult.success) {
            console.error(
              `Failed to assign placeholder handle to user ${createdUser.id}: ${placeholderResult.error.type}`,
            );
          }
        },
      },
    },
    account: {
      create: {
        // Write-once capture of the provider's email onto the account row, so the
        // settings panel can show which address each "Connected" provider is linked
        // as (GET /users/me/linked-accounts). We do it in `after` with an explicit
        // drizzle UPDATE — exactly like imageSource above — because `account.email`
        // is our own column, not one Better Auth knows about, so returning it from a
        // `before` hook would be dropped on insert.
        //
        // Only OAuth rows are touched: credential ("email-password") accounts have
        // no provider email and resolve theirs from user.email at read time. Google
        // carries a verified email in the stored id_token (no network call); GitHub
        // keeps it in no token, so we call /user/emails with the access token.
        //
        // A failure here must NEVER abort account creation/linking — the email is a
        // nice-to-have the backfill can fill in later. So we log and move on,
        // mirroring the placeholder-handle seeding above.
        after: async (createdAccount) => {
          let resolvedEmail: string | null = null;

          if (createdAccount.providerId === "google" && createdAccount.idToken) {
            const googleProfile = readGoogleProfileFromIdToken(createdAccount.idToken);
            if (googleProfile.success && googleProfile.value.email) {
              resolvedEmail = googleProfile.value.email;
            } else if (!googleProfile.success) {
              console.error(
                `Failed to read google email for account ${createdAccount.id}: ${googleProfile.error}`,
              );
            }
          } else if (createdAccount.providerId === "github" && createdAccount.accessToken) {
            const githubEmail = await fetchGitHubPrimaryEmail(createdAccount.accessToken);
            if (githubEmail.success) {
              resolvedEmail = githubEmail.value;
            } else {
              console.error(
                `Failed to fetch github email for account ${createdAccount.id}: ${githubEmail.error}`,
              );
            }
          }

          if (resolvedEmail) {
            await db
              .update(account)
              .set({ email: resolvedEmail })
              .where(eq(account.id, createdAccount.id));
          }
        },
      },
    },
  },
  account: {
    // One user = one email. Linking is on by default, but we make it explicit:
    // when a provider reports a VERIFIED email matching an existing user, the new
    // provider is attached to that same user instead of minting a second row
    // (which the UNIQUE email constraint would reject anyway).
    //
    // trustedProviders forces linking for google/github even in the rare case a
    // provider omits the verified flag — safe because both are first-party OAuth
    // we control the client config for. We deliberately do NOT trust
    // "email-password": a credential signup must prove the email (OTP) before it
    // can ride onto an existing OAuth account, which our /signup/complete already
    // enforces. Trusting it blindly would open account-takeover via unverified
    // password signup.
    accountLinking: {
      enabled: true,
      trustedProviders: ["google", "github"],
      // Let a signed-in user link a trusted provider whose email differs from
      // their account email (e.g. signed up with a personal email, links a
      // GitHub that uses a work email) — still ONE user, not a duplicate. The
      // active session is the trust anchor: you must already BE the user to
      // attach a different-email provider onto yourself, so this does not
      // auto-merge two separate accounts at fresh sign-in. Scoped to
      // trustedProviders (first-party Google/GitHub) only; "email-password"
      // stays untrusted (must prove the email via OTP — /signup/complete).
      allowDifferentEmails: true,
      // Do NOT let a newly linked provider overwrite the local user row. With
      // this on, linking a 2nd provider copies that provider's name/image onto
      // the user — which would clobber a name the user set themselves via
      // PATCH /users/me (see user.nameSetByUser). OAuth still seeds `name` at
      // first sign-in (user creation), so a brand-new OAuth user is unaffected;
      // only the link-time overwrite is suppressed. The cost is that an
      // email-first user's placeholder name is no longer auto-upgraded from the
      // provider on link — they set it explicitly instead.
      updateUserInfoOnLink: false,
    },
  },
  hooks: {
    // Server-side guard on Better Auth's own POST /unlink-account. Its built-in
    // protection only blocks unlinking the LAST remaining account (allowUnlinkingAll
    // is off, the default) — it does NOT protect the user's ORIGINAL provider, the
    // one the account was first created with. We forbid unlinking that one outright:
    // it owns the user's verified email/identity, and dropping it while a later-linked
    // provider remains would strand the account behind a credential the user never
    // intended to be primary. Frontend hides the button (UX only, per CLAUDE.md §1.1);
    // a hostile client can still POST the raw request, so the check lives here.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/unlink-account") {
        return;
      }

      // Defer auth failures to the endpoint's own session check — no session means
      // the unlink would be rejected there anyway; we only add the original-provider
      // rule on top of an authenticated caller.
      const session = await getSessionFromCtx(ctx);
      if (!session) {
        return;
      }

      const UnlinkAccountBodySchema = z
        .object({
          providerId: z.string().min(1),
          accountId: z.string().min(1).optional(),
        })
        .strip();
      const parsedBody = UnlinkAccountBodySchema.safeParse(ctx.body);
      if (!parsedBody.success) {
        // Let Better Auth's own validation produce the canonical error shape.
        return;
      }

      // The original provider is the user's earliest-created account row.
      const userAccountsOldestFirst = await db
        .select()
        .from(account)
        .where(eq(account.userId, session.user.id))
        .orderBy(asc(account.createdAt));
      const originalAccount = userAccountsOldestFirst[0];
      if (!originalAccount) {
        return;
      }

      // When accountId is supplied the request targets one specific row; otherwise it
      // targets every account under providerId — which sweeps up the original if its
      // provider matches. Reject either way when the original account is in scope.
      const requestTargetsOriginalAccount = parsedBody.data.accountId
        ? originalAccount.accountId === parsedBody.data.accountId
        : originalAccount.providerId === parsedBody.data.providerId;
      if (requestTargetsOriginalAccount) {
        throw new APIError("FORBIDDEN", {
          message: "The original sign-in provider cannot be unlinked.",
        });
      }
    }),
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    password: {
      hash: (password) => hash(password),
      verify: ({ hash: passwordHash, password }) => verify(passwordHash, password),
    },
  },
  socialProviders: {
    google: {
      clientId: config.GOOGLE_CLIENT_ID,
      clientSecret: config.GOOGLE_CLIENT_SECRET,
      prompt: "select_account",
      // Store the email lowercased so a brand-new user row is created with a
      // canonical address. citext already makes the linking lookup and UNIQUE
      // constraint case-insensitive (src/db/schema.ts) — this just keeps the
      // stored value clean so it never drifts by provider casing.
      mapProfileToUser: (profile) => ({ email: profile.email?.toLowerCase() }),
    },
    github: {
      clientId: config.GITHUB_CLIENT_ID,
      clientSecret: config.GITHUB_CLIENT_SECRET,
      prompt: "select_account",
      mapProfileToUser: (profile) => ({ email: profile.email?.toLowerCase() }),
    },
  },
  plugins: [
    anonymous(),
    passkey({
      // WebAuthn relying-party identity. The ceremony runs in the user's browser
      // at FRONTEND_URL, so rpID/origin derive from there (NOT the API origin).
      // rpID must be the frontend's registrable domain; origin must match exactly.
      rpID: new URL(config.FRONTEND_URL).hostname,
      rpName: "Qatoto",
      origin: new URL(config.FRONTEND_URL).origin,
      registration: {
        // Require an authenticated session to register a passkey. Account creation
        // is owned solely by POST /signup/complete (verified OTP + password); we do
        // NOT allow passkey-first onboarding, which would mint orphan users and
        // bypass that flow (mirrors emailOTP `disableSignUp: true`).
        requireSession: true,
        extensions: { credProps: true },
      },
      authentication: {
        extensions: { credProps: true },
      },
    }),
    emailOTP({
      // Never auto-create a user from `sign-in/email-otp`. Account creation is
      // owned solely by POST /signup/complete, which requires BOTH a verified OTP
      // AND a password in one atomic step — so verifying an OTP alone never leaves
      // a password-less orphan user behind.
      disableSignUp: true,
      async sendVerificationOTP({ email, otp, type }) {
        const sendResult = await sendOtpEmail({ email, otp, type });

        if (!sendResult.success) {
          // NOT_CONFIGURED in dev is expected (code already logged above); fail loudly otherwise.
          if (sendResult.error.type === "NOT_CONFIGURED" && config.NODE_ENV === "development") {
            return;
          }
          throw new Error(`Failed to send OTP email: ${JSON.stringify(sendResult.error)}`);
        }
      },
    }),
  ],
});

/**
 * Generate and send the signup verification OTP for a (possibly brand-new) email.
 *
 * Better Auth's public `/email-otp/send-verification-otp` silently refuses to send a
 * `sign-in` OTP to a non-existent user while `disableSignUp: true` — which would make
 * every first-time signup receive no code. We keep `disableSignUp: true` (so the public
 * `/sign-in/email-otp` route can never mint an orphan, password-less account) and instead
 * mint the code via the server-only `createVerificationOTP`, then send it ourselves. The
 * code is stored under the same `sign-in` identifier that POST /signup/complete later
 * checks with `checkVerificationOTP`, so verification is unchanged.
 */
export async function sendSignupOtp(
  email: string,
): Promise<Awaited<ReturnType<typeof sendTransactionalEmail>>> {
  const generatedOtp = await auth.api.createVerificationOTP({
    body: { email, type: "sign-in" },
  });

  if (typeof generatedOtp !== "string" || generatedOtp.length === 0) {
    // createVerificationOTP is contracted to return the freshly minted code; a
    // missing/empty value means Better Auth's internals changed under us.
    throw new Error("createVerificationOTP returned no OTP code");
  }

  return sendOtpEmail({ email, otp: generatedOtp, type: "sign-in" });
}
