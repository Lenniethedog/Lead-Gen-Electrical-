"use client";

import { useState } from "react";
import { TileGroup, type TileOption } from "@/components/ui/TileGroup";
import { SERVICE_SLUGS, SERVICES, type ServiceSlug } from "@/config/verticals/electrical";
import { StepShell } from "../StepShell";
import type { StepProps } from "./types";

const OPTIONS: readonly TileOption<ServiceSlug>[] = SERVICE_SLUGS.map((slug) => ({
  value: slug,
  label: SERVICES[slug].label,
  hint: SERVICES[slug].hint,
}));

export function ServiceStep({ values, fieldErrors, headingRef, onPatch, onChooseAndAdvance, onContinue }: StepProps) {
  const [error, setError] = useState<string>();
  const shown = error ?? fieldErrors.service;

  return (
    <StepShell
      headingId="step-heading"
      headingRef={headingRef}
      title="What electrical work do you need?"
      intro="Choose an option to continue."
      onContinue={() => {
        if (values.service === null) return setError("Choose the work you need");
        onContinue();
      }}
    >
      <TileGroup
        name="service"
        labelledBy="step-heading"
        options={OPTIONS}
        value={values.service}
        onChange={(service) => {
          setError(undefined);
          onPatch({ service });
        }}
        onPointerChoose={(service) => onChooseAndAdvance({ service })}
        error={shown}
        errorId="service-error"
      />
    </StepShell>
  );
}
