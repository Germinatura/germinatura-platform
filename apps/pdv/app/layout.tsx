import type { Metadata } from "next";
import { ToastProvider } from "@/components/ui/Toast";
import { OfflineRegistration } from "@/components/OfflineRegistration";
import "./globals.css";

export const metadata: Metadata = {
  title: "PDV Germinatura",
  description: "Ponto de venda mobile-first da Germinatura",
  manifest: "/manifest.webmanifest",
};

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
