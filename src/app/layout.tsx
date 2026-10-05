import type { Metadata, Viewport } from "next";
import { getBrand } from "@/config/brand";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "./globals.css";

export function generateMetadata(): Metadata {
  const brand = getBrand();
  return {
    metadataBase: new URL(brand.appUrl),
    title: {
      default: `Free roofing quotes in ${brand.launchRegion} | ${brand.name}`,
      template: `%s | ${brand.name}`,
    },
    description: `Tell us about your roofing job and we'll pass your enquiry to a local roofing business covering ${brand.launchRegion}. Free, with no obligation.`,
    applicationName: brand.name,
    alternates: { canonical: "/" },
    openGraph: {
      type: "website",
      siteName: brand.name,
      title: `Free roofing quotes in ${brand.launchRegion}`,
      description: "Tell us about your roofing job in about a minute. Free, with no obligation.",
      locale: "en_GB",
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f2438",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-GB">
      <body className="min-h-dvh bg-white font-sans text-base text-ink antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-3 focus:font-semibold focus:ring-4 focus:ring-brand-300"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
