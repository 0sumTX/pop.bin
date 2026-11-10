// /admin: one server-rendered page, basic auth (ADMIN_PASSWORD), forms post back to /admin.
import { timingSafeEqual } from 'node:crypto';
import { cfg, DEFAULTS, deleteChain, q, removeMember, run, setCfg } from './db';
import { fmtHashes, maybeEpoch, parseState } from './game';
import { botOp, normalize } from './api';

const fails = new Map<string, { n: number; until: number }>();

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

function authed(req: Request, ip: string): boolean | 'locked' {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return false;
  const f = fails.get(ip);
  if (f && f.until > Date.now()) return 'locked';
  const h = req.headers.get('authorization') ?? '';
  let given = '';
  try {
    given = h.startsWith('Basic ') ? atob(h.slice(6)).split(':').slice(1).join(':') : '';
  } catch { /* malformed header: treated as wrong */ }
  const a = new TextEncoder().encode(given), b = new TextEncoder().encode(pw);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (ok) fails.delete(ip);
  else if (h) {
    const n = (f?.n ?? 0) + 1; // ponytail: per-IP lockout in memory, 5 tries then 60 s
    fails.set(ip, { n, until: n >= 5 ? Date.now() + 60_000 : 0 });
  }
  return ok;
}

async function act(f: { get(k: string): unknown }): Promise<string | null> {
  const g = (k: string): string => String(f.get(k) ?? '');
  const id = Number(g('id'));
  const now = Math.floor(Date.now() / 1000);
  switch (g('a')) {
    case 'delete': await deleteChain(id); return null;
    case 'rename': {
      const n = normalize(g('name'));
      if (n.length < 3 || n.length > 16) return 'name must be 3-16 characters';
      if (await q.chainByName(n)) return 'name taken';
      await run('UPDATE chains SET name = ?, display_name = ? WHERE id = ?', [n, n.toUpperCase(), id]);
      return null;
    }
    case 'kick': await removeMember(g('badge')); return null;
    case 'reset_score': await run('UPDATE chains SET hashes = 0 WHERE id = ?', [id]); return null;
    case 'reset_all':
      if (g('confirm') !== 'RESET') return 'type RESET to confirm';
      for (const ch of await q.chains()) await deleteChain(ch.id);
      return null;
    case 'config': return await setCfg(g('key'), g('value'));
    case 'demo_badges':
      return await setCfg('DEMO_BADGES', JSON.stringify(g('value').split(/[\s,]+/).filter(Boolean)));
    case 'bot_add': {
      const ch = await q.chain(id);
      if (!ch?.demo) return 'demo chains only';
      const anchor = (await q.members(id)).find((m) => !m.bot);
      if (!anchor) return 'no badge to link bots to';
      const failed = await botOp(id, { op: 'add' }, anchor.badge_id, now, await cfg());
      return failed ? failed.error : null;
    }
    case 'bot_link': await run('UPDATE blocks SET bot_linked = 1 - bot_linked WHERE badge_id = ? AND bot = 1', [g('badge')]); return null;
    case 'force_round': await run('UPDATE chains SET round_override_at = ? WHERE id = ?', [now + 3, id]); return null;
    case 'wipe_demo':
      for (const ch of (await q.chains()).filter((c) => c.demo)) await deleteChain(ch.id);
      return null;
    default: return 'unknown action';
  }
}

