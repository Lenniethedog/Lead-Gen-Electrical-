import Image from "next/image";
import { projectAreas } from "@/config/coverage-map";
import { Eyebrow } from "./Eyebrow";

/**
 * Where we cover, on a real street map. The picture is built once from OpenStreetMap data (`npm run map:build`) and served from this site, so a
 * visitor's browser contacts no map provider (nothing about them leaves the site). The numbered circles are drawn over it from the same area list
 * the postcode checker uses (a test fails if the two drift apart). They show roughly where we cover, never a boundary: the postcode checker is the authority.
 * The numbered list beside the map is the accessible version of the same information.
 */
export function CoverageMap({ launchRegion }: { launchRegion: string }) {
  const { width, height, areas } = projectAreas();
  return (
    <section id="coverage" aria-labelledby="coverage-heading" className="bg-white py-16 sm:py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <Eyebrow>Areas we cover</Eyebrow>
        <h2 id="coverage-heading" className="mt-2 max-w-3xl text-3xl font-semibold text-ink sm:text-4xl">
          Local roofers across {launchRegion}
        </h2>
        <p className="mt-3 max-w-2xl text-lg text-muted">
          Find your town on the map, or just enter your postcode in the form and we will tell you straight away whether we can help.
        </p>

        <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_21rem]">
          <figure className="overflow-hidden rounded-2xl bg-white shadow-[0_1px_2px_rgba(15,36,56,0.06),0_12px_32px_-14px_rgba(15,36,56,0.28)] ring-1 ring-stone-200">
            <div
              tabIndex={0}
              role="region"
              aria-label="Map of the areas we cover. On a small screen, swipe sideways to see all of it."
              className="overflow-x-auto focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-brand-300"
            >
              <div className="relative min-w-[720px]">
                <Image src="/images/coverage-map.webp" alt="" width={width} height={height} sizes="(min-width: 1024px) 800px, 720px" className="block h-auto w-full" />
                <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="absolute inset-0 size-full">
                  {areas.flatMap(({ area, circles }) =>
                    circles.map((circle, index) => (
                      <circle key={`${area.slug}-${index}`} cx={circle.x} cy={circle.y} r={circle.r} fill="var(--color-brand-600)" fillOpacity="0.1" stroke="var(--color-brand-700)" strokeWidth="3.5" />
                    )),
                  )}
                  {areas.flatMap(({ area, number, badges }) =>
                    badges.map((badge, index) => (
                      <g key={`${area.slug}-badge-${index}`}>
                        <circle cx={badge.x} cy={badge.y} r="23" fill="var(--color-navy-900)" stroke="#ffffff" strokeWidth="4" />
                        <text x={badge.x} y={badge.y} textAnchor="middle" dominantBaseline="central" fill="#ffffff" fontSize="25" fontWeight="700" style={{ fontFamily: "var(--font-sans)" }}>
                          {number}
                        </text>
                      </g>
                    )),
                  )}
                </svg>
              </div>
            </div>
            <p className="border-t border-stone-200 px-4 py-2 text-xs font-medium text-muted md:hidden">Swipe the map sideways to see all of it.</p>
            <figcaption className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-stone-200 px-4 py-2.5 text-xs text-muted">
              <span>The circles show roughly where we cover, not exact boundaries.</span>
              <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" className="rounded underline underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300">
                Map © OpenStreetMap contributors
              </a>
            </figcaption>
          </figure>

          <ol aria-label="The areas on the map" className="grid content-start gap-1.5 rounded-2xl bg-canvas p-3 ring-1 ring-stone-200 sm:grid-cols-2 lg:grid-cols-1">
            {areas.map(({ area, number }) => (
              <li key={area.slug} className="flex items-start gap-3 rounded-xl px-2.5 py-2">
                <span aria-hidden="true" className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-navy-900 text-sm font-bold text-white">
                  {number}
                </span>
                <span>
                  <span className="block font-semibold leading-tight text-ink">{area.name}</span>
                  <span className="block text-sm text-muted">{area.districts.join(", ")}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
