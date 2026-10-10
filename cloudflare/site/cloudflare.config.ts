import { bindings, defineConfig, exports, triggers } from 'cf/config';
import * as entrypoint from './worker.js' with { type: 'cf-worker' };

const name = process.env.GHOST_CF_WORKER_NAME;
const bucket = process.env.GHOST_CF_BUCKET_NAME;
if (!name || !bucket) throw new Error('Set GHOST_CF_WORKER_NAME and GHOST_CF_BUCKET_NAME');

export default defineConfig({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  worker: {
    name,
    entrypoint,
    compatibilityDate: '2026-10-10',
    ...(process.env.GHOST_CF_DOMAIN ? { domains: [process.env.GHOST_CF_DOMAIN] } : {}),
    ...(process.env.GHOST_CF_ROUTE
      ? { triggers: [triggers.fetch({ pattern: process.env.GHOST_CF_ROUTE })] }
      : {}),
    exports: { GhostPublication: exports.durableObject({ storage: 'sqlite' }) },
    assets: { runWorkerFirst: true, htmlHandling: 'none', notFoundHandling: 'none' },
    observability: { enabled: true, traces: { enabled: true } },
    env: {
      ASSETS: bindings.assets(),
      IMAGES: bindings.images(),
      MEDIA: bindings.r2({ name: bucket }),
      ...(process.env.GHOST_CF_MAIL_FROM ? { EMAIL: bindings.sendEmail() } : {}),
      TEST_TOKEN: bindings.secret(),
      PUBLIC_SITE: bindings.json(process.env.GHOST_CF_PUBLIC === 'true'),
      ACTIVITYPUB_ORIGIN: bindings.json(process.env.GHOST_CF_ACTIVITYPUB_ORIGIN || ''),
    },
  },
});
