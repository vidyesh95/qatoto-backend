import { hash, verify } from "@node-rs/argon2";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { anonymous, emailOTP } from "better-auth/plugins";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";

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
      // Dev: print the code to the server log. Wire a real email provider here for prod.
      sendVerificationOTP({ email, otp, type }) {
        if (config.NODE_ENV === "development") {
          console.log(`OTP for ${email} (${type}): ${otp}`);
        }
        return Promise.resolve();
      },
    }),
  ],
});
