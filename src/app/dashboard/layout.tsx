import type { Metadata } from "next";

// Personal data and one-time links live under here: never indexed, never cached (next.config.ts adds the headers).
export const metadata: Metadata = {
  title: { default: "Your leads", template: "%s | Your leads" },
  robots: { index: false, follow: false, nocache: true },
};

export default function DashboardRootLayout({ children }: LayoutProps<"/dashboard">) {
  return <div className="min-h-dvh bg-stone-50">{children}</div>;
}
