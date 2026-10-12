import { expect, type APIRequestContext } from "@playwright/test";

/** The local Supabase mail catcher (Mailpit). A stack started on other ports sets MAILPIT_URL. */
const mailbox = process.env.MAILPIT_URL ?? "http://127.0.0.1:54325";

/** The newest six-digit code sent to this address by local Auth. */
export async function latestEmailCode(request: APIRequestContext, email: string) {
  let code = "";
  await expect.poll(async () => {
    const response = await request.get(`${mailbox}/api/v1/messages`);
    const body = await response.json() as {
      messages: Array<{ To: Array<{ Address: string }>; Subject: string; Snippet: string; Created: string }>;
    };
    const message = body.messages
      .filter((candidate) => candidate.To.some((recipient) => recipient.Address === email))
      .sort((left, right) => right.Created.localeCompare(left.Created))[0];
    code = message?.Snippet.match(/\b\d{6}\b/)?.[0] ?? "";
    return code;
  }, { timeout: 10_000 }).toMatch(/^\d{6}$/);
  return code;
}
