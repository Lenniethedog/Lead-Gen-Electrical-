"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { FieldError } from "@/components/ui/TileGroup";
import type { ConsentSegment } from "@/config/consent";
import { contactSchema } from "@/modules/leads/schemas/contact";
import { Turnstile, type TurnstileState } from "../Turnstile";
import type { StepProps } from "./types";

type ContactField = "name" | "phone" | "email" | "notes" | "consent";

export interface ContactSubmission {
  turnstileToken: string | undefined;
  honeypot: string;
}

interface ContactStepProps extends Omit<StepProps, "onContinue" | "onChooseAndAdvance"> {
  turnstileSiteKey: string;
  /** Bumped by the form after a failed submit so the (single-use) challenge is solved afresh. */
  challengeEpoch: number;
  consentSegments: readonly ConsentSegment[];
  submitting: boolean;
  formError: string | null;
  needsReload: boolean;
  onSubmit: (submission: ContactSubmission) => void;
}

const FIELD_ORDER: ContactField[] = ["name", "phone", "email", "notes", "consent"];
const FIELD_IDS: Record<ContactField, string> = {
  name: "contact-name",
  phone: "contact-phone",
  email: "contact-email",
  notes: "contact-notes",
  consent: "contact-consent",
};

export function ContactStep({
  values,
  fieldErrors,
  headingRef,
  onPatch,
  onBack,
  turnstileSiteKey,
  challengeEpoch,
  consentSegments,
  submitting,
  formError,
  needsReload,
  onSubmit,
}: ContactStepProps) {
  const [consent, setConsent] = useState(false);
  const [honeypot, setHoneypot] = useState("");
  const [touched, setTouched] = useState<ReadonlySet<ContactField>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const [showNotes, setShowNotes] = useState(values.notes !== "");
  const [challenge, setChallenge] = useState<{ epoch: number; state: TurnstileState }>({ epoch: challengeEpoch, state: { token: null } });
  const summaryRef = useRef<HTMLDivElement>(null);

  // The challenge result only counts for the widget generation that produced it.
  const challengeState: TurnstileState = challenge.epoch === challengeEpoch ? challenge.state : { token: null };
  const token = "token" in challengeState ? challengeState.token : null;
  const challengeFailed = "failed" in challengeState;
  const challengePending = token === null && !challengeFailed;

  // Validation is computed from current values on every render (cheap), and only SHOWN for fields the
  // user has left or after a submit attempt: no red errors while someone is still typing.
  const parsed = contactSchema.safeParse({ name: values.name, phone: values.phone, email: values.email, notes: values.notes });
  const localErrors: Partial<Record<ContactField, string>> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if ((key === "name" || key === "phone" || key === "email" || key === "notes") && localErrors[key] === undefined) {
        localErrors[key] = issue.message;
      }
    }
  }
  if (!consent) localErrors.consent = "You need to agree before we can pass on your details";

  const visible = (field: ContactField): string | undefined =>
    fieldErrors[field] ?? (attempted || touched.has(field) ? localErrors[field] : undefined);

  const summary = FIELD_ORDER.flatMap((field) => {
    const message = attempted ? (fieldErrors[field] ?? localErrors[field]) : fieldErrors[field];
    return message ? [{ field, message }] : [];
  });

  const touch = (field: ContactField) => setTouched((current) => new Set(current).add(field));

  function handleSubmit() {
    setAttempted(true);
    if (Object.keys(localErrors).length > 0) {
      // Focus the summary so a keyboard/screen-reader user hears what to fix first.
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    onSubmit({ turnstileToken: token ?? undefined, honeypot });
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        handleSubmit();
      }}
    >
      <h2 id="step-heading" ref={headingRef} tabIndex={-1} className="text-2xl font-bold leading-tight text-ink outline-none">
        How can the electrician contact you?
      </h2>
      <p className="mt-1.5 text-base text-muted">Free, with no obligation to accept any quote.</p>

      {summary.length > 0 ? (
        <div ref={summaryRef} tabIndex={-1} role="alert" className="mt-4 rounded-lg border-2 border-error bg-red-50 p-4 outline-none">
          <h3 className="text-base font-bold text-error">There is a problem</h3>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm">
            {summary.map(({ field, message }) => (
              <li key={field}>
                <a href={`#${FIELD_IDS[field]}`} className="font-semibold text-error underline">
                  {message}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-5 space-y-4">
        <TextField
          id={FIELD_IDS.name}
          label="Your name"
          value={values.name}
          error={visible("name")}
          autoComplete="name"
          enterKeyHint="next"
          maxLength={80}
          onChange={(event) => onPatch({ name: event.target.value })}
          onBlur={() => touch("name")}
        />
        <TextField
          id={FIELD_IDS.phone}
          label="Phone number"
          hint="A UK mobile or landline"
          type="tel"
          inputMode="tel"
          value={values.phone}
          error={visible("phone")}
          autoComplete="tel"
          enterKeyHint="next"
          maxLength={25}
          onChange={(event) => onPatch({ phone: event.target.value })}
          onBlur={() => touch("phone")}
        />
        <TextField
          id={FIELD_IDS.email}
          label="Email address"
          type="email"
          inputMode="email"
          value={values.email}
          error={visible("email")}
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          enterKeyHint="next"
          maxLength={254}
          onChange={(event) => onPatch({ email: event.target.value })}
          onBlur={() => touch("email")}
        />

        {showNotes ? (
          <div>
            <label htmlFor={FIELD_IDS.notes} className="block text-base font-semibold text-ink">
              Anything else the electrician should know? <span className="font-normal text-muted">(optional)</span>
            </label>
            <textarea
              id={FIELD_IDS.notes}
              rows={3}
              maxLength={1000}
              value={values.notes}
              aria-invalid={visible("notes") ? true : undefined}
              aria-describedby={visible("notes") ? "contact-notes-error" : undefined}
              onChange={(event) => onPatch({ notes: event.target.value })}
              onBlur={() => touch("notes")}
              className="mt-2 block w-full rounded-lg border-2 border-stone-400 bg-white px-4 py-2.5 text-lg text-ink focus:border-brand-700 focus:outline-none focus:ring-4 focus:ring-brand-300 aria-[invalid=true]:border-error"
            />
            {visible("notes") ? <FieldError id="contact-notes-error">{visible("notes")}</FieldError> : null}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowNotes(true)}
            aria-expanded={false}
            className="text-base font-semibold text-brand-800 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300"
          >
            Add more details (optional)
          </button>
        )}

        {/* Honeypot: invisible and unreachable for people, irresistible to form-filling bots. */}
        <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
          <label>
            Leave this field empty
            <input
              type="text"
              name="company_website"
              tabIndex={-1}
              autoComplete="off"
              value={honeypot}
              onChange={(event) => setHoneypot(event.target.value)}
            />
          </label>
        </div>

        <div>
          <label className="flex cursor-pointer items-start gap-3">
            <input
              id={FIELD_IDS.consent}
              type="checkbox"
              checked={consent}
              aria-invalid={visible("consent") ? true : undefined}
              aria-describedby={visible("consent") ? "contact-consent-error" : undefined}
              onChange={(event) => {
                setConsent(event.target.checked);
                touch("consent");
              }}
              className="mt-1 size-6 shrink-0 cursor-pointer accent-brand-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300"
            />
            <span className="text-sm leading-6 text-ink">
              {consentSegments.map((segment, index) =>
                segment.kind === "privacy_link" ? (
                  <Link
                    key={index}
                    href="/privacy"
                    target="_blank"
                    rel="noopener"
                    className="font-semibold text-brand-800 underline underline-offset-2"
                  >
                    {segment.text}
                  </Link>
                ) : (
                  <span key={index}>{segment.text}</span>
                ),
              )}
            </span>
          </label>
          {visible("consent") ? <FieldError id="contact-consent-error">{visible("consent")}</FieldError> : null}
        </div>

        <Turnstile
          key={challengeEpoch}
          siteKey={turnstileSiteKey}
          onState={(state) => setChallenge({ epoch: challengeEpoch, state })}
        />
      </div>

      {formError ? (
        <div role="alert" className="mt-5 rounded-lg border-2 border-error bg-red-50 p-4 text-sm font-semibold text-error">
          <p>{formError}</p>
          {needsReload ? (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-2 underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300"
            >
              Reload the page
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        {onBack ? (
          <Button variant="secondary" onClick={onBack} disabled={submitting}>
            Back
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" disabled={submitting || challengePending} aria-busy={submitting}>
          {submitting ? "Sending…" : challengePending ? "Preparing secure check…" : "Get my free quote"}
        </Button>
      </div>
    </form>
  );
}
