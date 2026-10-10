function nodeRequest(request) {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  // Internally constructed Requests lack the Host header used by Ghost's vhost
  // router. Derive proxy metadata from the trusted Worker request URL.
  headers.set('Host', url.host);
  headers.set('X-Forwarded-Proto', url.protocol.slice(0, -1));
  return new Request(request, { headers });
}
module.exports = { nodeRequest };
