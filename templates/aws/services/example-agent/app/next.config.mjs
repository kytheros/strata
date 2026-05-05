// Standalone output keeps the runtime image small — `node server.js` boots
// Next without bundling the entire monorepo into the container.
// See https://nextjs.org/docs/app/api-reference/next-config-js/output
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Trust the X-Forwarded-* headers from the upstream (ALB or API GW) so
  // request.url reflects the public URL, not the container's internal port.
  experimental: {
    // Server actions are not used in this scaffold, but leaving them off
    // explicitly is documentation in itself.
    serverActions: undefined,
  },
};

export default nextConfig;
