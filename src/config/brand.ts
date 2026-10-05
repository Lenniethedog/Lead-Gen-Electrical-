import { getSiteEnv, type AppEnvironment } from "@/lib/env";

export interface Brand {
  /** Trading name shown to consumers and named in the consent text. */
  name: string;
  /** Registered company name and details: required for the footer and the privacy notice. */
  legalName: string;
  companyNumber: string;
  registeredAddress: string;
  icoRegistration: string;
  privacyEmail: string;
  launchRegion: string;
  /** True once the legal texts have been signed off (LEGAL_TEXT_REVIEWED=true). */
  legalReviewed: boolean;
  appUrl: string;
  appEnv: AppEnvironment;
}

/** Resolved from validated environment variables. Production refuses placeholder values. */
export function getBrand(): Brand {
  const env = getSiteEnv();
  return {
    name: env.BRAND_NAME,
    legalName: env.BRAND_LEGAL_NAME,
    companyNumber: env.BRAND_COMPANY_NUMBER,
    registeredAddress: env.BRAND_REGISTERED_ADDRESS,
    icoRegistration: env.BRAND_ICO_REGISTRATION,
    privacyEmail: env.BRAND_PRIVACY_EMAIL,
    launchRegion: env.BRAND_LAUNCH_REGION,
    legalReviewed: env.LEGAL_TEXT_REVIEWED,
    appUrl: env.APP_URL,
    appEnv: env.APP_ENV,
  };
}
