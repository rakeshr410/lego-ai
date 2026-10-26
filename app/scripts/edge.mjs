// A stand-in for the production load balancer, for docker compose and the e2e suite: one origin in
// front of this app and the main site, sending each request to whichever serves its path
// (routes.mjs). Streams both ways (the interview's replies are server-sent events) and appends the
// client to X-Forwarded-For like a load balancer, so both upstreams run with TRUST_PROXY=1.
//
//   EDGE_PORT=4300 AI_URL=http://localhost:4322 WEB_URL=http://localhost:4321 node scripts/edge.mjs
//
// Not for production: it has no TLS, timeouts or limits of its own.

import { request as httpRequest, createServer } from 'node:http';
import { owns } from '../routes.mjs';

const port = Number(process.env.EDGE_PORT ?? 4300);
const host = process.env.EDGE_HOST ?? '0.0.0.0';
const ai = new URL(process.env.AI_URL ?? 'http://localhost:4322');
const web = new URL(process.env.WEB_URL ?? 'http://localhost:4321');

const server = createServer((req, res) => {
  const path = req.url ?? '/';
  const target = path === '/__edge/health' ? null : owns(path) ? ai : web;
  if (!target) {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  const client = req.socket.remoteAddress ?? '';
  const xff = req.headers['x-forwarded-for'];
  const upstream = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path,
      // The Host header is kept: both apps check Origin against the host the browser used.
      headers: { ...req.headers, 'x-forwarded-for': xff ? `${xff}, ${client}` : client, 'x-forwarded-proto': 'http' },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.statusMessage, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`edge: ${target.host} did not answer (${err.message})`);
  });
  req.pipe(upstream);
});

server.listen(port, host, () => console.log(`[edge] http://${host}:${port}: lego-ai paths to ${ai.origin}, the rest to ${web.origin}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
