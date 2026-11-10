// Badge API (/v1/*). Every request is verified with fromBadge(); the badge id is the identity.
import { fromBadge } from './auth';
import { addMember, cfg, db, q, removeMember, type Chain, type Config } from './db';
import { fmtHashes, roundAt, stateFor, type NearbyEntry } from './game';

export const APP_ID = process.env.APP_ID ?? 'constellation';
const MAX_BODY = 4096;

interface Caller { badge: string; user: string; demo: boolean; body: Record<string, unknown>; now: number; c: Config }

const json = (data: unknown, status = 200): Response => Response.json(data, { status });
const err = (status: number, error: string): Response => json({ error }, status);

export const isDemo = (badge: string, c: Config): boolean =>
  c.DEMO_ENABLED && (badge.startsWith('e') || c.DEMO_BADGES.includes(badge));

/** "  Zero   Sum " -> "zero sum". */
export const normalize = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);
const int = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null;
const handleOf = (v: unknown): string => (typeof v === 'string' && /^@[A-Za-z0-9_]{1,15}$/.test(v) ? v : '');

/** Validated nearby entries: at most 7, well-formed only. */
export function cleanNearby(v: unknown): NearbyEntry[] {
  if (!Array.isArray(v)) return [];
  const out: NearbyEntry[] = [];
  for (const e of v.slice(0, 7)) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    const id = str(o.id, 32);
    const rssi = int(o.rssi, -127, 0);
    if (!id || rssi === null) continue;
    const sim = int(o.sim, -127, 0);
    out.push({ id, rssi, bridged: o.bridged === true, ...(sim !== null ? { sim } : {}) });
  }
  return out;
}

function myChain(badge: string): Chain | null {
  const b = q.block(badge);
  return b?.chain_id != null ? q.chain(b.chain_id) : null;
}

function ensureBlock(me: Caller): void {
  db.query(`INSERT INTO blocks (badge_id, user_id, handle) VALUES (?, ?, ?)
    ON CONFLICT(badge_id) DO UPDATE SET user_id = excluded.user_id,
    handle = CASE WHEN excluded.handle = '' THEN handle ELSE excluded.handle END`)
    .run(me.badge, me.user, handleOf(me.body.handle));
}

/** Join matching: a request and an accept from a member of the requested chain, both fresh. */
function tryMatch(joiner: string, now: number, c: Config): boolean {
  const r = db.query('SELECT * FROM join_requests WHERE joiner_badge = ? AND at >= ?').get(joiner, now - c.JOIN_WINDOW) as
    { chain_id: number; handle: string } | null;
  if (!r) return false;
  // ponytail: any member's accept matches, not only `via`'s. Same trust (a member said yes), fewer dropped joins.
  const a = db.query(`SELECT a.member_badge FROM join_accepts a JOIN blocks b ON b.badge_id = a.member_badge
    WHERE a.joiner_badge = ? AND a.at >= ? AND b.chain_id = ? AND b.bot = 0`).get(joiner, now - c.JOIN_WINDOW, r.chain_id);
  if (!a) return false;
  const ch = q.chain(r.chain_id);
  const jb = q.block(joiner);
  if (!ch || jb?.chain_id != null || q.members(ch.id).length >= c.MAX_BLOCKS) return false;
  db.transaction(() => {
    addMember(ch, joiner, jb?.user_id ?? '', r.handle, now);
    db.query('DELETE FROM join_requests WHERE joiner_badge = ?').run(joiner);
    db.query('DELETE FROM join_accepts WHERE joiner_badge = ?').run(joiner);
  })();
  return true;
}

function meResponse(me: Caller): Response {
  const b = q.block(me.badge);
  const ch = myChain(me.badge);
  return json({
    block: b && ch ? { h: b.height, star: b.star } : null,
    chain: ch ? ch.display_name : null,
    state: ch ? stateFor(ch, me.badge, me.now) : null,
    demo: me.demo,
    config: {
      epoch: me.c.EPOCH_SECONDS, max_blocks: me.c.MAX_BLOCKS, round_clicks: me.c.ROUND_CLICKS, consensus_mult: me.c.CONSENSUS_MULT,
      round_window: me.c.ROUND_WINDOW, round_every: me.demo ? me.c.DEMO_ROUND_EVERY : me.c.ROUND_EVERY,
    },
  });
}

type Handler = (me: Caller, path: string[]) => Response;

