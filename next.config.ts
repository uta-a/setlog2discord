import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 全レスポンスに noindex（設計書11章）
  async headers() {
    return [{ source: "/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] }];
  },
};

export default nextConfig;
