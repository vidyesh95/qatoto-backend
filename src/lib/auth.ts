import { betterAuth } from "better-auth";
import { anonymous } from "better-auth/plugins"
import { pool } from "#src/db/index.js";

export const auth = betterAuth({
    database: pool,
    plugins: [
        anonymous()
    ]
});