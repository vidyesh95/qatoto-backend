import { hash, verify } from "@node-rs/argon2";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { anonymous } from "better-auth/plugins";

import { config } from "#src/config/index.js";
import { db } from "#src/db/index.js";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  secret: config.BETTER_AUTH_SECRET,
  baseURL: `http://localhost:${config.PORT}`,
  trustedOrigins: [config.FRONTEND_URL],
  emailAndPassword: {
    enabled: true,
    password: {
      hash: (password) => hash(password),
      verify: ({ hash: passwordHash, password }) => verify(passwordHash, password),
    },
  },
  plugins: [anonymous()],
});
