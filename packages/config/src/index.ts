import { z } from "zod";

const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_PORTAL_URL: z.url().default("http://127.0.0.1:3000"),
  NEXT_PUBLIC_PDV_URL: z.url().default("http://127.0.0.1:3001"),
});

const serverEnvSchema = publicEnvSchema;

export type PublicEnv = z.infer<typeof publicEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;

export function parsePublicEnv(input: Record<string, string | undefined>): PublicEnv {
  return publicEnvSchema.parse(input);
}

export function parseServerEnv(input: Record<string, string | undefined>): ServerEnv {
  return serverEnvSchema.parse(input);
}
