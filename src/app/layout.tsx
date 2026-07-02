import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kalshi Weather - Prediction Tool",
  description: "Weather prediction events from Kalshi with AI-powered analysis",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-kalshi-bg text-kalshi-text min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
