"use client";

import { useState } from "react";
import { TileGroup, type TileOption } from "@/components/ui/TileGroup";
import {
  OWNERSHIP_VALUES,
  OWNERSHIPS,
  PROPERTY_TYPE_VALUES,
  PROPERTY_TYPES,
  type Ownership,
  type PropertyType,
} from "@/config/lead-options";
import { propertyStepSchema } from "@/modules/leads/schemas/steps";
import { StepShell } from "../StepShell";
import type { StepProps } from "./types";

const PROPERTY_OPTIONS: readonly TileOption<PropertyType>[] = PROPERTY_TYPE_VALUES.map((value) => ({
  value,
  label: PROPERTY_TYPES[value].label,
}));
const OWNERSHIP_OPTIONS: readonly TileOption<Ownership>[] = OWNERSHIP_VALUES.map((value) => ({
  value,
  label: OWNERSHIPS[value].label,
  ...("hint" in OWNERSHIPS[value] && { hint: OWNERSHIPS[value].hint }),
}));

export function PropertyStep({ values, fieldErrors, headingRef, onPatch, onContinue, onBack }: StepProps) {
  const [errors, setErrors] = useState<{ propertyType?: string; ownership?: string }>({});

  return (
    <StepShell
      headingId="step-heading"
      headingRef={headingRef}
      title="Tell us about the property"
      onBack={onBack}
      onContinue={() => {
        const parsed = propertyStepSchema.safeParse({ propertyType: values.propertyType, ownership: values.ownership });
        if (!parsed.success) {
          const next: { propertyType?: string; ownership?: string } = {};
          for (const issue of parsed.error.issues) {
            const key = issue.path[0];
            if (key === "propertyType" || key === "ownership") next[key] ??= issue.message;
          }
          setErrors(next);
          return;
        }
        onContinue();
      }}
    >
      <div className="space-y-6">
        <section>
          <p id="property-type-label" className="mb-2 text-base font-semibold text-ink">
            What type of property is it?
          </p>
          <TileGroup
            name="propertyType"
            labelledBy="property-type-label"
            options={PROPERTY_OPTIONS}
            value={values.propertyType}
            columns={2}
            onChange={(propertyType) => {
              setErrors((current) => ({ ...current, propertyType: undefined }));
              onPatch({ propertyType });
            }}
            error={errors.propertyType ?? fieldErrors.propertyType}
            errorId="property-type-error"
          />
        </section>
        <section>
          <p id="ownership-label" className="mb-2 text-base font-semibold text-ink">
            What is your connection to it?
          </p>
          <TileGroup
            name="ownership"
            labelledBy="ownership-label"
            options={OWNERSHIP_OPTIONS}
            value={values.ownership}
            onChange={(ownership) => {
              setErrors((current) => ({ ...current, ownership: undefined }));
              onPatch({ ownership });
            }}
            error={errors.ownership ?? fieldErrors.ownership}
            errorId="ownership-error"
          />
        </section>
      </div>
    </StepShell>
  );
}
