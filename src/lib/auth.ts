import { passkey } from "@better-auth/passkey";
import { hash, verify } from "@node-rs/argon2";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { anonymous, emailOTP } from "better-auth/plugins";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";
import { sendTransactionalEmail } from "#src/lib/email.js";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  secret: config.BETTER_AUTH_SECRET,
  baseURL: config.BETTER_AUTH_URL,
  trustedOrigins: [config.FRONTEND_URL],
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
      // Backfill the user's profile from the provider when an account links.
      // Default leaves the existing row untouched, so an email-first user keeps
      // name=null/image=null even after Google reports both. This syncs `name`
      // and `image` on link; `email`/`emailVerified` are never rebound by it.
      updateUserInfoOnLink: true,
    },
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
    },
    github: {
      clientId: config.GITHUB_CLIENT_ID,
      clientSecret: config.GITHUB_CLIENT_SECRET,
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
        // Dev: print the code to the server log so you can test without a provider.
        if (config.NODE_ENV === "development") {
          console.log(`OTP for ${email} (${type}): ${otp}`);
        }

        const subject =
          type === "forget-password"
            ? "Reset your Qatoto password"
            : "Your Qatoto verification code";
        const sendResult = await sendTransactionalEmail({
          toEmail: email,
          subject,
          htmlContent: `<p>Your Qatoto verification code is <strong>${otp}</strong>.</p><p>It expires shortly. If you did not request this, ignore this email.</p>`,
          textContent: `Your Qatoto verification code is ${otp}. It expires shortly. If you did not request this, ignore this email.`,
        });

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
