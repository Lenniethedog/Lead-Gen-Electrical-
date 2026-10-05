import { getBrand } from "@/config/brand";
import { buildConsent } from "@/config/consent";
import { Faq, Footer, HowItWorks, ServicesList } from "@/components/landing/Sections";
import { CoverageMap } from "@/components/landing/CoverageMap";
import { Header } from "@/components/landing/Header";
import { LeadForm } from "@/components/lead-form/LeadForm";
import { getSiteEnv } from "@/lib/env";

// Statically rendered and CDN-cacheable: the page reads only build-time configuration. Nothing here
// may use cookies(), headers() or searchParams, or it would become per-request and uncacheable.
export default function HomePage() {
  const brand = getBrand();
  const consent = buildConsent(brand.name);

  return (
    <>
      <Header brandName={brand.name} />
      <main id="main">
        <section id="top" aria-labelledby="hero-heading" className="bg-brand-50">
          {/*
            Mobile order: headline, FORM, then the trust points (paid traffic is mostly phones, and the
            first question must be visible without scrolling). Desktop: copy on the left, form on the right.
          */}
          <div className="mx-auto grid max-w-6xl gap-x-14 gap-y-6 px-4 py-6 sm:px-6 lg:grid-cols-[1fr_28rem] lg:grid-rows-[auto_1fr] lg:py-14">
            <div className="lg:col-start-1 lg:row-start-1 lg:pt-6">
              <h1 id="hero-heading" className="text-3xl font-extrabold leading-tight tracking-tight text-ink sm:text-5xl">
                Free roofing quotes from local roofers
              </h1>
              <p className="mt-3 text-base text-muted sm:text-lg">
                Serving {brand.launchRegion}. Tell us about your roof in about a minute.
              </p>
            </div>

            <div
              id="quote"
              className="min-h-[34rem] rounded-2xl bg-white p-5 shadow-lg ring-1 ring-stone-200 sm:p-7 lg:col-start-2 lg:row-span-2 lg:row-start-1"
            >
              <LeadForm
                brandName={brand.name}
                privacyEmail={brand.privacyEmail}
                launchRegion={brand.launchRegion}
                turnstileSiteKey={getSiteEnv().TURNSTILE_SITE_KEY}
                consent={{ version: consent.version, segments: consent.segments }}
              />
            </div>

            <ul className="space-y-2.5 text-base font-semibold text-ink lg:col-start-1 lg:row-start-2 lg:self-start">
              {[
                "Free to use, with no obligation",
                "Your details go to one local roofing business, not a list of companies",
                "Takes about a minute",
              ].map((point) => (
                <li key={point} className="flex gap-3">
                  <svg aria-hidden="true" viewBox="0 0 20 20" className="mt-0.5 size-5 shrink-0 text-success" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M4 10.5l4 4 8-9" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {point}
                </li>
              ))}
            </ul>
          </div>
        </section>
        <HowItWorks />
        <ServicesList />
        <CoverageMap launchRegion={brand.launchRegion} />
        <Faq brand={brand} />
      </main>
      <Footer brand={brand} />
    </>
  );
}
