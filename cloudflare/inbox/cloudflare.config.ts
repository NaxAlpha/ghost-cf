import { bindings, defineConfig } from 'cf/config';
import * as entrypoint from './worker.js' with { type: 'cf-worker' };

const name = process.env.GHOST_CF_INBOX_WORKER;
const bucket = process.env.GHOST_CF_INBOX_BUCKET;
const address = process.env.GHOST_CF_INBOX_ADDRESS;
if (!name || !bucket || !address) throw new Error('Set inbox Worker, bucket, and address');

export default defineConfig({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  worker: {
    name,
    entrypoint,
    compatibilityDate: '2026-10-10',
    observability: { enabled: true, traces: { enabled: true } },
    env: {
      MAIL: bindings.r2({ name: bucket }),
      INBOX_TOKEN: bindings.secret(),
      INBOX_ADDRESS: bindings.json(address),
    },
  },
});
