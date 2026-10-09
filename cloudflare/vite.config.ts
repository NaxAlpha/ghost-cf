import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [cloudflare()],
  resolve: {
    alias: {
      sqlite3: fileURLToPath(new URL('./src/native-sqlite-unavailable.cjs', import.meta.url)),
    },
  },
});
