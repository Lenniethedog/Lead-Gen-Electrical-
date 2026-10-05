import type { MetadataRoute } from "next";
import { getBrand } from "@/config/brand";

export default function sitemap(): MetadataRoute.Sitemap {
  const { appUrl } = getBrand();
  return ["/", "/privacy", "/terms"].map((path) => ({ url: `${appUrl}${path}` }));
}
