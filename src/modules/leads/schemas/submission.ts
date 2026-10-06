import * as z from "zod";
import { isValidScope } from "@/config/verticals/electrical";
import { ValidationError, type FieldErrors } from "@/lib/errors";
import { attributionSchema } from "@/modules/attribution";
import { contactSchema } from "./contact";
import {
  ownershipSchema,
  postcodeSchema,
  propertyTypeSchema,
  scopeSchema,
  serviceSchema,
  urgencySchema,
} from "./steps";

/**
 * The wire format of POST /api/v1/leads, and the server's authoritative validation of it.
 * Re-validates every field the browser already checked: client validation is a convenience,
 * this is the gate.
 */

export const contextSchema = z.object({
  /** Milliseconds since the form first rendered. Client-reported: a weak fraud signal only. */
  elapsedMs: z.number().int().min(0).max(86_400_000),
  turnstileToken: z.string().max(2048).optional(),
  /** Honeypot field. Humans never see it; bots fill it. */
  honeypot: z.string().max(500).optional(),
  pagePath: z.string().max(300).optional(),
  attribution: attributionSchema,
});

export const leadSubmissionSchema = z
  .object({
    service: serviceSchema,
    postcode: postcodeSchema,
    propertyType: propertyTypeSchema,
    ownership: ownershipSchema,
    scope: scopeSchema,
    urgency: urgencySchema,
    contact: contactSchema,
    consent: z.object({
      accepted: z.literal(true, { error: "You need to agree before we can pass on your details" }),
      textVersion: z.string().regex(/^v[0-9]+$/, "Unknown consent version"),
    }),
    context: contextSchema,
  })
  .superRefine((value, ctx) => {
    if (!isValidScope(value.service, value.scope)) {
      ctx.addIssue({ code: "custom", path: ["scope"], message: "Choose the option that fits best" });
    }
  });

export type LeadSubmission = z.output<typeof leadSubmissionSchema>;

/** Validates untrusted JSON; throws a ValidationError carrying one message per offending field. */
export function parseLeadSubmission(input: unknown): LeadSubmission {
  const result = leadSubmissionSchema.safeParse(input);
  if (result.success) return result.data;

  const fields: FieldErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join(".") || "_root";
    fields[key] ??= issue.message;
  }
  throw new ValidationError(fields);
}
