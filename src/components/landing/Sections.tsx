import Link from "next/link";
import { ELECTRICAL_EMERGENCY } from "@/config/safety";
import { SERVICE_SLUGS, SERVICES } from "@/config/verticals/electrical";
import type { Brand } from "@/config/brand";
import { Eyebrow } from "./Eyebrow";
import { CheckIcon, ServiceIcon } from "./icons";

/**
 * Below-the-fold content. Every claim here is a statement about how the service works, never a
 * claim about third parties we cannot substantiate (no review counts, "vetted", "accredited" or
 * "insured" unless and until they are true and provable: UK consumer-protection law treats those
 * as regulated claims). Edit freely, but keep it true.
 */

export function HowItWorks() {
  const steps = [
    { title: "Tell us about the job", body: "Answer a few quick questions about the work. It takes about a minute." },
    { title: "We find a local electrician", body: "We pass your enquiry to one electrical business that covers your postcode." },
    { title: "They get in touch", body: "They contact you to discuss the work and give you a quote. There's no obligation." },
  ];
  return (
    <section id="how" aria-labelledby="how-heading" className="bg-canvas py-16 sm:py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <Eyebrow>Simple and free</Eyebrow>
        <h2 id="how-heading" className="mt-2 text-3xl font-semibold text-ink sm:text-4xl">
          How it works
        </h2>
        <ol className="mt-10 grid gap-5 md:grid-cols-3">
          {steps.map((step, index) => (
            <li key={step.title} className="relative overflow-hidden rounded-2xl bg-white p-7 shadow-[0_1px_2px_rgba(15,36,56,0.06),0_8px_24px_-12px_rgba(15,36,56,0.18)] ring-1 ring-stone-200">
              <span aria-hidden="true" className="absolute -right-2 -top-5 font-display text-[7rem] font-semibold leading-none text-brand-100">
                {index + 1}
              </span>
              <span aria-hidden="true" className="relative grid size-11 place-items-center rounded-full bg-navy-800 font-display text-lg font-semibold text-white">
                {index + 1}
              </span>
              <h3 className="relative mt-5 text-xl font-semibold text-ink">{step.title}</h3>
              <p className="relative mt-2 text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export function ServicesList() {
  return (
    <section aria-labelledby="services-heading" className="bg-white py-16 sm:py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <Eyebrow>What we can help with</Eyebrow>
        <h2 id="services-heading" className="mt-2 max-w-2xl text-3xl font-semibold text-ink sm:text-4xl">
          Electrical work we can help you find an electrician for
        </h2>
        <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {SERVICE_SLUGS.filter((slug) => slug !== "other").map((slug) => (
            <li key={slug} className="group flex gap-4 rounded-2xl bg-canvas p-5 ring-1 ring-stone-200 transition-shadow hover:shadow-md motion-reduce:transition-none">
              <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-white text-brand-700 shadow-sm ring-1 ring-stone-200">
                <ServiceIcon slug={slug} className="size-6" />
              </span>
              <div>
                <h3 className="text-lg font-semibold text-ink">{SERVICES[slug].label}</h3>
                <p className="mt-1 text-muted">{SERVICES[slug].hint}</p>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-6 flex items-center gap-2 text-muted">
          <CheckIcon className="size-5 text-success" />
          Not on the list? Choose &ldquo;something else&rdquo; on the form and tell us about it.
        </p>
      </div>
    </section>
  );
}

export function Faq({ brand }: { brand: Brand }) {
  const { phone, powerCut } = ELECTRICAL_EMERGENCY;
  const items: Array<{ question: string; answer: React.ReactNode }> = [
    {
      question: "What if there are sparks, a burning smell or someone has had a shock?",
      answer: (
        <>
          {ELECTRICAL_EMERGENCY.body} The number is{" "}
          <a href={`tel:${phone.tel}`} className="font-semibold text-brand-800 underline">
            {phone.display}
          </a>
          . For a power cut or a fallen cable, call{" "}
          <a href={`tel:${powerCut.tel}`} className="font-semibold text-brand-800 underline">
            {powerCut.display}
          </a>{" "}
          (free, 24 hours a day).
        </>
      ),
    },
    {
      question: "Is it really free?",
      answer: `Yes. Using ${brand.name} costs you nothing. Electrical businesses pay us for introductions to people who are looking for electrical work in their area.`,
    },
    {
      question: "Are you an electrical company?",
      answer: `No. ${brand.legalName} is an introduction service. We don't carry out electrical work ourselves. Any quote, contract or work is agreed directly between you and the electrical business.`,
    },
    {
      question: "Who will contact me, and how?",
      answer:
        "One local electrical business that covers your postcode. They may contact you by phone, text message, WhatsApp or email about your enquiry, exactly as you agree on the form.",
    },
    {
      question: "What does a quote cost?",
      answer:
        "Prices depend on the job, so there's no price on this page. The electrical business will discuss your job and give you a quote. You're under no obligation to accept it.",
    },
    {
      // Advice only. We do not check registrations yet, so the site never claims the businesses are registered (docs/00 E4).
      question: "How do I check an electrician is qualified?",
      answer:
        "In England, work such as a new circuit or replacing a consumer unit has to be done by an electrician registered with a government-approved competent person scheme, or be notified to your council's building control before it starts. Ask to see their registration and check it on the scheme's own register before work begins, and ask for the electrical certificate when the job is finished. We don't check registrations ourselves, so we never claim that a business is registered.",
    },
    {
      question: "What is an EICR, and do I need one?",
      answer:
        "An Electrical Installation Condition Report (EICR) is an inspection of the fixed wiring in a property and a report on its condition. Landlords of privately rented homes in England must have one carried out at least every 5 years and give a copy to their tenants. Many buyers and mortgage lenders also ask for one.",
    },
    {
      question: "Which areas do you cover?",
      answer: `We currently cover ${brand.launchRegion}. Enter your postcode on the form and we'll tell you straight away if we can help.`,
    },
    {
      question: "What happens to my details?",
      answer: (
        <>
          We use them to find you an electrical business and pass your enquiry on, and we share them only as you agree on the form. You
          can withdraw your consent or ask us to delete your details at any time. See our{" "}
          <Link href="/privacy" className="font-semibold text-brand-800 underline">
            Privacy Notice
          </Link>
          .
        </>
      ),
    },
  ];

  return (
    <section id="faq" aria-labelledby="faq-heading" className="bg-canvas py-16 sm:py-20">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <Eyebrow>Good to know</Eyebrow>
        <h2 id="faq-heading" className="mt-2 text-3xl font-semibold text-ink sm:text-4xl">
          Questions you might have
        </h2>
        <div className="mt-8 divide-y divide-stone-200 rounded-2xl bg-white shadow-[0_8px_24px_-12px_rgba(15,36,56,0.18)] ring-1 ring-stone-200">
          {items.map((item) => (
            <details key={item.question} className="group p-5 sm:px-7">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-lg text-lg font-semibold text-ink focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300 [&::-webkit-details-marker]:hidden">
                {item.question}
                <svg
                  aria-hidden="true"
                  viewBox="0 0 20 20"
                  className="size-5 shrink-0 text-brand-700 transition-transform group-open:rotate-180 motion-reduce:transition-none"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M5 8l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </summary>
              <p className="mt-3 text-muted">{item.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Footer({ brand }: { brand: Brand }) {
  return (
    <footer className="bg-navy-950 py-12 text-sm text-navy-200">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <p className="font-display text-lg font-semibold text-white">{brand.name}</p>
        <p className="mt-3 font-semibold text-navy-100">{brand.legalName}</p>
        <p className="mt-1">
          Registered in England and Wales, company number {brand.companyNumber}. Registered office: {brand.registeredAddress}.
        </p>
        <p className="mt-1">ICO registration number: {brand.icoRegistration}.</p>
        <p className="mt-1">
          {brand.name} is an introduction service. We are not an electrical company and do not carry out electrical work.
        </p>
        <nav aria-label="Legal" className="mt-5 flex gap-6">
          <Link href="/privacy" className="font-semibold text-white underline underline-offset-4 hover:text-brand-300">
            Privacy Notice
          </Link>
          <Link href="/terms" className="font-semibold text-white underline underline-offset-4 hover:text-brand-300">
            Terms of use
          </Link>
        </nav>
      </div>
    </footer>
  );
}