async function page(msg: string | null): Promise<string> {
  const c = await cfg();
  const form = (a: string, fields: string, label: string, danger = false): string =>
    `<form method=post><input type=hidden name=a value=${a}>${fields}<button${danger ? ' class=d' : ''}>${label}</button></form>`;
  const sections: string[] = [];
  for (const ch of (await q.chains()).sort((a, b) => b.hashes - a.hashes)) {
    const s = parseState(ch);
    const hid = `<input type=hidden name=id value=${ch.id}>`;
    const members = (await q.members(ch.id)).map((m) => `<tr><td>${m.height}</td><td>${esc(m.handle || '-')}</td><td><code>${esc(m.badge_id)}</code></td>
      <td>${m.bot ? 'bot' + (m.bot_linked ? '' : ' (unlinked)') : ''}${s?.canon.includes(m.badge_id) ? ' canon' : s?.linked.includes(m.badge_id) ? ' linked' : ''}</td>
      <td>${form('kick', `<input type=hidden name=badge value="${esc(m.badge_id)}">`, 'kick', true)}
      ${m.bot ? form('bot_link', `<input type=hidden name=badge value="${esc(m.badge_id)}">`, 'toggle link') : ''}</td></tr>`).join('');
    sections.push(`<section><h3>${esc(ch.display_name)} ${ch.demo ? '<span class=demo>DEMO</span>' : ''}</h3>
      <p>${fmtHashes(ch.hashes)} hashes · rank ${s?.rank ?? '-'} · ${s ? `${s.hashrate} H/s x${s.mult}` : 'no epoch yet'} · genesis <code>${esc(ch.genesis_badge)}</code></p>
      <table>${members}</table><div class=row>
      ${form('rename', hid + '<input name=name placeholder="new name" required>', 'rename')}
      ${form('reset_score', hid, 'reset score')}
      ${ch.demo ? form('bot_add', hid, 'add bot') + form('force_round', hid, 'force round') : ''}
      ${form('delete', hid, 'delete chain', true)}</div></section>`);
  }
  const chains = sections.join('') || '<p>No chains yet.</p>';
  const cfgRows = Object.keys(DEFAULTS).map((k) =>
    `<tr><td>${k}</td><td>${form('config', `<input type=hidden name=key value=${k}><input name=value value="${esc(JSON.stringify(c[k as keyof typeof c]))}">`, 'set')}</td></tr>`).join('');
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>PoP.bin admin</title>
<style>body{background:#000;color:#00FF41;font:14px ui-monospace,monospace;margin:16px;max-width:960px}
input,button{background:#000;color:#00FF41;border:1px solid #00802A;font:inherit;padding:2px 6px}button{cursor:pointer}
button.d{color:#FF2A2A;border-color:#FF2A2A}form{display:inline-block;margin:2px}td{padding:2px 8px;vertical-align:top}
section{border:1px solid #00802A;padding:8px;margin:8px 0}.demo{color:#FFB000}.msg{color:#FF2A2A}code{color:#fff}.row{margin-top:6px}</style>
<h1>&gt; POP.BIN ADMIN</h1>${msg ? `<p class=msg>${esc(msg)}</p>` : ''}
<h2>Demo</h2><div class=row>${form('config', `<input type=hidden name=key value=DEMO_ENABLED><input type=hidden name=value value=${!c.DEMO_ENABLED}>`, c.DEMO_ENABLED ? 'turn demo OFF' : 'turn demo ON')}
${form('demo_badges', `<input name=value size=40 value="${esc(c.DEMO_BADGES.join(', '))}" placeholder="badge ids, comma separated">`, 'set DEMO_BADGES')}
${form('wipe_demo', '', 'wipe all demo chains', true)}</div>
<h2>Chains</h2>${chains}
<h2>Tunables</h2><table>${cfgRows}</table>
<h2>Danger</h2>${form('reset_all', '<input name=confirm placeholder="type RESET">', 'reset everything', true)}`;
}

export async function handleAdmin(req: Request, ip: string): Promise<Response> {
  const ok = authed(req, ip);
  if (ok === 'locked') return new Response('too many attempts, wait a minute', { status: 429 });
  if (!ok) return new Response('auth required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="pop-bin"' } });
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' };
  if (req.method === 'POST') {
    // Basic auth rides along on cross-site form posts, so require a same-origin Origin header.
    const origin = req.headers.get('origin');
    const host = req.headers.get('host');
    if (!origin || !host || new URL(origin).host !== host) return new Response('bad origin', { status: 403 });
    let msg: string | null;
    try {
      msg = await act(await req.formData());
    } catch (e) {
      console.error('admin action failed', e);
      msg = 'action failed';
    }
    if (msg) return new Response(await page(msg), { status: 400, headers });
    return new Response(null, { status: 303, headers: { location: new URL(req.url).pathname } });
  }
  await maybeEpoch();
  return new Response(await page(null), { headers });
}
