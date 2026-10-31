import { defineConfig } from 'vite'

// Vite's config runs in Node but the project has no @types/node, so the one
// global we need is declared here. `erasableSyntaxOnly` allows declarations.
declare const process: { env: Record<string, string | undefined> }

export default defineConfig({
  // GitHub Pages serves a project site from a sub-path, so every asset path in
  // the build must be relative.
  base: './',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
  },
  server: {
    port: 5173,
    // In development the API lives somewhere else (window.APP_API_BASE is empty
    // until the Pages workflow injects it), so /api is proxied to the local
    // server. Point it elsewhere with VITE_DEV_API, e.g.
    //   VITE_DEV_API=https://healthlog.152.69.178.242.sslip.io npm run dev
    proxy: {
      // A regex, not the prefix '/api' — a plain prefix also swallows
      // /api-config.js and proxies it to the API, which 404s.
      '^/api/': {
        target: process.env.VITE_DEV_API ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
})
