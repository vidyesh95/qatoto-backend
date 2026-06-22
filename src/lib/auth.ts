import { hash, verify } from "@node-rs/argon2";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { anonymous, emailOTP } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey"

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
      registration: {
        // Default: true. Set false for passkey-first onboarding.
        requireSession: false,
        // Required if requireSession is false and no session exists.
        // resolveUser: async ({ ctx, context }) => {
        //   // Validate context (e.g., a signed token), then create or load a user.
        //   return { id: "user-id", name: "user@example.com" }
        // },
        // Optional server-defined extensions
        extensions: { credProps: true },
      },
      authentication: {
        // Optional server-defined extensions
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
