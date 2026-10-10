const { timingSafeEqual } = require('node:crypto');

function siteAccess(request, env) {
  const pathname = new URL(request.url).pathname;
  // Runtime files contain configuration and must never be served publicly.
  if (pathname.startsWith('/__ghost-cf/') && pathname !== '/__ghost-cf/fonts/Inter.ttf') {
    return false;
  }
  if (pathname === '/__ghost-cf/fonts/Inter.ttf') return true;
  // Keep first-owner creation private even when the publication is public.
  const setup =
    request.method === 'POST' && /^\/ghost\/api\/admin\/authentication\/setup\/?$/.test(pathname);
  if (env.PUBLIC_SITE === true && !setup) return true;
  const supplied = Buffer.from(request.headers.get('X-Ghost-CF-Test') || '');
  const expected = Buffer.from(env.TEST_TOKEN || '');
  return (
    expected.length > 0 &&
    supplied.length === expected.length &&
    timingSafeEqual(supplied, expected)
  );
}

module.exports = { siteAccess };
