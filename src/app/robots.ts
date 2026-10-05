import type { MetadataRoute } from "next";
import { getBrand } from "@/config/brand";

// Only the production site may be indexed. Staging and previews also send X-Robots-Tag: noindex
// (next.config.ts), which is the stronger signal; this file is the polite first line.
export default function robots(): MetadataRoute.Robots {
  const brand = getBrand();
  if (brand.appEnv !== "production") {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  return { rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/admin"] }, sitemap: `${brand.appUrl}/sitemap.xml` };
}
