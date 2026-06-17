/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@vpw/shared'],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'firebasestorage.googleapis.com' },
      { protocol: 'https', hostname: 'storage.googleapis.com' },
    ],
  },
  // typedRoutes (experimental) desactivado: exige rutas literales y choca con la
  // navegación dinámica del panel + módulos que se construyen por fases (P2-P10).
};

export default nextConfig;
