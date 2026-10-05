"use client";

import { useEffect, useRef, useState } from "react";
import { TextField } from "@/components/ui/TextField";
import { normalisePostcode } from "@/modules/postcodes/normalise";
import { postcodeStepSchema } from "@/modules/leads/schemas/steps";
import { checkPostcode, type CoverageResponse } from "../api";
import { StepShell } from "../StepShell";
import type { StepProps } from "./types";

type CheckResult = { postcode: string; outcome: "out_of_area" | "not_found" | "unreachable" };

export function PostcodeStep({
  values,
  fieldErrors,
  headingRef,
  onPatch,
  onContinue,
  onBack,
  launchRegion,
}: StepProps & { launchRegion: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [formatError, setFormatError] = useState<string>();
  const [result, setResult] = useState<CheckResult | null>(null);
  const normalised = normalisePostcode(values.postcode);

  // Everything shown is DERIVED from the current input plus the latest completed check, so a slow
  // response for an older postcode can never describe the one now in the box.
  const confirmed = normalised !== null && values.coverage?.postcode === normalised ? values.coverage : null;
  const settled = normalised !== null && result?.postcode === normalised ? result.outcome : null;
  const checking = normalised !== null && confirmed === null && settled === null;

  useEffect(() => {
    if (normalised === null || confirmed !== null || settled !== null) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response: CoverageResponse = await checkPostcode(normalised, controller.signal);
        if (controller.signal.aborted) return;
        if (response.status === "covered") {
          onPatch({ coverage: { postcode: response.postcode, areaName: response.areaName } });
        } else {
          setResult({ postcode: normalised, outcome: response.status === "not_found" ? "not_found" : "out_of_area" });
        }
      } catch {
        // Offline or the check endpoint is down: do not trap the visitor. The server re-checks on submit.
        if (!controller.signal.aborted) setResult({ postcode: normalised, outcome: "unreachable" });
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [normalised, confirmed, settled, onPatch]);

  let message: { tone: "ok" | "error" | "info"; text: string } | null = null;
  if (confirmed) message = { tone: "ok", text: `Good news: we cover ${confirmed.areaName} (${confirmed.postcode}).` };
  else if (settled === "out_of_area") {
    message = { tone: "error", text: `Sorry, we don't cover ${normalised} yet. We currently cover ${launchRegion}.` };
  } else if (settled === "not_found") {
    message = { tone: "error", text: "We couldn't find that postcode. Check it and try again." };
  } else if (settled === "unreachable") {
    message = { tone: "info", text: "We couldn't check coverage just now. You can carry on and we'll check when you send your enquiry." };
  } else if (checking) message = { tone: "info", text: "Checking your postcode…" };

  const fieldError = formatError ?? fieldErrors.postcode ?? (message?.tone === "error" ? message.text : undefined);

  return (
    <StepShell
      headingId="step-heading"
      headingRef={headingRef}
      title="Where is the work needed?"
      intro="We only pass your details to roofers who cover this postcode."
      busy={checking}
      busyLabel="Checking…"
      onBack={onBack}
      onContinue={() => {
        const parsed = postcodeStepSchema.safeParse({ postcode: values.postcode });
        if (!parsed.success) {
          setFormatError(parsed.error.issues[0]?.message);
          inputRef.current?.focus();
          return;
        }
        if (settled === "out_of_area" || settled === "not_found") {
          inputRef.current?.focus();
          return;
        }
        onContinue();
      }}
    >
      <TextField
        id="postcode"
        label="Property postcode"
        inputRef={inputRef}
        value={values.postcode}
        error={fieldError}
        autoComplete="postal-code"
        autoCapitalize="characters"
        spellCheck={false}
        enterKeyHint="next"
        maxLength={10}
        placeholder="e.g. BR6 0AA"
        onChange={(event) => {
          setFormatError(undefined);
          onPatch({ postcode: event.target.value });
        }}
        onBlur={() => {
          if (normalised !== null && normalised !== values.postcode) onPatch({ postcode: normalised });
        }}
      />
      {/* Polite live region: announces "checking" / "we cover X" without stealing focus. */}
      <p
        aria-live="polite"
        className={`mt-2 min-h-6 text-sm font-medium ${message?.tone === "ok" ? "text-success" : message?.tone === "error" ? "sr-only" : "text-muted"}`}
      >
        {message?.text}
      </p>
    </StepShell>
  );
}
