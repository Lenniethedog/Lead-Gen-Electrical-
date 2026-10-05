/** The small label above a section heading. */
export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="text-sm font-semibold uppercase tracking-[0.14em] text-brand-800">{children}</p>;
}
