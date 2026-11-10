// Scoring: links, canonical chain, hashrate, rounds. Pure functions first, then the epoch loop.
import { all, batch, cfg, q, run, type Block, type Chain, type Config, type Report } from './db';
import type { InStatement } from '@libsql/client';

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

// ---- epochs ----
// No timers on serverless: the first request after an epoch boundary claims it (an atomic UPDATE on
// meta.epoch_at) and scores every chain. Badges report every 10 s, so epochs keep pace with play.

export interface ChainState { linked: string[]; canon: string[]; edges: [number, number][]; hashrate: number; mult: number; rank: number }

export function parseState(ch: Chain): ChainState | null {
  if (!ch.state_json) return null;
  try {
    return JSON.parse(ch.state_json);
  } catch {
    return null;
  }
}

function parseNearby(r: Report): NearbyEntry[] {
  try {
    return JSON.parse(r.nearby_json);
  } catch {
    return [];
  }
}

const now_s = (): number => Math.floor(Date.now() / 1000);

/** Runs an epoch if one is due and no other instance claimed it. */
export async function maybeEpoch(now: number = now_s()): Promise<void> {
  const c = await cfg();
  const claim = await run("UPDATE meta SET value = ? WHERE key = 'epoch_at' AND value <= ?", [now, now - c.EPOCH_SECONDS]);
  if (claim.rowsAffected === 1) await runEpoch(now, Math.random, c);
}

export async function runEpoch(now: number = now_s(), rand: () => number = Math.random, cfgIn?: Config): Promise<void> {
  const c = cfgIn ?? (await cfg());
  const [chains, blocks, reports] = await Promise.all([
    q.chains(),
    all<Block>('SELECT * FROM blocks WHERE chain_id IS NOT NULL ORDER BY height'),
    all<Report>('SELECT * FROM reports'),
  ]);
  const byChain = new Map<number, Block[]>();
  for (const b of blocks) byChain.set(b.chain_id!, [...(byChain.get(b.chain_id!) ?? []), b]);
  const reportOf = new Map(reports.map((r) => [r.badge_id, r]));

  const stmts: InStatement[] = [];
  const results: { ch: Chain; state: ChainState; hashes: number }[] = [];
  for (const ch of chains) {
    const members = byChain.get(ch.id) ?? [];
    const nearby = new Map<string, NearbyEntry[]>();
    for (const m of members) {
      const r = reportOf.get(m.badge_id);
      if (!m.bot && r && r.at >= now - c.REPORT_MAX_AGE) nearby.set(m.badge_id, parseNearby(r));
    }
    const links = computeLinks(members, nearby, !!ch.demo, c);
    const { canon, edges } = canonical(members, links);

    // Consensus for a round that just ended.
    let until = ch.consensus_until;
    const ended = lastEndedRound(ch, now, c);
    if (ended > ch.last_round) {
      const ok = canon.length >= 2 && canon.every((m) => {
        if (m.bot) return rand() < c.BOT_ROUND_P;
        const r = reportOf.get(m.badge_id);
        return !!r && r.round_id === ended && r.round_clicks >= c.ROUND_CLICKS;
      });
      if (ok) until = Math.ceil((ended + c.ROUND_WINDOW) / every(ch, c)) * every(ch, c);
      stmts.push({ sql: 'UPDATE chains SET last_round = ?, last_round_ok = ?, consensus_until = ? WHERE id = ?', args: [ended, ok ? 1 : 0, until, ch.id] });
    }

    const mult = now < until ? c.CONSENSUS_MULT : 1;
    const clicks = canon.map((m) => (m.bot ? Math.floor(rand() * (c.BOT_CLICKS + 1)) : nearby.has(m.badge_id) ? reportOf.get(m.badge_id)!.clicks : 0));
    const hr = hashrate(canon.length, clicks, mult, c);
    const linked = new Set<string>();
    for (const k of links) for (const id of k.split('|')) linked.add(id);
    results.push({
      ch,
      hashes: ch.hashes + hr * c.EPOCH_SECONDS,
      state: { linked: [...linked], canon: canon.map((m) => m.badge_id), edges, hashrate: hr, mult, rank: 0 },
    });
    // Every member's clicks are spent this epoch, counted or not (orphans mine nothing).
    for (const m of members) {
      const r = reportOf.get(m.badge_id);
      if (r && r.clicks > 0) stmts.push({ sql: 'UPDATE reports SET clicks = MAX(0, clicks - ?) WHERE badge_id = ?', args: [r.clicks, m.badge_id] });
    }
  }

  // Rank within each world (real / demo) by hashes.
  const next = [1, 1];
  for (const r of [...results].sort((a, b) => b.hashes - a.hashes || a.ch.id - b.ch.id)) r.state.rank = next[r.ch.demo ? 1 : 0]++;
  for (const r of results) {
    stmts.push({ sql: 'UPDATE chains SET hashes = hashes + ?, state_json = ? WHERE id = ?', args: [r.hashes - r.ch.hashes, JSON.stringify(r.state), r.ch.id] });
  }
  stmts.push({ sql: 'DELETE FROM seen_requests WHERE at < ?', args: [now - 120] });
  stmts.push({ sql: 'DELETE FROM join_requests WHERE at < ?', args: [now - c.JOIN_WINDOW] });
  stmts.push({ sql: 'DELETE FROM join_accepts WHERE at < ?', args: [now - c.JOIN_WINDOW] });
  await batch(stmts);
}

/** The chain screen's state for one badge (the /v1/report response). */
export async function stateFor(chainId: number, badge: string, now: number, c: Config): Promise<Record<string, unknown> | null> {
  const [ch, members] = await Promise.all([q.chain(chainId), q.members(chainId)]);
  if (!ch) return null;
  const s = parseState(ch);
  const linked = new Set(s?.linked), canon = new Set(s?.canon);
  return {
    chain: ch.display_name,
    blocks: members.map((m) => ({
      id: m.badge_id, h: m.height, handle: m.handle, star: m.star,
      linked: linked.has(m.badge_id), canon: canon.has(m.badge_id),
    })),
    edges: s?.edges ?? [],
    hashrate: fmtRate(s?.hashrate ?? 0),
    mult: s?.mult ?? 1,
    hashes: fmtHashes(ch.hashes),
    rank: s?.rank ?? 0,
    orphaned: members.length > 1 && !!s && !canon.has(badge),
    round: { at: roundAt(ch, now, c), len: c.ROUND_WINDOW },
    last: { at: ch.last_round, ok: !!ch.last_round_ok },
  };
}