const routes: Record<string, Handler> = {
  'GET me': meResponse,

  'POST chains': (me) => {
    const raw = str(me.body.name, 64);
    const name = raw ? normalize(raw) : '';
    if (name.length < 3 || name.length > 16 || !/^[\x20-\x7e]+$/.test(name)) return err(400, 'name must be 3-16 characters');
    if (myChain(me.badge)) return err(409, 'in chain');
    if (q.chainByName(name)) return err(409, 'exists');
    const id = Number(db.query(`INSERT INTO chains (name, display_name, genesis_badge, created_at, demo, last_round)
      VALUES (?, ?, ?, ?, ?, ?)`).run(name, name.toUpperCase(), me.badge, me.now, me.demo ? 1 : 0, me.now).lastInsertRowid);
    addMember(q.chain(id)!, me.badge, me.user, handleOf(me.body.handle), me.now);
    return meResponse(me);
  },

  'GET chains': (me, path) => {
    const ch = q.chainByName(normalize(decodeURIComponent(path[1] ?? '')));
    if (!ch || !!ch.demo !== me.demo) return json({ exists: false });
    return json({ exists: true, name: ch.display_name, size: q.members(ch.id).length, max: me.c.MAX_BLOCKS });
  },

  'POST join/request': (me) => {
    const ch = q.chainByName(normalize(str(me.body.chain, 64) ?? ''));
    const via = str(me.body.via, 32);
    if (!ch || !!ch.demo !== me.demo) return err(404, 'no such chain');
    if (myChain(me.badge)) return err(409, 'in chain');
    if (q.members(ch.id).length >= me.c.MAX_BLOCKS) return err(409, 'full');
    if (!via || q.block(via)?.chain_id !== ch.id) return err(400, 'via is not a member');
    db.query(`INSERT INTO join_requests (joiner_badge, chain_id, via_badge, handle, at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(joiner_badge) DO UPDATE SET chain_id = excluded.chain_id, via_badge = excluded.via_badge, handle = excluded.handle, at = excluded.at`)
      .run(me.badge, ch.id, via, handleOf(me.body.handle), me.now);
    return json({ ok: true, joined: tryMatch(me.badge, me.now, me.c) });
  },

  'POST join/accept': (me) => {
    const joiner = str(me.body.joiner, 32);
    if (!joiner) return err(400, 'joiner required');
    if (!myChain(me.badge)) return err(403, 'not a member');
    db.query(`INSERT INTO join_accepts (member_badge, joiner_badge, at) VALUES (?, ?, ?)
      ON CONFLICT(member_badge, joiner_badge) DO UPDATE SET at = excluded.at`).run(me.badge, joiner, me.now);
    db.query('DELETE FROM join_accepts WHERE at < ?').run(me.now - me.c.JOIN_WINDOW);
    return json({ ok: true, joined: tryMatch(joiner, me.now, me.c) });
  },

  'POST leave': (me) => {
    removeMember(me.badge);
    return json({ ok: true });
  },

  'POST star': (me) => {
    const star = int(me.body.star, 0, 5);
    if (star === null) return err(400, 'star must be 0-5');
    db.query('UPDATE blocks SET star = ? WHERE badge_id = ?').run(star, me.badge);
    return json({ ok: true });
  },

  'POST report': (me) => {
    const ch = myChain(me.badge);
    if (!ch) return err(409, 'not in a chain');
    const nearby = cleanNearby(me.body.nearby);
    const clicks = int(me.body.clicks, 0, 10_000) ?? 0;
    const rd = (me.body.round ?? {}) as Record<string, unknown>;
    const rid = int(rd.id, 0, 2 ** 31 - 1) ?? 0;
    const rclicks = int(rd.clicks, 0, 10_000) ?? 0;
    // Clicks accumulate until the epoch consumes them; round clicks keep the best count per round.
    db.query(`INSERT INTO reports (badge_id, at, nearby_json, clicks, round_id, round_clicks) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(badge_id) DO UPDATE SET at = excluded.at, nearby_json = excluded.nearby_json,
        clicks = MIN(reports.clicks + excluded.clicks, 10000),
        round_clicks = CASE WHEN excluded.round_id = 0 THEN reports.round_clicks
          WHEN excluded.round_id = reports.round_id THEN MAX(reports.round_clicks, excluded.round_clicks)
          ELSE excluded.round_clicks END,
        round_id = CASE WHEN excluded.round_id = 0 THEN reports.round_id ELSE excluded.round_id END`)
      .run(me.badge, me.now, JSON.stringify(nearby), clicks, rid, rclicks);
    return json(stateFor(ch, me.badge, me.now));
  },

  'GET board': (me) => {
    const mine = myChain(me.badge)?.id;
    const rows = db.query('SELECT id, display_name, hashes FROM chains WHERE demo = ? ORDER BY hashes DESC, id ASC LIMIT 10')
      .all(me.demo ? 1 : 0) as { id: number; display_name: string; hashes: number }[];
    return json({ demo: me.demo, rows: rows.map((r, i) => ({ rank: i + 1, name: r.display_name, hashes: fmtHashes(r.hashes), mine: r.id === mine })) });
  },

  // ---- demo (§9): demo badges only, demo chains only ----
  'POST demo/join': (me) => {
    const ch = q.chainByName(normalize(str(me.body.chain, 64) ?? ''));
    if (!ch || !ch.demo) return err(404, 'no such demo chain');
    if (myChain(me.badge)) return err(409, 'in chain');
    if (q.members(ch.id).length >= me.c.MAX_BLOCKS) return err(409, 'full');
    ensureBlock(me);
    addMember(ch, me.badge, me.user, handleOf(me.body.handle), me.now);
    return meResponse(me);
  },

  'POST demo/bots': (me) => {
    const ch = myChain(me.badge);
    if (!ch?.demo) return err(409, 'not in a demo chain');
    const bots = q.members(ch.id).filter((m) => m.bot);
    const op = me.body.op;
    if (op === 'add') {
      if (bots.length >= me.c.BOT_MAX || q.members(ch.id).length >= me.c.MAX_BLOCKS) return err(409, 'full');
      const used = new Set(bots.map((b) => b.handle));
      let n = 1;
      while (used.has(`@bot${n}`)) n++;
      const id = `bot-${n}-${ch.id}`;
      db.query('DELETE FROM blocks WHERE badge_id = ?').run(id);
      db.query('INSERT INTO blocks (badge_id, handle, star, bot, bot_by) VALUES (?, ?, ?, 1, ?)').run(id, `@bot${n}`, n % 6, me.badge);
      addMember(q.chain(ch.id)!, id, '', `@bot${n}`, me.now);
    } else if (op === 'remove') {
      const id = str(me.body.bot, 32) ?? bots.at(-1)?.badge_id;
      if (!id || !bots.some((b) => b.badge_id === id)) return err(404, 'no such bot');
      removeMember(id);
    } else if (op === 'toggle_link') {
      const id = str(me.body.bot, 32);
      const targets = id ? bots.filter((b) => b.badge_id === id) : bots; // no bot named: all of them
      for (const b of targets) {
        const on = typeof me.body.on === 'boolean' ? me.body.on : !b.bot_linked;
        db.query('UPDATE blocks SET bot_linked = ? WHERE badge_id = ?').run(on ? 1 : 0, b.badge_id);
      }
    } else return err(400, 'op must be add, remove or toggle_link');
    return json(stateFor(q.chain(ch.id)!, me.badge, me.now));
  },

  'POST demo/round': (me) => {
    const ch = myChain(me.badge);
    if (!ch?.demo) return err(409, 'not in a demo chain');
    db.query('UPDATE chains SET round_override_at = ? WHERE id = ?').run(me.now + 3, ch.id);
    return json({ ok: true, round: { at: roundAt(q.chain(ch.id)!, me.now, me.c), len: me.c.ROUND_WINDOW } });
  },

  'POST demo/reset': (me) => {
    const ch = myChain(me.badge);
    if (!ch?.demo) return err(409, 'not in a demo chain');
    db.query('UPDATE chains SET hashes = 0 WHERE id = ?').run(ch.id);
    return json({ ok: true });
  },
};

