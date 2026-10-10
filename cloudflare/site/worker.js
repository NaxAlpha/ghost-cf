import { createServer } from 'node:http';
import { handleAsNodeRequest } from 'cloudflare:node';
import { DurableObject } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { rasterizeSvg } from '../src/svg-renderer.mjs';
import taskModule from '../src/durable-tasks.cjs';
import boot from '../artifacts/ghost/ghost-platform-boot.mjs';

import requestModule from '../src/node-request.cjs';
const { nodeRequest } = requestModule;

const server = createServer((request, response) => boot.getBindings().APP(request, response));
server.listen(2368);

// An object can be recreated while this module and Ghost's singleton survive.
// Keep code handlers and the app shared, but use each new object's live storage.
const taskRegistry = { handlers: new Map() };
let publicationReady;

// Ghost is a singleton: deploy one Worker per publication, with one named object.
export class GhostPublication extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.tasks = new taskModule.DurableTasks(ctx.storage, taskRegistry);
  }
  bindings() {
    return {
      DO_STORAGE: this.ctx.storage,
      MEDIA: this.env.MEDIA,
      IMAGES: this.env.IMAGES,
      EMAIL: this.env.EMAIL,
      RASTERIZE_SVG: rasterizeSvg,
      GIFT_FONT_URL: this.fontUrl,
      TASKS: this.tasks,
      APP: (request, response) => this.app(request, response),
      INTERNAL_FETCH: (request) => handleAsNodeRequest(2368, nodeRequest(request)),
    };
  }
  async initialize() {
    this.ready ??= (async () => {
      const response = await this.env.ASSETS.fetch(
        new Request('https://ghost-cf-assets/__ghost-cf/runtime-assets.json'),
      );
      if (!response.ok) throw new Error('Ghost runtime assets are missing');
      const assets = await response.json();
      const configuration = JSON.parse(
        Buffer.from(assets['/tmp/ghost/config.production.json'], 'base64').toString(),
      );
      const fontUrl = new URL('/__ghost-cf/fonts/Inter.ttf', configuration.url).href;
      for (const [filename, base64] of Object.entries(assets)) {
        mkdirSync(dirname(filename), { recursive: true });
        writeFileSync(filename, Buffer.from(base64, 'base64'));
      }
      await boot.restoreThemes();
      publicationReady ??= boot({ backend: true, frontend: true, server: false });
      return { app: await publicationReady, fontUrl };
    })();
    const publication = await this.ready;
    this.app = publication.app;
    this.fontUrl = publication.fontUrl;
    boot.getBindings().GIFT_FONT_URL = this.fontUrl;
  }
  async alarm() {
    return boot.withBindings(this.bindings(), async () => {
      await this.initialize();
      await this.tasks.run();
    });
  }
  async fetch(request) {
    return boot.withBindings(this.bindings(), async () => {
      await this.initialize();
      return handleAsNodeRequest(2368, nodeRequest(request));
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/__ghost-cf/fonts/Inter.ttf') {
      return env.ASSETS.fetch(request);
    }
    // Protect experimental deployments, including the owner setup endpoint.
    const supplied = Buffer.from(request.headers.get('X-Ghost-CF-Test') || '');
    const expected = Buffer.from(env.TEST_TOKEN);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return new Response('Not found', { status: 404 });
    }
    if (new URL(request.url).pathname.startsWith('/ghost/assets/')) {
      return env.ASSETS.fetch(request);
    }
    const response = await ctx.exports.GhostPublication.getByName('publication').fetch(request);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      encodeBody: 'manual',
    });
  },
};
