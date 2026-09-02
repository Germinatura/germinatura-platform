import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Germinatura",
  description: "Portal institucional da comunidade Germinatura",
};

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
