const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withBindings } = require('../src/context.cjs');
const { createGhostAdapters } = require('../src/ghost-adapters.cjs');

test('retries routing failures and preserves Ghost scheduling authentication', async () => {
  const { DurableScheduling } = createGhostAdapters({
    RouteFileStore: class {},
    RedirectsStoreBase: class {},
    SchedulingBase: class {},
    JobsBackendBase: class {},
  });
  let handler;
  const bindings = {
    TASKS: {
      handle: (_kind, callback) => {
        handler = callback;
      },
    },
    INTERNAL_FETCH: async (request) => {
      assert.equal(request.method, 'PUT');
      assert.equal(new URL(request.url).searchParams.get('token'), 'signed');
      assert.equal(request.headers.get('Idempotency-Key'), 'job-id');
      assert.deepEqual(await request.json(), { force: true });
      return new Response('Routing failure', { status: 404 });
    },
  };
  await withBindings(bindings, async () => {
    new DurableScheduling().run();
    await assert.rejects(
      handler({
        job: {
          url: 'https://publication.example/ghost/api/admin/schedules/posts/123/?token=signed',
          extra: { idempotencyKey: 'job-id' },
        },
      }),
      /Scheduled Ghost request failed: 404/,
    );
  });
});