export async function handleV1(req: Request, url: URL): Promise<Response> {
  const body = req.method === 'GET' ? '' : await req.text();
  if (body.length > MAX_BODY) return err(413, 'body too big');
  const who = await fromBadge(req, body, APP_ID);
  if (!who || !who.badge) return err(403, 'bad signature');
  const c = cfg();
  const path = url.pathname.replace(/^\/v1\//, '').split('/');
  const demo = isDemo(who.badge, c);
  if (path[0] === 'demo' && !demo) return err(403, 'demo badges only');
  let parsed: Record<string, unknown> = {};
  if (body) {
    try {
      const v = JSON.parse(body);
      if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v;
    } catch {
      return err(400, 'bad json');
    }
  }
  const key = path[0] === 'chains' && req.method === 'GET' ? 'GET chains'
    : `${req.method} ${path[0] === 'join' || path[0] === 'demo' ? path.slice(0, 2).join('/') : path[0]}`;
  const route = routes[key];
  if (!route) return err(404, 'not found');
  const me: Caller = { badge: who.badge, user: who.user, demo, body: parsed, now: Math.floor(Date.now() / 1000), c };
  ensureBlock(me);
  try {
    return route(me, path);
  } catch (e) {
    console.error('v1 error', key, who.badge, e);
    return err(500, 'server error');
  }
}

