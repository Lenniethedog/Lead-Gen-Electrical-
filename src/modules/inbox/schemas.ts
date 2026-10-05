import * as z from "zod";

/**
 * Validation of what the inbox forms post. The server re-validates everything: a server action is
 * reachable by a hand-written POST, so form fields are untrusted input like any other.
 */
export const leadIdSchema = z.uuid();

export const decisionSchema = z.object({
  leadId: z.uuid(),
  decision: z.enum(["approve", "reject"]),
  // Checked against the closed reason lists by the service; this only bounds the size.
  reason: z.string().trim().min(1).max(40),
});

export const handledSchema = z.object({ leadId: z.uuid() });

export type DecisionInput = z.infer<typeof decisionSchema>;

/** Plain-object view of FormData with only string values (files and repeated keys are ignored). */
export function formFields(form: FormData): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string" && !(key in fields)) fields[key] = value;
  }
  return fields;
}
