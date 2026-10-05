import type { ReactNode } from "react";
import { getBrand } from "@/config/brand";
import { Footer } from "./Sections";
import { Header } from "./Header";

/** Shared chrome for the legal pages, including the DRAFT banner shown until legal sign-off. */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  const brand = getBrand();
  return (
    <>
      <Header brandName={brand.name} />
      <main id="main" className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        {!brand.legalReviewed ? (
          <aside role="note" className="mb-8 rounded-lg border-2 border-amber-600 bg-amber-50 p-4 text-sm font-semibold text-amber-950">
            DRAFT TEMPLATE. This text is a starting point written by engineers, not legal advice. Have it reviewed by a
            qualified UK data-protection solicitor, then set LEGAL_TEXT_REVIEWED=true. Production will not start until you do.
          </aside>
        ) : null}
        <h1 className="text-4xl font-extrabold tracking-tight">{title}</h1>
        <div className="mt-6 space-y-5 text-base leading-7 [&_h2]:mt-10 [&_h2]:text-2xl [&_h2]:font-bold [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1.5 [&_a]:font-semibold [&_a]:text-brand-800 [&_a]:underline">
          {children}
        </div>
      </main>
      <Footer brand={brand} />
    </>
  );
}
