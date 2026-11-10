// Badge request verification. Copied from the Lua API docs ("What your server receives"),
// with two changes: PUBLIC_ORIGIN rebuilds the URL behind a proxy, and `keys` is exported
// so tests can install their own signing key.
const SERVER = 'https://badge-api.solana.com';
export const keys = new Map<string, CryptoKey>();
const seen = new Map<string, number>(); // X-Badge-Request -> time
let fetchedAt = 0;

async function badgeKey(id: string): Promise<CryptoKey | null> {
  if (!keys.has(id) && Date.now() - fetchedAt > 60_000) { // at most once a minute
    fetchedAt = Date.now();
    try {
      const k = (await (await fetch(`${SERVER}/api/http/key`)).json()) as { id: string; key: string };
      const raw = Uint8Array.from(atob(k.key), (c) => c.charCodeAt(0));
      keys.set(k.id, await crypto.subtle.importKey('raw', raw, 'Ed25519', false, ['verify']));
    } catch (e) {
      console.error('badge key fetch failed', e);
    }
  }
  return keys.get(id) ?? null;
}

/** The URL the badge asked for. Behind a proxy, req.url is http:// or another host. */
function signedUrl(req: Request): string {
  const origin = process.env.PUBLIC_ORIGIN;
  if (!origin) return req.url;
  const u = new URL(req.url);
  return origin.replace(/\/$/, '') + u.pathname + u.search;
}

/** The badge and player behind a request from your app, or null. `body`: the raw body. */
export async function fromBadge(req: Request, body: string, app: string) {
  const h = (n: string) => req.headers.get(n) ?? '';
  const time = Number(h('x-badge-time'));
  const id = h('x-badge-request');
  if (h('x-badge-app') !== app || !(Math.abs(Date.now() - time) < 60_000) || !id || seen.has(id)) return null;
  const key = await badgeKey(h('x-badge-key'));
  if (!key) return null;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
  const signed = ['badge-http-v1', req.method, signedUrl(req), [...hash].map((b) => b.toString(16).padStart(2, '0')).join(''),
    app, h('x-badge-id'), h('x-badge-user'), h('x-badge-time'), id].join('\n');
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = Uint8Array.from(atob(h('x-badge-signature')), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (!(await crypto.subtle.verify('Ed25519', key, sig, new TextEncoder().encode(signed)))) return null;
  seen.set(id, time);
  for (const [k, t] of seen) if (Date.now() - t > 60_000) seen.delete(k);
  return { badge: h('x-badge-id'), user: h('x-badge-user') };
}
