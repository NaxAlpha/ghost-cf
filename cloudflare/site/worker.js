import { createServer } from 'node:http';
import { handleAsNodeRequest } from 'cloudflare:node';
import { DurableObject } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import taskModule from '../src/durable-tasks.cjs';
import boot from '../artifacts/ghost/ghost-platform-boot.mjs';
import assets from '../artifacts/ghost/runtime-assets.json';

import requestModule from '../src/node-request.cjs';
const { nodeRequest } = requestModule;

const server = createServer((request, response) => boot.getBindings().APP(request, response));
server.listen(2368);

// Ghost is a singleton: deploy one Worker per publication, with one named object.
export class GhostPublication extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.tasks = new taskModule.DurableTasks(ctx.storage);
  }
  bindings() {
    return {
      DO_STORAGE: this.ctx.storage,
      MEDIA: this.env.MEDIA,
      IMAGES: this.env.IMAGES,
      TASKS: this.tasks,
      APP: (request, response) => this.app(request, response),
      INTERNAL_FETCH: (request) => handleAsNodeRequest(2368, nodeRequest(request)),
    };
  }
  async initialize() {
    this.ready ??= (async () => {
      for (const [filename, base64] of Object.entries(assets)) {
        mkdirSync(dirname(filename), { recursive: true });
        writeFileSync(filename, Buffer.from(base64, 'base64'));
      }
      return boot({ backend: true, frontend: true, server: false });
    })();
    this.app = await this.ready;
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
    // Protect experimental deployments, including the owner setup endpoint.
    const supplied = Buffer.from(request.headers.get('X-Ghost-CF-Test') || '');
    const expected = Buffer.from(env.TEST_TOKEN);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return new Response('Not found', { status: 404 });
    }
    if (new URL(request.url).pathname.startsWith('/ghost/assets/')) {
      return env.ASSETS.fetch(request);
    }
    return ctx.exports.GhostPublication.getByName('publication').fetch(request);
  },
};
