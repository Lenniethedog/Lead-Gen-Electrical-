import type { Metadata } from "next";
import { getBrand } from "@/config/brand";
import { looksLikeSecret } from "@/modules/clientauth";
import { cardClass, primaryButton } from "../../admin/_components/styles";
import { completeSignInAction } from "./actions";

// Referrer-Policy: no-referrer is also set for /dashboard/* in next.config.ts.
export const metadata: Metadata = { title: "Sign in", referrer: "no-referrer" };

/**
 * The page the emailed link opens. It does NOT sign anyone in by itself: email scanners and link previewers open links with GET,
 * and would spend the one-time link before its owner clicked it. The person presses a button, which POSTs the token (docs/00 D43).
 */
export default async function SignInPage(props: PageProps<"/dashboard/signin">) {
  const { token } = await props.searchParams;
  const brand = getBrand();
  const valid = typeof token === "string" && looksLikeSecret(token);

  return (
    <main id="main" className="mx-auto max-w-md px-4 py-12">
      <h1 className="text-3xl font-extrabold text-ink">{brand.name}</h1>
      {valid ? (
        <form action={completeSignInAction} className={`${cardClass} mt-6 space-y-4`}>
          <h2 className="text-xl font-bold text-ink">Ready to sign in?</h2>
          <p>Press the button to open your leads.</p>
          <input type="hidden" name="token" value={token} />
          <button type="submit" className={`${primaryButton} w-full`}>Sign in</button>
        </form>
      ) : (
        <div role="alert" className={`${cardClass} mt-6`}>
          <h2 className="text-xl font-bold text-ink">This link is not valid</h2>
          <p className="mt-2">Open the whole link from your email, or <a className="font-semibold text-brand-800 underline" href="/dashboard/login">ask for a new one</a>.</p>
        </div>
      )}
    </main>
  );
}
