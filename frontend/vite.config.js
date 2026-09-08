import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_URL || 'http://localhost:3000';

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg'],
        manifest: {
          name: 'Raktify',
          short_name: 'Raktify',
          description: 'Raktify — voluntary blood donation network',
          theme_color: '#b91c1c',
          background_color: '#ffffff',
          display: 'standalone',
          start_url: '/',
          scope: '/',
          icons: [
            { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
          ],
        },
        workbox: {
          // Static standalone pages must NOT be hijacked by the SPA-shell
          // navigation fallback — without this, a repeat visitor (service
          // worker installed) navigating to /how-raktify-works.html would be
          // served index.html and React Router would render a blank page.
          // /privacy, /terms, /data-deletion are static HTML (public/*.html),
          // served at clean URLs via staticwebapp.config.json rewrites — the SW
          // must let them hit the network, not the SPA shell.
          // /c/:slug is a REAL React Router route, so the SPA shell is the
          // right response - but it must come from the NETWORK, never the
          // precache. Two reasons, and the first one already shipped a bug:
          //   1. a returning device with an installed SW was served the
          //      precached shell from a PREVIOUS build, referencing that
          //      build's JS hash - so the organiser's logo block, added
          //      later, was simply not in the bundle the phone ran. It
          //      rendered fine in a private window (no SW) and broken on
          //      every real handset, which is what made it look like a
          //      styling bug rather than a caching one.
          //   2. frontend/api/camp-og rewrites this path to inject per-camp
          //      OG metas into the shell. A precache hit never reaches the
          //      function, so the shell would carry the generic card.
          navigateFallbackDenylist: [
            /^\/c\//,
            // One-shot / magic-link entry points. Same reason 1 as /c/ above:
            // the person arrives from a WhatsApp message on a device holding
            // an arbitrarily old precached shell, acts ONCE, and a field
            // shipped after that shell was cached is silently absent. That is
            // exactly how the self-chosen staff username (a11192b) appeared
            // to be missing from /activate on real handsets while rendering
            // correctly in a private window - and there is no
            // username-change endpoint, so completing setup on a stale shell
            // locks in the derived placeholder for good. Unlike /c/, NO
            // managed function rewrites these; do not merge the two groups.
            /^\/setup\//,
            /^\/activate\//,
            /^\/consent\//,
            /^\/camp\//, // NOT /camps/host - the trailing slash excludes it
            /^\/alert\//,
            /^\/how-raktify-works\.html/,
            /^\/privacy(\.html)?$/,
            /^\/terms(\.html)?$/,
            /^\/data-deletion(\.html)?$/,
            /^\/donate(\.html)?$/,
            /^\/developers(\.html|\.md)?$/,
            /^\/api-docs(\.html)?$/,
            /^\/api\//,
            /^\/llms\.txt$/,
          ],
          // Network-first for API calls; precache the app shell.
          runtimeCaching: [
            {
              urlPattern: ({ url }) =>
                url.pathname.startsWith('/auth') ||
                url.pathname.startsWith('/donors') ||
                url.pathname.startsWith('/coordinator') ||
                url.pathname.startsWith('/requests') ||
                url.pathname.startsWith('/inventory'),
              handler: 'NetworkFirst',
              options: {
                cacheName: 'raktify-api',
                networkTimeoutSeconds: 5,
                expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 },
              },
            },
          ],
        },
      }),
    ],
    server: {
      port: 5173,
      // Any API prefix that also has a client-side route at the same base
      // path (e.g. /admin, /hospital, /consent) MUST bypass proxying for
      // top-level HTML navigations — otherwise a fresh browser load of
      // `/consent/:token` gets JSON-proxied to the backend, hits the app's
      // 404 catch-all, and never reaches React Router. `bypass` returning
      // the URL tells http-proxy-middleware "serve this from Vite instead".
      // Fetches from within a loaded page send Accept: application/json and
      // pass through the proxy normally.
      proxy: (() => {
        const apiWithSpaBypass = {
          target: apiTarget,
          changeOrigin: false,
          bypass(req) {
            if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
              return req.url;
            }
          },
        };
        const entries = [
          '/auth',
          '/donors',
          '/donations',
          '/inventory',
          '/requests',
          '/coordinator',
          '/community-leader',
          '/dho',
          '/lookback',
          '/institutions',
          '/onboarding',
          '/admin',
          '/camps',
          '/registries',
          '/geography',
          '/reports',
          '/health',
          '/hospital',
          '/consent',
          '/webhooks',
        ];
        return Object.fromEntries(entries.map((p) => [p, apiWithSpaBypass]));
      })(),
    },
  };
});
