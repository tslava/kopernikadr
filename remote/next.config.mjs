// Static export for Capacitor (webDir = out/). One route (`/`): the Capacitor local server
// answers extensionless paths with the root index.html, so in-page views survive a reload.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  // npm workspaces hoist deps to the repo root and symlink @kopernikadr/remote-core there.
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  // remote-core is plain browser ESM from a workspace symlink; compile it like app code.
  transpilePackages: ['@kopernikadr/remote-core'],
  devIndicators: false,
  // The "O aplikacji" section shows the package version.
  env: { NEXT_PUBLIC_APP_VERSION: JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version },
};

export default nextConfig;
