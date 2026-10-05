import type { ServiceSlug } from "@/config/verticals/roofing";

/** Small stroke icons (24px grid), drawn for this site: no icon library, no request. Decorative: the text next to each one carries the meaning. */
const base = { "aria-hidden": true, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const PATHS: Record<ServiceSlug, React.ReactNode> = {
  // a roof with a drip
  roof_repair: (<><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10v9.5h13V10" /><path d="M12 12.5c-1.4 1.8-2 2.8-2 3.6a2 2 0 0 0 4 0c0-.8-.6-1.8-2-3.6Z" /></>),
  new_roof: (<><path d="M2.5 12.5 12 4l9.5 8.5" /><path d="M6 13l6-5.3 6 5.3" /><path d="M5 12.5V20h14v-7.5" /></>),
  flat_roof: (<><path d="M3 9h18" /><path d="M5 9v10.5h14V9" /><path d="M3 9l2-3h14l2 3" /></>),
  chimney: (<><path d="M3 20h18" /><path d="M6 20v-7l6-5 6 5v7" /><path d="M14.5 9.2V4.5h3v7.2" /><path d="M10 20v-4.5h4V20" /></>),
  guttering_fascias: (<><path d="M3 7h18v3.5H3z" /><path d="M5 10.5v2" /><path d="M19 10.5V19" /><path d="M16.5 19h5" /></>),
  roof_inspection: (<><path d="M3 12 10 6l7 6" /><path d="M5.5 11v7h6" /><circle cx="16.5" cy="16.5" r="3.5" /><path d="m19.2 19.2 2.3 2.3" /></>),
  other: (<><circle cx="12" cy="12" r="8.5" /><path d="M12 8v4.5" /><path d="M12 15.8v.1" /></>),
};

export function ServiceIcon({ slug, className }: { slug: ServiceSlug; className?: string }) {
  return <svg {...base} className={className}>{PATHS[slug]}</svg>;
}

export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg {...base} strokeWidth={2.4} className={className}>
      <path d="M4.5 12.5l4.5 4.5 10.5-11" />
    </svg>
  );
}

export function RoofMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 32 32" className={className} fill="currentColor">
      <path d="M16 3.2 2.2 14.6a1 1 0 0 0 .64 1.77H6V28h7.2v-7.4h5.6V28H26V16.37h3.16a1 1 0 0 0 .64-1.77L16 3.2Z" />
    </svg>
  );
}
