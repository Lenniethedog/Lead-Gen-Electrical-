import type { Ref } from "react";
import type { FieldErrors, FormValues } from "../state";

/** What every step receives from the form: its answers, any server-reported errors, and navigation. */
export interface StepProps {
  values: FormValues;
  fieldErrors: FieldErrors;
  headingRef: Ref<HTMLHeadingElement>;
  onPatch: (patch: Partial<FormValues>) => void;
  /** Patch the answer and, after a short beat so the selection is seen, move to the next step. */
  onChooseAndAdvance: (patch: Partial<FormValues>) => void;
  onContinue: () => void;
  onBack?: (() => void) | undefined;
}
