import Link from "next/link";
import { loadDashboardHeader } from "@/server/client/portal";
import { signOutAction } from "./actions";

export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const { clientName, person } = await loadDashboardHeader();
  return (
    <>
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
          <nav aria-label="Dashboard" className="flex flex-wrap items-center gap-x-5 gap-y-1">
            <Link href="/dashboard" className="text-lg font-extrabold tracking-tight text-ink">{clientName}</Link>
            <Link href="/dashboard" className="font-semibold text-brand-800 underline underline-offset-4">New leads</Link>
            <Link href="/dashboard/history" className="font-semibold text-brand-800 underline underline-offset-4">History</Link>
          </nav>
          <form action={signOutAction} className="text-sm text-muted">
            {person} · <button type="submit" className="underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300">Sign out</button>
          </form>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
        {children}
      </main>
    </>
  );
}
