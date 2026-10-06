"use client";

import { useState } from "react";
import { TileGroup } from "@/components/ui/TileGroup";
import { isValidScope, SERVICES } from "@/config/verticals/electrical";
import { StepShell } from "../StepShell";
import type { StepProps } from "./types";

export function ScopeStep({ values, fieldErrors, headingRef, onPatch, onChooseAndAdvance, onContinue, onBack }: StepProps) {
  const [error, setError] = useState<string>();
  const service = values.service;
  if (service === null) return null; // unreachable: the form never shows this step without a service

  return (
    <StepShell
      headingId="step-heading"
      headingRef={headingRef}
      title="Which best describes the work?"
      intro={`${SERVICES[service].label}. Choose an option to continue.`}
      onBack={onBack}
      onContinue={() => {
        if (values.scope === null || !isValidScope(service, values.scope)) return setError("Choose the option that fits best");
        onContinue();
      }}
    >
      <TileGroup
        name="scope"
        labelledBy="step-heading"
        options={SERVICES[service].scopes}
        value={values.scope}
        onChange={(scope) => {
          setError(undefined);
          onPatch({ scope });
        }}
        onPointerChoose={(scope) => onChooseAndAdvance({ scope })}
        error={error ?? fieldErrors.scope}
        errorId="scope-error"
      />
    </StepShell>
  );
}
