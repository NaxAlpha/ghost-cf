const prefix = 'inbox/';
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

async function authorized(request, env) {
  if (!env.INBOX_TOKEN) return false;
  const token = request.headers.get('Authorization')?.replace(/^Bearer /, '');
  if (!token) return false;
  const digest = (value) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [actual, expected] = await Promise.all([digest(token), digest(env.INBOX_TOKEN)]);
  let difference = 0;
  const bytes = new Uint8Array(actual);
  const wanted = new Uint8Array(expected);
  for (let i = 0; i < bytes.length; i++) difference |= bytes[i] ^ wanted[i];
  return difference === 0;
}

export default {
  async email(message, env) {
    if (message.to.toLowerCase() !== env.INBOX_ADDRESS.toLowerCase()) {
      message.setReject('Unknown recipient');
      return;
    }
    if (message.rawSize > 5 * 1024 * 1024) {
      message.setReject('Message exceeds inbox limit');
      return;
    }
    // Await durable storage before accepting delivery. Do not log credentials in mail.
    await env.MAIL.put(`${prefix}${Date.now()}-${crypto.randomUUID()}.eml`, message.raw, {
      httpMetadata: { contentType: 'message/rfc822' },
      customMetadata: { receivedAt: new Date().toISOString() },
    });
  },
  async fetch(request, env) {
    if (!(await authorized(request, env)))
      return new Response('Unauthorized', { status: 401, headers });
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/messages') {
      const cursor = url.searchParams.get('cursor') || undefined;
      const page = await env.MAIL.list({ prefix, limit: 100, cursor });
      return Response.json(
        {
          messages: page.objects.map((object) => ({
            id: object.key.slice(prefix.length),
            receivedAt: object.uploaded,
          })),
          cursor: page.truncated ? page.cursor : null,
        },
        { headers },
      );
    }
    const match = /^\/messages\/(\d+-[a-f0-9-]+\.eml)$/.exec(url.pathname);
    if (match && request.method === 'GET') {
      const mail = await env.MAIL.get(prefix + match[1]);
      if (!mail) return new Response('Not found', { status: 404, headers });
      return new Response(mail.body, {
        headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    if (match && request.method === 'DELETE') {
      await env.MAIL.delete(prefix + match[1]);
      return new Response(null, { status: 204, headers });
    }
    return new Response('Not found', { status: 404, headers });
  },
};
