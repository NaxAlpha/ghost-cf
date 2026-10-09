import { bindings, defineConfig, exports } from 'cf/config';
import { env } from 'node:process';
import * as entrypoint from './src/index.js' with { type: 'cf-worker' };

export default defineConfig({
  worker: {
    name: env.GHOST_CF_WORKER_NAME || 'ghost-cf-probe',
    compatibilityDate: '2026-10-09',
    compatibilityFlags: ['enable_ctx_exports'],
    entrypoint,
    exports: { GhostDatabase: exports.durableObject({ storage: 'sqlite' }) },
    observability: { enabled: true, traces: { enabled: true } },
    env: {
      ...(env.GHOST_CF_PROBE !== 'do'
        ? {
            DB: bindings.d1({
              name: env.GHOST_CF_DATABASE_NAME || 'ghost-cf-probe',
              id: env.GHOST_CF_DATABASE_ID,
            }),
            MEDIA: bindings.r2({ name: env.GHOST_CF_BUCKET_NAME || 'ghost-cf-probe' }),
          }
        : {}),
      TEST_TOKEN: bindings.secret(),
    },
  },
});
