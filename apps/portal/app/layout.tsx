import type { Metadata, Viewport } from "next";
import { appBrand, appPageIcons } from "@germinatura/ui/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: "Germinatura",
  description: "Portal institucional da comunidade Germinatura",
  manifest: "/manifest.webmanifest",
  icons: appPageIcons,
  appleWebApp: { title: appBrand.portal.shortName, statusBarStyle: "default" },
};

export const viewport: Viewport = { themeColor: appBrand.portal.theme };

import { ToastProvider } from "@/components/ui/Toast";

import { DashboardLayout } from "@/components/layout/DashboardLayout";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body className="bg-background-light font-sans text-[var(--g-text-primary)] antialiased">
        <ToastProvider>
          <DashboardLayout>
            {children}
          </DashboardLayout>
        </ToastProvider>
      </body>
    </html>
  );
}
