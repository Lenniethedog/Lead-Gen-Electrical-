import { ApiError } from "./api";
import { routeServerErrors, type FieldErrors } from "./state";

export interface Failure {
  formError: string | null;
  fieldErrors: FieldErrors;
  goToStep: number | null;
  /** The Turnstile token is single-use: after any failure the widget must produce a fresh one. */
  resetChallenge: boolean;
  /** A stale page (consent wording changed under the visitor): offer a reload, answers are saved. */
  needsReload: boolean;
}

const withReference = (message: string, requestId: string | undefined) =>
  requestId ? `${message} If it keeps happening, quote reference ${requestId}.` : message;

/** Turns whatever went wrong into something a worried homeowner can act on. */
export function describeFailure(error: unknown): Failure {
  const base: Failure = { formError: null, fieldErrors: {}, goToStep: null, resetChallenge: true, needsReload: false };

  if (!(error instanceof ApiError)) {
    return { ...base, formError: "Something went wrong. Please try again." };
  }

  switch (error.code) {
    case "validation_failed":
    case "out_of_area":
    case "postcode_not_found": {
      const { fieldErrors, goToStep } = routeServerErrors(error.fields ?? {});
      const hasFields = Object.keys(fieldErrors).length > 0;
      return {
        ...base,
        fieldErrors,
        goToStep,
        formError: hasFields ? null : "Some of your details need attention. Please check them and try again.",
      };
    }
    case "challenge_failed":
      return { ...base, formError: "We couldn't verify you're human. Please try again." };
    case "consent_outdated":
      return {
        ...base,
        needsReload: true,
        formError: "We've just updated our wording. Please reload the page: your answers are saved.",
      };
    case "rate_limited":
      return { ...base, formError: "You've tried a few times in a row. Please wait a minute and try again." };
    case "network_error":
      return {
        ...base,
        formError: "We couldn't reach our servers. Your answers are saved: check your connection and try again.",
      };
    default:
      return {
        ...base,
        formError: withReference(
          error.status >= 500 ? "Something went wrong on our side. Please try again in a moment." : "We couldn't send your enquiry. Please try again.",
          error.requestId,
        ),
      };
  }
}
