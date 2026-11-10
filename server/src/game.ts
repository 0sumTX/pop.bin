// Scoring: links, canonical chain, hashrate, rounds. Pure functions first, then the epoch loop.
import { cfg, db, q, type Block, type Chain, type Config, type Report } from './db';

export interface NearbyEntry { id: string; rssi: number; bridged: boolean; sim?: number }

/** Signal A reported for B, or null if it must not count (bridged outside demo chains). */
export function signal(e: NearbyEntry, demo: boolean, c: Config): number | null {
  if (!e.bridged) return e.rssi;
  if (!demo) return null;
  return e.sim ?? c.DEMO_BRIDGED_RSSI;
}

/** Undirected links between members: both saw each other at or above RSSI_LINK. Keys "a|b", a < b. */
export function computeLinks(
  members: Block[], nearby: Map<string, NearbyEntry[]>, demo: boolean, c: Config,
): Set<string> {
  const ids = new Set(members.map((m) => m.badge_id));
  const sees = new Set<string>(); // "a>b": a saw b strongly
  for (const [a, list] of nearby) {
    for (const e of list) {
      const s = signal(e, demo, c);
      if (s !== null && s >= c.RSSI_LINK && ids.has(e.id) && e.id !== a) sees.add(`${a}>${e.id}`);
    }
  }
  const out = new Set<string>();
  for (const k of sees) {
    const [a, b] = k.split('>');
    if (sees.has(`${b}>${a}`)) out.add(a < b ? `${a}|${b}` : `${b}|${a}`);
  }
  // Demo bots: linked to the badge that added it whenever that badge reported this epoch.
  for (const m of members) {
    if (m.bot && m.bot_linked && m.bot_by && nearby.has(m.bot_by) && ids.has(m.bot_by)) {
      out.add(m.badge_id < m.bot_by ? `${m.badge_id}|${m.bot_by}` : `${m.bot_by}|${m.badge_id}`);
    }
  }
  return out;
}

/** Largest connected group (tie: the one holding the lowest height). Empty if it has < 2 blocks. */
export function canonical(members: Block[], links: Set<string>): { canon: Block[]; edges: [number, number][] } {
  const adj = new Map<string, string[]>(members.map((m) => [m.badge_id, []]));
  for (const k of links) {
    const [a, b] = k.split('|');
    adj.get(a)?.push(b);
    adj.get(b)?.push(a);
  }
  const byId = new Map(members.map((m) => [m.badge_id, m]));
  const sorted = [...members].sort((x, y) => x.height! - y.height!);
  const done = new Set<string>();
  let best: { ids: string[]; edges: [number, number][] } = { ids: [], edges: [] };
  for (const root of sorted) { // ascending height, so ties keep the lowest-height group
    if (done.has(root.badge_id)) continue;
    const ids = [root.badge_id];
    const edges: [number, number][] = [];
    done.add(root.badge_id);
    for (let i = 0; i < ids.length; i++) { // BFS = spanning tree
      const nbrs = [...adj.get(ids[i])!].sort((x, y) => byId.get(x)!.height! - byId.get(y)!.height!);
      for (const n of nbrs) {
        if (done.has(n)) continue;
        done.add(n);
        ids.push(n);
        edges.push([byId.get(ids[i])!.height!, byId.get(n)!.height!]);
      }
    }
    if (ids.length > best.ids.length) best = { ids, edges };
  }
  if (best.ids.length < 2) return { canon: [], edges: [] };
  return { canon: best.ids.map((id) => byId.get(id)!), edges: best.edges };
}

export function hashrate(n: number, clicks: number[], mult: number, c: Config): number {
  if (n < 2) return 0;
  const base = c.BASE_PER_LINK * (n - 1);
  const cl = c.CLICK_HS * clicks.reduce((s, k) => s + Math.min(Math.max(0, k), c.CLICK_CAP), 0);
  return (base + cl) * mult;
}

function scale(n: number, units: string[], digits: number): string {
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return (i === 0 ? String(Math.round(n)) : n.toFixed(digits)) + units[i];
}
export const fmtHashes = (n: number): string => scale(n, ['', 'K', 'M', 'B', 'T', 'P'], 1);
export const fmtRate = (n: number): string => scale(n, [' H/s', ' kH/s', ' MH/s', ' GH/s'], 2);

const every = (ch: Chain, c: Config): number => (ch.demo ? c.DEMO_ROUND_EVERY : c.ROUND_EVERY);

/** Open time of the current round, or the next one if none is open. */
export function roundAt(ch: Chain, now: number, c: Config): number {
  const e = every(ch, c), w = c.ROUND_WINDOW;
  const cur = Math.floor(now / e) * e;
  const regular = now < cur + w ? cur : cur + e;
  const o = ch.round_override_at;
  return o && now < o + w && o < regular ? o : regular;
}

