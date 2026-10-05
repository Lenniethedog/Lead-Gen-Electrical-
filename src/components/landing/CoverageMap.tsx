import { COVERAGE_MAP_AREAS, projectAreas } from "@/config/coverage-map";

/**
 * A schematic of the towns we cover. Drawn here from the same area list as the postcode check, with no map tiles, scripts or
 * third-party requests (a tile server would receive every visitor's IP address). It is deliberately not a boundary map:
 * the postcode checker is the authority on whether an address is covered, and the text list below is the accessible version.
 */
export function CoverageMap({ launchRegion }: { launchRegion: string }) {
  const { width, height, points } = projectAreas(COVERAGE_MAP_AREAS);
  return (
    <section aria-labelledby="coverage-heading" className="bg-brand-50 py-14">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 sm:px-6 lg:grid-cols-[1fr_24rem] lg:items-center">
        <figure className="rounded-2xl bg-white p-3 ring-1 ring-stone-200 sm:p-5">
          <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="coverage-map-title" className="h-auto w-full">
            <title id="coverage-map-title">Schematic map of the towns we cover, from Bromley in the west to Gravesend in the east</title>
            <rect x="0" y="0" width={width} height={height} rx="16" className="fill-stone-50" />
            {points.map(({ area, x, y }) => (
              <g key={area.slug}>
                <circle cx={x} cy={y} r="46" className="fill-brand-100 stroke-brand-700" strokeWidth="2" />
                <circle cx={x} cy={y} r="5" className="fill-brand-700" />
                <text x={x} y={y + 66} textAnchor="middle" className="fill-ink text-[17px] font-bold">
                  {area.name}
                </text>
              </g>
            ))}
            <text x={width - 14} y={height - 12} textAnchor="end" className="fill-muted text-[12px]">
              Schematic, not to scale
            </text>
          </svg>
        </figure>

        <div>
          <h2 id="coverage-heading" className="text-3xl font-extrabold tracking-tight">
            Where we cover
          </h2>
          <p className="mt-3 text-muted">
            We currently serve {launchRegion}. Enter your postcode in the form to check your address.
          </p>
          <ul className="mt-5 space-y-2">
            {COVERAGE_MAP_AREAS.map((area) => (
              <li key={area.slug} className="flex flex-wrap gap-x-2">
                <span className="font-bold">{area.name}</span>
                <span className="text-muted">{area.districts.join(", ")}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
