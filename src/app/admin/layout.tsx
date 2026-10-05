import type { Metadata } from "next";
import Link from "next/link";
import { loadOperatorEmail } from "@/server/admin/inbox";

// Never indexed, never cached: the response carries personal data and is for named operators only.
export const metadata: Metadata = {
  title: { default: "Operator inbox", template: "%s | Operator inbox" },
  robots: { index: false, follow: false, nocache: true },
};

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const email = await loadOperatorEmail();
  return (
    <div className="min-h-dvh bg-stone-50">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <nav aria-label="Admin" className="flex flex-wrap items-center gap-x-5 gap-y-1">
            <Link href="/admin/leads" className="text-lg font-extrabold tracking-tight text-ink">
              Operator inbox
            </Link>
            {([["/admin/leads", "Leads"], ["/admin/clients", "Clients"], ["/admin/coverage", "Coverage tester"], ["/admin/pricing", "Pricing"], ["/admin/routing", "Routing"], ["/admin/deliveries", "Deliveries"]] as const).map(([href, label]) => (
              <Link key={href} href={href} className="font-semibold text-brand-800 underline underline-offset-4">
                {label}
              </Link>
            ))}
          </nav>
          <p className="text-sm text-muted">
            Signed in as <span className="font-semibold text-ink">{email}</span>
            {" · "}
            {/* Cloudflare Access ends the session; this path is served by Cloudflare, not by this app. */}
            <a className="underline" href="/cdn-cgi/access/logout">
              Sign out
            </a>
          </p>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        {children}
      </main>
    </div>
  );
}
