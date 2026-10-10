const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nodeRequest } = require('../src/node-request.cjs');

test('routes internal scheduling requests by origin and preserves signed URL and body', async () => {
  const request = new Request(
    'https://publication.example/ghost/api/admin/schedules/posts/123/?token=signed',
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'http',
        Host: 'wrong.example',
      },
      body: JSON.stringify({ force: true }),
    },
  );
  const forwarded = nodeRequest(request);
  assert.equal(forwarded.headers.get('Host'), 'publication.example');
  assert.equal(forwarded.headers.get('X-Forwarded-Proto'), 'https');
  assert.equal(forwarded.url, request.url);
  assert.equal(forwarded.method, 'PUT');
  assert.deepEqual(await forwarded.json(), { force: true });
});
