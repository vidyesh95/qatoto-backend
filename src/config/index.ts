import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(8000),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  DATABASE_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(16),
  FRONTEND_URL: z.url(),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
