import type { InputHTMLAttributes, Ref } from "react";
import { FieldError } from "./TileGroup";

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "className"> {
  id: string;
  label: string;
  hint?: string;
  error?: string | undefined;
  inputRef?: Ref<HTMLInputElement>;
}

/** Labelled input with hint and error wired up through aria-describedby (never placeholder-as-label). */
export function TextField({ id, label, hint, error, inputRef, ...input }: TextFieldProps) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <label htmlFor={id} className="block text-base font-semibold text-ink">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="mt-0.5 text-sm text-muted">
          {hint}
        </p>
      ) : null}
      <input
        id={id}
        ref={inputRef}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        // 18px text: anything under 16px makes iOS Safari zoom the page on focus.
        className="mt-2 block min-h-12 w-full rounded-lg border-2 border-stone-400 bg-white px-4 py-2.5 text-lg text-ink placeholder:text-stone-500 focus:border-brand-700 focus:outline-none focus:ring-4 focus:ring-brand-300 aria-[invalid=true]:border-error"
        {...input}
      />
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}
