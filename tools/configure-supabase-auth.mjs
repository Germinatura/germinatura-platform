import { readFile } from "node:fs/promises";

const required = [
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_PROJECT_ID",
  "NEXT_PUBLIC_PORTAL_URL",
  "NEXT_PUBLIC_PDV_URL",
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const signupTemplate = await readFile(new URL("../supabase/templates/institutional-otp.html", import.meta.url), "utf8");
const recoveryTemplate = await readFile(new URL("../supabase/templates/password-recovery-otp.html", import.meta.url), "utf8");
for (const template of [signupTemplate, recoveryTemplate]) {
  if (!template.includes("{{ .Token }}") || template.includes("{{ .ConfirmationURL }}")) {
    throw new Error("Auth templates must expose only the one-time code");
  }
}

const projectId = process.env.SUPABASE_PROJECT_ID;
const response = await fetch(`https://api.supabase.com/v1/projects/${projectId}/config/auth`, {
  method: "PATCH",
  headers: {
    Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    site_url: process.env.NEXT_PUBLIC_PORTAL_URL,
    uri_allow_list: `${process.env.NEXT_PUBLIC_PORTAL_URL},${process.env.NEXT_PUBLIC_PDV_URL}`,
    mailer_subjects_magic_link: "Seu código de verificação Germinatura",
    mailer_templates_magic_link_content: signupTemplate,
    mailer_subjects_recovery: "Seu código de recuperação Germinatura",
    mailer_templates_recovery_content: recoveryTemplate,
  }),
});

if (!response.ok) {
  const details = await response.text();
  throw new Error(`Supabase Auth configuration failed (${response.status}): ${details.slice(0, 300)}`);
}

const configured = await response.json();
if (
  !String(configured.mailer_templates_magic_link_content ?? "").includes("{{ .Token }}")
  || !String(configured.mailer_templates_recovery_content ?? "").includes("{{ .Token }}")
) {
  throw new Error("Supabase Auth did not retain the signup/recovery OTP templates");
}
console.log("Supabase signup/recovery code templates and approved URLs configured.");
