/**
 * Reads campaign parameters from the landing URL at submission time. Nothing is stored in the
 * browser for this: the parameters live in the address bar for as long as the visitor is on the
 * page (including across reloads), which keeps attribution free of device storage.
 */
export interface WireAttribution {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  gclid?: string;
  fbclid?: string;
  msclkid?: string;
  landingPath?: string;
  referrerHost?: string;
}

const PARAMS = {
  utmSource: "utm_source",
  utmMedium: "utm_medium",
  utmCampaign: "utm_campaign",
  utmTerm: "utm_term",
  utmContent: "utm_content",
  gclid: "gclid",
  fbclid: "fbclid",
  msclkid: "msclkid",
} as const;

export function captureAttribution(
  location: { search: string; pathname: string },
  referrer: string,
): WireAttribution {
  const search = new URLSearchParams(location.search);
  const attribution: WireAttribution = { landingPath: location.pathname };

  for (const [field, param] of Object.entries(PARAMS) as Array<[keyof typeof PARAMS, string]>) {
    const value = search.get(param);
    if (value) attribution[field] = value;
  }

  try {
    if (referrer) attribution.referrerHost = new URL(referrer).hostname;
  } catch {
    // An unparseable referrer is simply not attribution.
  }
  return attribution;
}
