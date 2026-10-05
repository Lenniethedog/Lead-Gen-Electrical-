/** Shared class strings for the admin screens, so every control looks and behaves the same. */
export const inputClass =
  "min-h-12 w-full rounded-lg border-2 border-stone-400 bg-white px-3 text-lg text-ink focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300 aria-[invalid=true]:border-error";
export const labelClass = "block font-semibold text-ink";
export const hintClass = "text-sm text-muted";
export const errorTextClass = "text-sm font-semibold text-error";
export const cardClass = "rounded-lg border border-stone-200 bg-white p-4 sm:p-6";
const buttonBase =
  "inline-flex min-h-12 items-center justify-center rounded-lg px-6 py-3 text-lg font-semibold focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300 disabled:cursor-not-allowed disabled:opacity-60";
export const primaryButton = `${buttonBase} bg-brand-700 text-white hover:bg-brand-800`;
export const secondaryButton = `${buttonBase} border-2 border-stone-400 bg-white text-ink hover:border-stone-600`;
export const dangerButton = `${buttonBase} border-2 border-red-700 bg-white text-red-800 hover:bg-red-50`;
export const linkClass = "font-semibold text-brand-800 underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300";
