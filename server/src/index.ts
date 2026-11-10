import { handleAdmin } from './admin';
import { handleV1 } from './api';
import { cfg } from './db';
import { runEpoch } from './game';

if (!process.env.ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD not set: /admin is disabled');

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/v1/')) return handleV1(req, url);
    if (url.pathname === '/admin') {
      const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || srv.requestIP(req)?.address || '?';
      return handleAdmin(req, ip);
    }
    if (url.pathname === '/health') return new Response('ok');
    return new Response('not found', { status: 404 });
  },
});
console.info(`constellation listening on :${server.port}`);

// Epoch loop: re-reads EPOCH_SECONDS every tick so admin edits apply live.
function tick(): void {
  try {
    runEpoch();
  } catch (e) {
    console.error('epoch failed', e);
  }
  setTimeout(tick, cfg().EPOCH_SECONDS * 1000);
}
setTimeout(tick, cfg().EPOCH_SECONDS * 1000);
