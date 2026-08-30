import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Skylark Intelligence | Business Intelligence Agent",
  description:
    "AI-powered business intelligence agent for Skylark Drones. Ask natural-language questions about your pipeline, work orders, revenue, and operational metrics.",
  keywords: ["Skylark Drones", "Business Intelligence", "AI Agent", "Monday.com", "Drone Services"],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
