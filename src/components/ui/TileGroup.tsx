"use client";

export interface TileOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

interface TileGroupProps<T extends string> {
  name: string;
  /** id of the element that names this group (the step heading or a visible group label). */
  labelledBy: string;
  options: readonly TileOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  /** Called only for mouse/touch selections, never for keyboard arrow navigation (see below). */
  onPointerChoose?: (value: T) => void;
  error?: string | undefined;
  errorId?: string;
  columns?: 1 | 2;
}

/**
 * Big, thumb-friendly choice tiles built on NATIVE radio inputs: keyboard (arrows/Tab/Space),
 * screen-reader semantics and form behaviour come from the browser, not from ARIA re-creation.
 *
 * `onPointerChoose` powers auto-advance. A real pointer click has `event.detail >= 1`; a click
 * synthesised by arrow-key navigation has `detail === 0`. Keyboard and screen-reader users
 * therefore never get moved to the next step unexpectedly (WCAG 3.2.2): they press Continue.
 */
export function TileGroup<T extends string>({
  name,
  labelledBy,
  options,
  value,
  onChange,
  onPointerChoose,
  error,
  errorId,
  columns = 1,
}: TileGroupProps<T>) {
  return (
    <div>
      <div
        role="radiogroup"
        aria-labelledby={labelledBy}
        aria-describedby={error && errorId ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        className={`grid gap-2.5 ${columns === 2 ? "sm:grid-cols-2" : ""}`}
      >
        {options.map((option) => (
          <label key={option.value} className="block cursor-pointer">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              onClick={(event) => {
                if (event.detail > 0) onPointerChoose?.(option.value);
              }}
              className="peer sr-only"
            />
            <span className="flex min-h-14 items-center justify-between gap-3 rounded-xl border-2 border-stone-300 bg-white px-4 py-3 transition-colors hover:border-stone-500 peer-checked:border-brand-700 peer-checked:bg-brand-50 peer-focus-visible:ring-4 peer-focus-visible:ring-brand-300 motion-reduce:transition-none">
              <span>
                <span className="block text-base font-semibold text-ink">{option.label}</span>
                {option.hint ? <span className="mt-0.5 block text-sm text-muted">{option.hint}</span> : null}
              </span>
              <span
                aria-hidden="true"
                className={`grid size-6 shrink-0 place-items-center rounded-full border-2 ${
                  value === option.value ? "border-brand-700 bg-brand-700 text-white" : "border-stone-400"
                }`}
              >
                {value === option.value ? (
                  <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
              </span>
            </span>
          </label>
        ))}
      </div>
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}

export function FieldError({ id, children }: { id?: string | undefined; children: React.ReactNode }) {
  return (
    <p id={id} className="mt-2 text-sm font-semibold text-error">
      <span className="sr-only">Error: </span>
      {children}
    </p>
  );
}