/** Open time of the most recent round whose window has ended. */
export function lastEndedRound(ch: Chain, now: number, c: Config): number {
  const e = every(ch, c), w = c.ROUND_WINDOW;
  const regular = Math.floor((now - w) / e) * e;
  const o = ch.round_override_at;
  return o && o + w <= now ? Math.max(regular, o) : regular;
}

// ---- epoch loop ----

export interface ChainState { linked: Set<string>; canon: Set<string>; edges: [number, number][]; hashrate: number; mult: number; rank: number }
export const states = new Map<number, ChainState>();

function parseNearby(r: Report): NearbyEntry[] {
  try {
    return JSON.parse(r.nearby_json);
  } catch {
    return [];
  }
}

export function runEpoch(now: number = Math.floor(Date.now() / 1000), rand: () => number = Math.random): void {
  const c = cfg();
  db.transaction(() => {
    for (const ch of q.chains()) {
      const members = q.members(ch.id);
      const nearby = new Map<string, NearbyEntry[]>();
      const reports = new Map<string, Report>();
      for (const m of members) {
        if (m.bot) continue;
        const r = q.report(m.badge_id);
        if (!r) continue;
        reports.set(m.badge_id, r);
        if (r.at >= now - c.REPORT_MAX_AGE) nearby.set(m.badge_id, parseNearby(r));
      }
      const links = computeLinks(members, nearby, !!ch.demo, c);
      const { canon, edges } = canonical(members, links);

      // Consensus for a round that just ended.
      const ended = lastEndedRound(ch, now, c);
      if (ended > ch.last_round) {
        const ok = canon.length >= 2 && canon.every((m) => {
          if (m.bot) return rand() < c.BOT_ROUND_P;
          const r = reports.get(m.badge_id);
          return !!r && r.round_id === ended && r.round_clicks >= c.ROUND_CLICKS;
        });
        const e = every(ch, c);
        const until = ok ? Math.ceil((ended + c.ROUND_WINDOW) / e) * e : ch.consensus_until;
        db.query('UPDATE chains SET last_round = ?, last_round_ok = ?, consensus_until = ? WHERE id = ?')
          .run(ended, ok ? 1 : 0, until, ch.id);
        ch.consensus_until = until;
      }

      const mult = now < ch.consensus_until ? c.CONSENSUS_MULT : 1;
      const clicks = canon.map((m) => (m.bot ? Math.floor(rand() * (c.BOT_CLICKS + 1)) : nearby.has(m.badge_id) ? reports.get(m.badge_id)!.clicks : 0));
      const hr = hashrate(canon.length, clicks, mult, c);
      if (hr > 0) db.query('UPDATE chains SET hashes = hashes + ? WHERE id = ?').run(hr * c.EPOCH_SECONDS, ch.id);
      const linked = new Set<string>();
      for (const k of links) for (const id of k.split('|')) linked.add(id);
      states.set(ch.id, { linked, canon: new Set(canon.map((m) => m.badge_id)), edges, hashrate: hr, mult, rank: 0 });
    }
    db.query('UPDATE reports SET clicks = 0').run();
  })();
  for (const id of states.keys()) if (!q.chain(id)) states.delete(id);
  rankAll();
}

/** Rank within each world (real / demo) by hashes. */
export function rankAll(): void {
  const rows = db.query('SELECT id, demo FROM chains ORDER BY hashes DESC, id ASC').all() as { id: number; demo: number }[];
  const next = [1, 1];
  for (const r of rows) {
    const s = states.get(r.id);
    const rank = next[r.demo ? 1 : 0]++;
    if (s) s.rank = rank;
  }
}

/** The chain screen's state for one badge (the /v1/report response). */
export function stateFor(ch: Chain, badge: string, now: number): Record<string, unknown> {
  const c = cfg();
  const s = states.get(ch.id);
  const members = q.members(ch.id);
  const fresh = q.chain(ch.id) ?? ch;
  return {
    chain: fresh.display_name,
    blocks: members.map((m) => ({
      id: m.badge_id, h: m.height, handle: m.handle, star: m.star,
      linked: !!s?.linked.has(m.badge_id), canon: !!s?.canon.has(m.badge_id),
    })),
    edges: s?.edges ?? [],
    hashrate: fmtRate(s?.hashrate ?? 0),
    mult: s?.mult ?? 1,
    hashes: fmtHashes(fresh.hashes),
    rank: s?.rank ?? 0,
    orphaned: members.length > 1 && !!s && !s.canon.has(badge),
    round: { at: roundAt(fresh, now, c), len: c.ROUND_WINDOW },
    last: { at: fresh.last_round, ok: !!fresh.last_round_ok },
  };
}
