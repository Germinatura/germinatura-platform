import type { Metadata, Viewport } from "next";
import { appBrand, appPageIcons } from "@germinatura/ui/brand";
import { ToastProvider } from "@/components/ui/Toast";
import { OfflineRegistration } from "@/components/OfflineRegistration";
import "./globals.css";

export const metadata: Metadata = {
  title: "PDV Germinatura",
  description: "Ponto de venda mobile-first da Germinatura",
  manifest: "/manifest.webmanifest",
  icons: appPageIcons,
  appleWebApp: { title: appBrand.pdv.shortName, statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = { themeColor: appBrand.pdv.theme };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" data-theme="dark">
      <body className="bg-background font-sans text-foreground antialiased">
        <ToastProvider>{children}</ToastProvider>
        <OfflineRegistration />
      </body>
    </html>
  );
}
