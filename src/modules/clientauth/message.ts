import { CLIENT_AUTH } from "@/config/client-auth";

/** The sign-in email. Plain text, one link, no tracking, no consumer details of any kind. */
export function buildSignInMessage(input: { name: string; brandName: string; link: string }): { subject: string; text: string } {
  return {
    subject: `Your sign-in link for ${input.brandName}`,
    text: [
      `Hi ${input.name},`,
      "",
      `Use this link to sign in to your ${input.brandName} leads. It works once, for ${CLIENT_AUTH.linkTtlMinutes} minutes:`,
      "",
      input.link,
      "",
      "If you did not ask for this, ignore this email: nobody can sign in without the link.",
    ].join("\n"),
  };
}
