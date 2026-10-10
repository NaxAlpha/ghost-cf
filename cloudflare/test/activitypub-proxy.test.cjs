const { test } = require('node:test');
const assert = require('node:assert/strict');
const { activityPubRequest } = require('../src/activitypub-proxy.cjs');

test('proxies only Social Web routes without leaking bootstrap or session secrets', () => {
  const request = new Request('https://blog.example/.ghost/activitypub/v1/site/?test=1', {
    headers: {
      cookie: 'ghost-admin-api-session=private',
      'X-Ghost-CF-Test': 'private',
      Authorization: 'Bearer social-web-identity',
      'x-forwarded-for': 'untrusted',
      'CF-Connecting-IP': '192.0.2.3',
    },
  });
  const proxied = activityPubRequest(request, 'https://social.example');
  assert.equal(proxied.url, 'https://social.example/.ghost/activitypub/v1/site/?test=1');
  assert.equal(proxied.headers.get('cookie'), null);
  assert.equal(proxied.headers.get('X-Ghost-CF-Test'), null);
  assert.equal(proxied.headers.get('Authorization'), 'Bearer social-web-identity');
  assert.equal(proxied.headers.get('x-forwarded-host'), 'blog.example');
  assert.equal(proxied.headers.get('x-forwarded-for'), '192.0.2.3');
  assert.equal(
    activityPubRequest(new Request('https://blog.example/ghost/'), 'https://social.example'),
    null,
  );
  assert.equal(activityPubRequest(request, undefined), null);
  assert.throws(() => activityPubRequest(request, 'http://social.example'), /HTTPS origin/);
});
