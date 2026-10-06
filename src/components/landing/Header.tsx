import { BoltMark } from "./icons";

export function Header({ brandName }: { brandName: string }) {
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-navy-900/95 text-white backdrop-blur supports-[backdrop-filter]:bg-navy-900/85">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <a href="#top" className="flex items-center gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300">
          <span className="grid size-9 place-items-center rounded-lg bg-brand-700 text-white shadow-sm">
            <BoltMark className="size-5" />
          </span>
          <span className="whitespace-nowrap font-display text-xl font-semibold tracking-tight">{brandName}</span>
        </a>
        <nav aria-label="Page sections" className="hidden items-center gap-7 text-sm font-medium text-navy-100 md:flex">
          <a href="#how" className="rounded hover:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300">How it works</a>
          <a href="#coverage" className="rounded hover:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300">Areas we cover</a>
          <a href="#faq" className="rounded hover:text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300">Questions</a>
        </nav>
        <p className="hidden whitespace-nowrap text-sm font-semibold text-brand-300 sm:block md:rounded-full md:bg-white/10 md:px-3 md:py-1.5 md:text-navy-100">Free quotes · No obligation</p>
      </div>
    </header>
  );
}
