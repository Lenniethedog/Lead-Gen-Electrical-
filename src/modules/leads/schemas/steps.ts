import * as z from "zod";
import { OWNERSHIP_VALUES, PROPERTY_TYPE_VALUES, URGENCY_VALUES } from "@/config/lead-options";
import { SERVICE_SLUGS, isValidScope, type ServiceSlug } from "@/config/verticals/electrical";
import { normalisePostcode } from "@/modules/postcodes/normalise";

/**
 * Validation for steps 1-5. Imported by the browser (to give instant feedback) and by the server
 * (which re-validates everything and stays authoritative). Deliberately light: nothing heavy is
 * imported here so the landing page's first paint is not slowed by validation code.
 */

export const POSTCODE_EXAMPLE = "BR6 0AA";

export const serviceSchema = z.enum(SERVICE_SLUGS, { error: "Choose the work you need" });
export const propertyTypeSchema = z.enum(PROPERTY_TYPE_VALUES, { error: "Choose the type of property" });
export const ownershipSchema = z.enum(OWNERSHIP_VALUES, { error: "Tell us how you're connected to the property" });
export const urgencySchema = z.enum(URGENCY_VALUES, { error: "Choose when you need the work done" });

export const postcodeSchema = z
  .string({ error: "Enter the property's postcode" })
  .trim()
  .min(1, "Enter the property's postcode")
  .transform((value, ctx) => {
    const postcode = normalisePostcode(value);
    if (postcode === null) {
      ctx.addIssue({ code: "custom", message: `Enter a valid UK postcode, like ${POSTCODE_EXAMPLE}` });
      return z.NEVER;
    }
    return postcode;
  });

export const scopeSchema = z.string({ error: "Choose the option that fits best" }).min(1, "Choose the option that fits best");

export const serviceStepSchema = z.object({ service: serviceSchema });
export const postcodeStepSchema = z.object({ postcode: postcodeSchema });
export const propertyStepSchema = z.object({ propertyType: propertyTypeSchema, ownership: ownershipSchema });
export const urgencyStepSchema = z.object({ urgency: urgencySchema });

/** The scope options depend on the chosen service, so this schema is built per service. */
export function scopeStepSchema(service: ServiceSlug) {
  return z.object({
    scope: scopeSchema.refine((value) => isValidScope(service, value), {
      error: "Choose the option that fits best",
    }),
  });
}
