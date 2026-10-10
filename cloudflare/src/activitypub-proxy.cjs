function activityPubRequest(request, origin) {
  if (!origin) return null;
  const source = new URL(request.url);
  if (
    !source.pathname.startsWith('/.ghost/activitypub/') &&
    !['/.well-known/webfinger', '/.well-known/nodeinfo'].includes(source.pathname)
  )
    return null;
  const destination = new URL(origin);
  if (
    destination.protocol !== 'https:' ||
    destination.pathname !== '/' ||
    destination.search ||
    destination.hash ||
    destination.username ||
    destination.password
  ) {
    throw new Error('ActivityPub requires an HTTPS origin');
  }
  destination.pathname = source.pathname;
  destination.search = source.search;
  const headers = new Headers(request.headers);
  headers.delete('X-Ghost-CF-Test');
  headers.delete('cookie');
  headers.set('host', source.host);
  headers.set('x-forwarded-host', source.host);
  headers.set('x-forwarded-proto', 'https');
  headers.delete('x-forwarded-for');
  headers.delete('x-real-ip');
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) {
    headers.set('x-forwarded-for', ip);
    headers.set('x-real-ip', ip);
  }
  return new Request(destination, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
    duplex: 'half',
  });
}

module.exports = { activityPubRequest };
