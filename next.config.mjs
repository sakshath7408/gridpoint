/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    // Transformers.js ships Node-only optional deps that must not be bundled
    // for the browser. The model runs on WebAssembly client-side.
    config.resolve.alias = {
      ...config.resolve.alias,
      sharp$: false,
      'onnxruntime-node$': false,
    };
    return config;
  },
};
export default nextConfig;
