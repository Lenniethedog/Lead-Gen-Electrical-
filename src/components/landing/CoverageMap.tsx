import Image from "next/image";
import { projectAreas } from "@/config/coverage-map";
import { Eyebrow } from "./Eyebrow";

/**
 * Where we cover, on a real street map. The picture is built once from OpenStreetMap data (`npm run map:build`) and served from this site, so a
 * visitor's browser contacts no map provider (nothing about them leaves the site). A red dot marks each area, with its name beside it; the dots and
 * names are drawn over the picture from the same area list the postcode checker uses (a test fails if the two drift apart, and another proves no name
 * lands on another name or dot). They show roughly where we cover, never a boundary: the postcode checker is the authority. The list beside the
 * map has the same areas with their postcode districts.
 */
const SIDE: Record<string, string> = {
  r: "left-full top-1/2 ml-2 -translate-y-1/2",
  l: "right-full top-1/2 mr-2 -translate-y-1/2",
  t: "bottom-full left-1/2 mb-1.5 -translate-x-1/2",
  b: "left-1/2 top-full mt-1.5 -translate-x-1/2",
};

export function CoverageMap({ launchRegion }: { launchRegion: string }) {
  const { width, height, areas } = projectAreas();
  return (
    <section id="coverage" aria-labelledby="coverage-heading" className="bg-white py-16 sm:py-20">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <Eyebrow>Areas we cover</Eyebrow>
        <h2 id="coverage-heading" className="mt-2 max-w-3xl text-3xl font-semibold text-ink sm:text-4xl">
          Local electricians across {launchRegion}
        </h2>
        <p className="mt-3 max-w-2xl text-lg text-muted">
          Find your town on the map, or just enter your postcode in the form and we will tell you straight away whether we can help.
        </p>

        <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_21rem]">
          <figure className="overflow-hidden rounded-2xl bg-white shadow-[0_1px_2px_rgba(15,36,56,0.06),0_12px_32px_-14px_rgba(15,36,56,0.28)] ring-1 ring-stone-200">
            <p className="border-b border-stone-200 bg-canvas px-4 py-2 text-sm font-medium text-ink md:hidden">
              <span aria-hidden="true">↔ </span>Swipe the map sideways to see all of it.
            </p>
            <div
              tabIndex={0}
              role="region"
              aria-label="Map of the areas we cover. On a small screen, swipe sideways to see all of it."
              className="relative overflow-x-auto focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-brand-300"
            >
              <div className="relative min-w-[720px]">
                <Image src="/images/coverage-map.webp" alt="" width={width} height={height} sizes="(min-width: 1024px) 800px, 720px" className="block h-auto w-full" />
                {/* Decorative: the list beside the map carries the same information as text. */}
                <div aria-hidden="true" className="absolute inset-0">
                  {areas.flatMap(({ area, points }) =>
                    points.map((point, index) => (
                      <span key={`${area.slug}-${index}`} className="absolute" style={{ left: `${point.leftPct}%`, top: `${point.topPct}%` }}>
                        <span data-map-dot className="absolute left-0 top-0 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-pin shadow-[0_1px_3px_rgba(15,36,56,0.55)] ring-2 ring-white" />
                        <span className={`absolute whitespace-nowrap text-[12px] font-bold leading-none text-navy-950 [text-shadow:0_0_2px_#fff,0_0_2px_#fff,0_0_3px_#fff,0_0_3px_#fff,0_0_5px_#fff] ${SIDE[point.side]}`}>
                          {point.label}
                        </span>
                      </span>
                    )),
                  )}
                </div>
              </div>
            </div>
            <figcaption className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-stone-200 px-4 py-2.5 text-xs text-muted">
              <span>The dots show roughly where we cover, not exact boundaries.</span>
              <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" className="rounded underline underline-offset-2 hover:text-ink focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300">
                Map © OpenStreetMap contributors
              </a>
            </figcaption>
          </figure>

          <ol aria-label="The areas on the map" className="grid content-start gap-1 rounded-2xl bg-canvas p-3 ring-1 ring-stone-200 sm:grid-cols-2 lg:grid-cols-1">
            {areas.map(({ area }) => (
              <li key={area.slug} className="flex items-start gap-3 rounded-xl px-2.5 py-2">
                <span aria-hidden="true" className="mt-1.5 size-3 shrink-0 rounded-full bg-pin ring-2 ring-white shadow-[0_1px_2px_rgba(15,36,56,0.4)]" />
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
