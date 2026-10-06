/**
 * Electrical emergencies are not sales leads. Someone with a fire, sparks, a burning smell or a person hurt by a shock must
 * ring the emergency services at once, not fill in a form and wait for a quote, so the site says so before the form, on the
 * "when" question and in the FAQ (docs/00 E3).
 *
 * Checked 2026-10-06: 999 for a fire or an injury; 105 is the free, 24-hour number for a power cut or a damaged or fallen
 * overhead line in Great Britain (it reaches the local network operator, UK Power Networks in south-east London). Northern
 * Ireland differs (NIE Networks, 03457 643 643): re-check this before the footprint ever leaves Great Britain.
 *
 * The advice is deliberately short and conservative: ring first, switch off only if it is safe to, never touch damaged wiring
 * or anything wet near it. It is not a repair guide.
 */
export const ELECTRICAL_EMERGENCY = {
  headline: "Sparks, a burning smell or an electric shock?",
  body: "Don't wait for a quote. If there's a fire or someone is hurt, call 999. If it's safe to, switch the power off at the consumer unit (fuse box), and keep away from damaged wiring and anything wet near it.",
  phone: { display: "999", tel: "999" },
  powerCut: {
    label: "Power cut or a fallen cable?",
    body: "Call 105. It's free, 24 hours a day, and it reaches your local network operator. Keep well away from a fallen cable.",
    display: "105",
    tel: "105",
  },
} as const;
