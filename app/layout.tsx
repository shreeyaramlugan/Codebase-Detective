import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Codebase Detective",
    template: "%s · Codebase Detective",
  },
  description:
    "Explore repository structure, trace dependencies, and get evidence-backed explanations of how a codebase works.",
  applicationName: "Codebase Detective",
};

export const viewport: Viewport = {
  themeColor: "#101820",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-stone-950 font-sans text-stone-100">
        {children}
      </body>
    </html>
  );
}
