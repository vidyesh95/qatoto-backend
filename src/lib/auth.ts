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
