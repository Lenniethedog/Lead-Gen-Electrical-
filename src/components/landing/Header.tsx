export function Header({ brandName }: { brandName: string }) {
  return (
    <header className="border-b border-stone-200 bg-white">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <a href="#top" className="flex items-center gap-2 text-xl font-extrabold tracking-tight text-ink">
          <svg aria-hidden="true" viewBox="0 0 32 32" className="size-8 text-brand-700" fill="currentColor">
            <path d="M16 3 2 15h4v13h8v-8h4v8h8V15h4L16 3z" />
          </svg>
          {brandName}
        </a>
        <p className="hidden text-sm font-semibold text-muted sm:block">Free quotes · No obligation</p>
      </div>
    </header>
  );
}
