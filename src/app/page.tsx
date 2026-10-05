import { getBrand } from "@/config/brand";
import { buildConsent } from "@/config/consent";
import { Faq, Footer, HowItWorks, ServicesList } from "@/components/landing/Sections";
import { CoverageMap } from "@/components/landing/CoverageMap";
import { Header } from "@/components/landing/Header";
import { CheckIcon } from "@/components/landing/icons";
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
        <section id="top" aria-labelledby="hero-heading" className="relative isolate overflow-hidden bg-navy-900 text-white">
          {/* Decoration only: a soft copper glow and a faint tile pattern. */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
            <div className="absolute -right-32 -top-40 size-[34rem] rounded-full bg-brand-600/25 blur-3xl" />
            <div className="absolute -bottom-48 -left-24 size-[28rem] rounded-full bg-navy-600/40 blur-3xl" />
            <svg className="absolute inset-0 size-full text-white/[0.045]" width="100%" height="100%">
              <defs>
                <pattern id="tiles" width="56" height="40" patternUnits="userSpaceOnUse">
                  <path d="M0 40 28 12 56 40M-28 20l28-28 28 28M28 20l28-28 28 28" fill="none" stroke="currentColor" strokeWidth="1.2" />
                </pattern>
              </defs>
              <rect width="100%" height="100%" fill="url(#tiles)" />
            </svg>
          </div>
          {/*
            Mobile order: headline, FORM, then the trust points (paid traffic is mostly phones, and the
            first question must be visible without scrolling). Desktop: copy on the left, form on the right.
          */}
          <div className="mx-auto grid max-w-6xl gap-x-14 gap-y-7 px-4 py-8 sm:px-6 lg:grid-cols-[1fr_28rem] lg:grid-rows-[auto_1fr] lg:py-20">
            <div className="lg:col-start-1 lg:row-start-1 lg:pt-4">
              <p className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3.5 py-1.5 text-sm font-medium text-navy-100 ring-1 ring-white/15">
                <span aria-hidden="true" className="size-2 rounded-full bg-brand-300" />
                Serving {brand.launchRegion}
              </p>
              <h1 id="hero-heading" className="mt-5 text-4xl font-semibold leading-[1.08] text-white sm:text-5xl lg:text-[3.5rem]">
                Free roofing quotes from <span className="text-brand-300">local roofers</span>
              </h1>
              <p className="mt-4 max-w-xl text-lg text-navy-100">
                Tell us about your roof in about a minute. We pass your enquiry to one local roofing business that covers your postcode.
              </p>
            </div>

            <div
              id="quote"
              className="min-h-[34rem] rounded-2xl bg-white p-5 text-ink shadow-[0_24px_60px_-20px_rgba(0,0,0,0.55)] ring-1 ring-white/10 sm:p-7 lg:col-start-2 lg:row-span-2 lg:row-start-1"
            >
              <LeadForm
                brandName={brand.name}
                privacyEmail={brand.privacyEmail}
                launchRegion={brand.launchRegion}
                turnstileSiteKey={getSiteEnv().TURNSTILE_SITE_KEY}
                consent={{ version: consent.version, segments: consent.segments }}
              />
            </div>

            <ul className="space-y-3 text-base font-medium text-white lg:col-start-1 lg:row-start-2 lg:self-start">
              {[
                "Free to use, with no obligation",
                "Your details go to one local roofing business, not a list of companies",
                "Takes about a minute",
              ].map((point) => (
                <li key={point} className="flex gap-3">
                  <span aria-hidden="true" className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-brand-300/20 text-brand-300">
                    <CheckIcon className="size-4" />
                  </span>
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
