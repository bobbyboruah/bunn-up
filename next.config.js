/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: { typedRoutes: true, serverActions: { bodySizeLimit: '1mb' } },
};
module.exports = nextConfig;
