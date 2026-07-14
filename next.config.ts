import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdfkit", "@fontsource/noto-sans-tc"],
};

export default nextConfig;
