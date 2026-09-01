import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "AnalystArena 每日市场情报";
  const description = "把官方公告、新闻、Reddit 社区与 X 平台信号整理成投资人每日市场简报。";

  return {
    metadataBase: new URL(origin),
    title,
    description,
    other: { google: "notranslate" },
    openGraph: {
      title,
      description,
      type: "website",
      url: origin,
      locale: "zh_CN",
      images: [{ url: `${origin}/og.png`, width: 1731, height: 909, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" translate="no">
      <body className="notranslate">{children}</body>
    </html>
  );
}
