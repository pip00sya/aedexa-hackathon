import type { Metadata } from "next";
import { Golos_Text, JetBrains_Mono, Jost } from "next/font/google";
import "./globals.css";
// ARCHE form and material sit on top of the layout, so this import comes after it
import "./arche.css";
// Landing page
import "./landing.css";

// Two working typefaces, plus one for the six letters of the name
const ui = Golos_Text({
  variable: "--font-aedexa",
  subsets: ["latin", "cyrillic"],
  display: "swap",
});

const display = Golos_Text({
  variable: "--font-display",
  subsets: ["latin", "cyrillic"],
  display: "swap",
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin", "cyrillic"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

// The name is set in Latin letters
const mark = Jost({
  variable: "--font-mark",
  subsets: ["latin"],
  weight: ["200", "300"],
  display: "swap",
});

export function generateMetadata(): Metadata {
  const title = "AEDEXA — code-compliant building placement";
  const description =
    "Turn a DWG or a plan image into a measurable base: site boundary, surrounding objects, code setbacks, and the buildable area. DWG topographic survey runs as its own workspace mode.";

  return {
    title,
    description,
    icons: { icon: "/icon.svg", shortcut: "/icon.svg" },
    // Link preview card without an image
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary", title, description },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${ui.variable} ${display.variable} ${mono.variable} ${mark.variable} antialiased`}
      >
        {process.env.NODE_ENV !== "production" && (
          // This rule was written for _document in the old Pages Router
          // eslint-disable-next-line @next/next/no-page-custom-font
          <link
            rel="stylesheet"
            precedence="default"
            href="https://fonts.googleapis.com/css2?family=Golos+Text:wght@400..900&family=JetBrains+Mono:wght@400..700&family=Jost:wght@200..300&display=swap"
          />
        )}
        {children}
      </body>
    </html>
  );
}
