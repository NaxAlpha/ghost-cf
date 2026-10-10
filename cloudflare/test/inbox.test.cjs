const assert = require('node:assert/strict');
const test = require('node:test');

test('admin inbox rejects public access and stores only the configured recipient', async () => {
  const { default: worker } = await import('../inbox/worker.js');
  let saved;
  const env = {
    INBOX_TOKEN: 'private-test-token',
    INBOX_ADDRESS: 'owner@example.com',
    MAIL: {
      put: async (key, body) => {
        saved = { key, text: await new Response(body).text() };
      },
      list: async () => ({ objects: [], truncated: false }),
    },
  };
  assert.equal((await worker.fetch(new Request('https://inbox.test/messages'), env)).status, 401);
  assert.equal(
    (
      await worker.fetch(
        new Request('https://inbox.test/messages', {
          headers: { Authorization: 'Bearer wrong-token' },
        }),
        env,
      )
    ).status,
    401,
  );
  const response = await worker.fetch(
    new Request('https://inbox.test/messages', {
      headers: { Authorization: `Bearer ${env.INBOX_TOKEN}` },
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  let rejection;
  const message = {
    to: 'other@example.com',
    rawSize: 20,
    raw: new Response('secret code').body,
    setReject: (reason) => {
      rejection = reason;
    },
  };
  await worker.email(message, env);
  assert.equal(rejection, 'Unknown recipient');
  assert.equal(saved, undefined);
  await worker.email({ ...message, to: env.INBOX_ADDRESS }, env);
  assert.equal(saved.text, 'secret code');
  assert.match(saved.key, /^inbox\/\d+-[a-f0-9-]+\.eml$/);
  saved = undefined;
  await worker.email({ ...message, to: env.INBOX_ADDRESS, rawSize: 6 * 1024 * 1024 }, env);
  assert.equal(rejection, 'Message exceeds inbox limit');
  assert.equal(saved, undefined);
});
