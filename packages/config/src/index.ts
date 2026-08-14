import { z } from "zod";

const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_PORTAL_URL: z.url().default("http://127.0.0.1:3000"),
  NEXT_PUBLIC_PDV_URL: z.url().default("http://127.0.0.1:3001"),
});

const serverEnvSchema = publicEnvSchema.extend({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1).optional(),
  ABACATEPAY_API_KEY: z.string().min(1).optional(),
  ABACATEPAY_WEBHOOK_SECRET: z.string().min(16).optional(),
  PAYMENTS_ENABLED: z.enum(["true", "false"]).default("false"),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function parsePublicEnv(input: Record<string, string | undefined>): PublicEnv {
  return publicEnvSchema.parse(input);
}

export function parseServerEnv(input: Record<string, string | undefined>): ServerEnv {
  return serverEnvSchema.parse(input);
}
