import type { Metadata } from "next";
import "./globals.css";

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "https://base-app-1-bay.vercel.app").replace(/\/$/, "");

const miniappEmbed = {
  version: "next",
  imageUrl: `${APP_URL}/api/share-image`,
  button: {
    title: "Play Pragma",
    action: {
      type: "launch_frame",
      name: "Pragma",
      url: APP_URL,
      splashImageUrl: `${APP_URL}/splash.svg`,
      splashBackgroundColor: "#0f62fe"
    }
  }
};

export const metadata: Metadata = {
  title: "Pragma",
  description: "Onchain survival mini app on Base",
  metadataBase: new URL(APP_URL),
  openGraph: {
    title: "Pragma",
    description: "Onchain survival mini app on Base",
    images: [`${APP_URL}/api/share-image`]
  },
  other: {
    "fc:miniapp": JSON.stringify(miniappEmbed),
    "fc:frame": JSON.stringify(miniappEmbed)
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <meta name="base:app_id" content="6995a0a325337829d86a541c" />
      </head>
      <body>{children}</body>
    </html>
  );
}
