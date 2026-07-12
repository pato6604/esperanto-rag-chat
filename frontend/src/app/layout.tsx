import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Source_Serif_4 } from "next/font/google";
import "./globals.css";

const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-claude-like",
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Esperanto",
  description: "Chat with your documents",
  icons: {
    icon: "/rag-favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="es" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                var theme = localStorage.getItem("esperanto-theme");
                var root = document.documentElement;
                root.classList.toggle("dark", theme !== "light");
                root.setAttribute("data-theme", theme === "light" ? "light" : "dark");
              } catch (_) {}
            `,
          }}
        />
      </head>
      <body className={`${sourceSerif.variable} antialiased`}>{children}</body>
    </html>
  );
}
