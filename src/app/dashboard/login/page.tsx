import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getBrand } from "@/config/brand";
import { optionalClientSession } from "@/server/client/session";
import { cardClass, hintClass, inputClass, labelClass, primaryButton } from "../../admin/_components/styles";
import { requestLinkAction } from "./actions";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage(props: PageProps<"/dashboard/login">) {
  if (await optionalClientSession()) redirect("/dashboard");
  const query = await props.searchParams;
  const brand = getBrand();
  const sent = query.sent === "1";
  const error = query.error === "link" ? "That sign-in link has already been used or has expired. Ask for a new one below." : query.error === "slow_down" ? "Too many tries. Please wait a few minutes and try again." : query.error === "invalid_request" ? "Enter your email address." : undefined;

  return (
    <main id="main" className="mx-auto max-w-md px-4 py-12">
      <h1 className="text-3xl font-extrabold text-ink">{brand.name}</h1>
      <p className="mt-1 text-lg text-muted">Sign in to your leads</p>

      {error && (
        <p role="alert" className="mt-6 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-900">
          {error}
        </p>
      )}

      {sent ? (
        <div role="status" className={`${cardClass} mt-6`}>
          <h2 className="text-xl font-bold text-ink">Check your email</h2>
          <p className="mt-2">If that address is set up to receive leads, we have sent it a sign-in link. It works once and expires in 15 minutes.</p>
          <p className="mt-2 text-sm text-muted">Nothing arrived? Check your spam folder, or ask us to add your address.</p>
        </div>
      ) : (
        <form action={requestLinkAction} className={`${cardClass} mt-6 space-y-4`}>
          <div>
            <label htmlFor="email" className={labelClass}>Your work email</label>
            <p id="email-hint" className={hintClass}>We will email you a link. There is no password.</p>
            <input id="email" name="email" type="email" autoComplete="email" inputMode="email" required maxLength={254} aria-describedby="email-hint" className={`${inputClass} mt-1`} />
          </div>
          <button type="submit" className={`${primaryButton} w-full`}>Email me a sign-in link</button>
        </form>
      )}
    </main>
  );
}
