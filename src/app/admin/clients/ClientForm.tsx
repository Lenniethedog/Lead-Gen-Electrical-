"use client";

import { useActionState } from "react";
import type { FormState } from "@/modules/clients";
import { errorTextClass, hintClass, inputClass, labelClass, primaryButton } from "../_components/styles";

interface Props {
  /** A server action taking (previous state, form data). On success it redirects; on failure it returns the errors and the typed values. */
  action: (state: FormState, form: FormData) => Promise<FormState>;
  initial?: Record<string, string> | undefined;
  submitLabel: string;
}

function Field({ name, label, hint, error, children }: { name: string; label: string; hint?: string; error?: string | undefined; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={name} className={labelClass}>
        {label}
      </label>
      {hint && <p id={`${name}-hint`} className={hintClass}>{hint}</p>}
      {children}
      {error && (
        <p id={`${name}-error`} className={errorTextClass}>
          {error}
        </p>
      )}
    </div>
  );
}

export function ClientForm({ action, initial, submitLabel }: Props) {
  const [state, formAction, pending] = useActionState(action, {} as FormState);
  const values = state.values ?? initial ?? {};
  const errors = state.errors ?? {};
  const describedBy = (name: string, hint?: boolean) => [hint ? `${name}-hint` : "", errors[name] ? `${name}-error` : ""].filter(Boolean).join(" ") || undefined;
  const text = (name: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input id={name} name={name} defaultValue={values[name] ?? ""} aria-invalid={errors[name] ? true : undefined} aria-describedby={describedBy(name, Boolean(extra["aria-describedby"]))} className={inputClass} {...extra} />
  );
  const ticked = (name: string, fallback: boolean) => (values[name] === undefined ? fallback : values[name] === "on");

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {state.message && (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-900">
          {state.message}
        </p>
      )}
      {Object.keys(errors).length > 0 && (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-900">
          Please fix the highlighted fields.
        </p>
      )}
      <Field name="name" label="Business name" error={errors.name}>
        {text("name", { required: true, autoComplete: "off" })}
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field name="legalName" label="Registered company name" hint="Optional" error={errors.legalName}>
          {text("legalName")}
        </Field>
        <Field name="companyNumber" label="Company number" hint="Optional" error={errors.companyNumber}>
          {text("companyNumber")}
        </Field>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field name="contactName" label="Who to send leads to" hint="Used in the greeting of the message you send them" error={errors.contactName}>
          {text("contactName", { "aria-describedby": "contactName-hint" })}
        </Field>
        <Field name="contactPhone" label="Their phone (for WhatsApp)" hint="A UK number, e.g. 07911 123456" error={errors.contactPhone}>
          {text("contactPhone", { type: "tel", inputMode: "tel", autoComplete: "off", "aria-describedby": "contactPhone-hint" })}
        </Field>
      </div>
      <Field name="contactEmail" label="Their email" error={errors.contactEmail}>
        {text("contactEmail", { type: "email", required: true, autoComplete: "off" })}
      </Field>
      <fieldset className="space-y-2">
        <legend className={labelClass}>Which leads do they accept?</legend>
        <label className="flex min-h-12 items-center gap-3 text-lg">
          <input type="checkbox" name="acceptsExclusive" defaultChecked={ticked("acceptsExclusive", true)} className="size-6" />
          Exclusive: the lead goes to them only
        </label>
        <label className="flex min-h-12 items-center gap-3 text-lg">
          <input type="checkbox" name="acceptsShared" defaultChecked={ticked("acceptsShared", false)} className="size-6" />
          Shared: the lead may go to several businesses
        </label>
        {errors.acceptsExclusive && <p className={errorTextClass}>{errors.acceptsExclusive}</p>}
      </fieldset>
      <Field name="notes" label="Internal notes" hint="Optional. About the business only: never a consumer's details." error={errors.notes}>
        <textarea id="notes" name="notes" rows={3} defaultValue={values.notes ?? ""} aria-describedby={describedBy("notes", true)} aria-invalid={errors.notes ? true : undefined} className={`${inputClass} py-2`} />
      </Field>
      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}
