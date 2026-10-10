import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: '../artifacts/ghost/public',
  build: { minify: true },
  plugins: [cloudflare()],
});
