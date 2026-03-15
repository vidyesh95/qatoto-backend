import { betterAuth } from "better-auth";
import { anonymous } from "better-auth/plugins"
import { Pool } from "pg";

export const auth = betterAuth({
    database: new Pool({
        // connection options
    }),
    plugins: [
        anonymous()
    ]
})