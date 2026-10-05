import * as z from "zod";
import { parseUkPhone, type ParsedPhone } from "../phone";

/**
 * Validation for the contact step. This module pulls in the phone metadata (large), so only the
 * contact step chunk and the server import it.
 */

const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}'’ .-]*$/u;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export const nameSchema = z
  .string({ error: "Enter your name" })
  .trim()
  .min(2, "Enter your name")
  .max(80, "That name is too long")
  .regex(NAME_PATTERN, "Use letters only in your name")
  .transform((value) => value.replace(/\s+/g, " "));

export const phoneSchema = z
  .string({ error: "Enter your phone number" })
  .transform((value, ctx): ParsedPhone => {
    const result = parseUkPhone(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: result.message });
      return z.NEVER;
    }
    return result.value;
  });

export const emailSchema = z
  .string({ error: "Enter your email address" })
  .trim()
  .min(1, "Enter your email address")
  .max(254, "That email address is too long")
  .pipe(z.email({ error: "Enter a valid email address, like name@example.com" }));

export const notesSchema = z
  .string()
  .max(1500, "Please keep this under 1,000 characters")
  .transform((value) => value.replace(CONTROL_CHARACTERS, "").trim())
  .pipe(z.string().max(1000, "Please keep this under 1,000 characters"))
  .transform((value) => (value === "" ? undefined : value))
  .optional();

export const contactSchema = z.object({
  name: nameSchema,
  phone: phoneSchema,
  email: emailSchema,
  notes: notesSchema,
});

export type ContactInput = z.input<typeof contactSchema>;
export type ContactOutput = z.output<typeof contactSchema>;
