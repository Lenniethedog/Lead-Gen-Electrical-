import type { ServiceSlug } from "@/config/verticals/electrical";

/** Small stroke icons (24px grid), drawn for this site: no icon library, no request. Decorative: the text next to each one carries the meaning. */
const base = { "aria-hidden": true, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round" } as const;

const PATHS: Record<ServiceSlug, React.ReactNode> = {
  // a lightning bolt
  fault_repair: (<><path d="M13 2.5 5 13.5h6.5l-1 8 8.5-11.5h-6.5l.5-7.5Z" /></>),
  // a fuse box with a row of switches
  consumer_unit: (<><rect x="4.5" y="3" width="15" height="18" rx="2" /><path d="M8.5 7.5h2.5M13 7.5h2.5M8.5 12h2.5M13 12h2.5M8.5 16.5h2.5M13 16.5h2.5" /></>),
  // a cable running between two points
  rewire: (<><path d="M3 7.5h5a3.5 3.5 0 0 1 3.5 3.5v2a3.5 3.5 0 0 0 3.5 3.5h6" /><circle cx="3.5" cy="7.5" r="1" /><circle cx="20.5" cy="16.5" r="1" /></>),
  // a clipboard with a tick
  eicr: (<><path d="M9 4h6v3H9z" /><path d="M7.5 5.5H5.5v15h13v-15h-2" /><path d="m9 14 2 2 4-4.5" /></>),
  // a plug
  ev_charger: (<><path d="M9 3v5M15 3v5" /><path d="M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0V8Z" /><path d="M12 17v4" /></>),
  // a light bulb
  lighting_sockets: (<><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z" /><path d="M9.5 18.5h5M10.5 21h3" /></>),
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

export function BoltMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 32 32" className={className} fill="currentColor">
      <path d="M19.5 2 6 18.2a.8.8 0 0 0 .6 1.3H13l-1.7 10.2a.5.5 0 0 0 .9.4L26 13.8a.8.8 0 0 0-.6-1.3H19l1.2-9.7A.5.5 0 0 0 19.5 2Z" />
    </svg>
  );
}
