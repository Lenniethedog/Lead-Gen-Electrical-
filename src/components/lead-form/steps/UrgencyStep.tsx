"use client";

import { useState } from "react";
import { TileGroup, type TileOption } from "@/components/ui/TileGroup";
import { URGENCIES, URGENCY_VALUES, type Urgency } from "@/config/lead-options";
import { SafetyNote } from "../SafetyNote";
import { StepShell } from "../StepShell";
import type { StepProps } from "./types";

const OPTIONS: readonly TileOption<Urgency>[] = URGENCY_VALUES.map((value) => ({
  value,
  label: URGENCIES[value].label,
  ...("hint" in URGENCIES[value] && { hint: URGENCIES[value].hint }),
}));

export function UrgencyStep({ values, fieldErrors, headingRef, onPatch, onChooseAndAdvance, onContinue, onBack }: StepProps) {
  const [error, setError] = useState<string>();

  return (
    <StepShell
      headingId="step-heading"
      headingRef={headingRef}
      title="When would you like the work done?"
      intro="Choose an option to continue."
      onBack={onBack}
      onContinue={() => {
        if (values.urgency === null) return setError("Choose when you need the work done");
        onContinue();
      }}
    >
      <SafetyNote className="mb-4" />
      <TileGroup
        name="urgency"
        labelledBy="step-heading"
        options={OPTIONS}
        value={values.urgency}
        onChange={(urgency) => {
          setError(undefined);
          onPatch({ urgency });
        }}
        onPointerChoose={(urgency) => onChooseAndAdvance({ urgency })}
        error={error ?? fieldErrors.urgency}
        errorId="urgency-error"
      />
    </StepShell>
  );
}
