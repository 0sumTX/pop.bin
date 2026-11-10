// Entry point: Bun.serve locally and on Vercel (bunVersion in vercel.json). No timers: epochs run
// on the first request after each boundary (see maybeEpoch), so serverless needs no cron.
import { handleAdmin } from './admin';
import { handleV1 } from './api';

if (!process.env.ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD not set: /admin is disabled');

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(req, srv) {
    const path = new URL(req.url).pathname;
    try {
      if (path.startsWith('/v1/')) return await handleV1(req, path);
      if (path === '/admin') {
        const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || srv.requestIP(req)?.address || '?';
        return await handleAdmin(req, ip);
      }
      if (path === '/health' || path === '/') return new Response('constellation ok');
      return new Response('not found', { status: 404 });
    } catch (e) {
      console.error('request failed', req.method, path, e);
      return Response.json({ error: 'server error' }, { status: 500 });
    }
  },
});
console.info(`constellation listening on :${server.port}`);
