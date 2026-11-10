// Storage: libSQL. Turso in production (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN), a local file otherwise.
// Serverless instances share nothing, so everything that must survive a request lives here.
import { createClient, type Client, type InStatement, type InValue, type ResultSet } from '@libsql/client';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,            -- normalized
  display_name TEXT NOT NULL,
  genesis_badge TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  hashes INTEGER NOT NULL DEFAULT 0,
  consensus_until INTEGER NOT NULL DEFAULT 0,
  demo INTEGER NOT NULL DEFAULT 0,
  round_override_at INTEGER NOT NULL DEFAULT 0,
  next_height INTEGER NOT NULL DEFAULT 0,   -- heights are never reused
  last_round INTEGER NOT NULL DEFAULT 0,    -- open time of the last round checked for consensus
  last_round_ok INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL DEFAULT ''       -- last epoch's links, canon, edges, hashrate, mult, rank
);
CREATE TABLE IF NOT EXISTS blocks (
  badge_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT '',
  handle TEXT NOT NULL DEFAULT '',
  chain_id INTEGER REFERENCES chains(id) ON DELETE SET NULL,
  height INTEGER,
  star INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER,
  bot INTEGER NOT NULL DEFAULT 0,
  bot_linked INTEGER NOT NULL DEFAULT 1,
  bot_by TEXT                                -- the badge a bot links to
);
CREATE INDEX IF NOT EXISTS blocks_chain ON blocks(chain_id);
CREATE TABLE IF NOT EXISTS reports (
  badge_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  nearby_json TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0,         -- accumulated since the last epoch
  round_id INTEGER NOT NULL DEFAULT 0,
  round_clicks INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS join_requests (joiner_badge TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, via_badge TEXT NOT NULL, handle TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS join_accepts (member_badge TEXT NOT NULL, joiner_badge TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (member_badge, joiner_badge));
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO meta (key, value) VALUES ('epoch_at', 0);
CREATE TABLE IF NOT EXISTS seen_requests (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
`;
// ponytail: no epochs history table (doc marks it optional); add if you want charts.

let client: Client | null = null;
let ready: Promise<void> | null = null;

async function conn(): Promise<Client> {
  if (!client) {
    client = createClient({
      url: process.env.TURSO_DATABASE_URL ?? process.env.DB_URL ?? 'file:pop-bin.db',
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  ready ??= client.executeMultiple(SCHEMA).catch((e: unknown) => { ready = null; throw e; });
  await ready;
  return client;
}

export async function run(sql: string, args: InValue[] = []): Promise<ResultSet> {
  return (await conn()).execute({ sql, args });
}
export async function all<T>(sql: string, args: InValue[] = []): Promise<T[]> {
  return (await run(sql, args)).rows as unknown as T[];
}
export async function one<T>(sql: string, args: InValue[] = []): Promise<T | null> {
  return (await all<T>(sql, args))[0] ?? null;
}
/** Runs the statements atomically, in order. */
export async function batch(stmts: InStatement[]): Promise<void> {
  if (stmts.length) await (await conn()).batch(stmts, 'write');
}

export const DEFAULTS = {
  EPOCH_SECONDS: 10,
  RSSI_LINK: -65,
  MAX_BLOCKS: 8,
  BASE_PER_LINK: 100,
  CLICK_HS: 2,
  CLICK_CAP: 50,
  ROUND_EVERY: 120,
  ROUND_WINDOW: 10,
  ROUND_CLICKS: 10,
  CONSENSUS_MULT: 3,
  REPORT_MAX_AGE: 15,
  JOIN_WINDOW: 60,
  DEMO_ENABLED: true,
  DEMO_BADGES: [] as string[],
  DEMO_BRIDGED_RSSI: -55,
  DEMO_ROUND_EVERY: 30,
  BOT_MAX: 7,
  BOT_CLICKS: 30,
  BOT_ROUND_P: 0.8,
};
export type Config = typeof DEFAULTS;

// ponytail: 5 s per-instance cache; an admin edit reaches every instance within 5 s.
let cfgCache: { at: number; v: Config } | null = null;

export async function cfg(): Promise<Config> {
  if (cfgCache && Date.now() - cfgCache.at < 5000) return cfgCache.v;
  const out: Record<string, unknown> = { ...DEFAULTS };
  for (const r of await all<{ key: string; value: string }>('SELECT key, value FROM config')) {
    if (r.key in DEFAULTS) out[r.key] = JSON.parse(r.value);
  }
  cfgCache = { at: Date.now(), v: out as Config };
  return cfgCache.v;
}

/** Validates the type against the default before storing. Returns an error string or null. */
export async function setCfg(key: string, raw: string): Promise<string | null> {
  if (!(key in DEFAULTS)) return `unknown key ${key}`;
  const def = DEFAULTS[key as keyof Config];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return `${key}: not JSON`;
  }
  const ok = Array.isArray(def)
    ? Array.isArray(v) && v.every((x) => typeof x === 'string')
    : typeof v === typeof def && (typeof v !== 'number' || Number.isFinite(v));
  if (!ok) return `${key}: expected ${Array.isArray(def) ? 'string[]' : typeof def}`;
  if (key === 'EPOCH_SECONDS' && (v as number) < 1) return 'EPOCH_SECONDS must be >= 1';
  if (key.endsWith('ROUND_EVERY') && (v as number) <= (await cfg()).ROUND_WINDOW) return `${key} must exceed ROUND_WINDOW`;
  await run('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(v)]);
  cfgCache = null;
  return null;
}

export interface Chain {
  id: number; name: string; display_name: string; genesis_badge: string; created_at: number;
  hashes: number; consensus_until: number; demo: number; round_override_at: number;
  next_height: number; last_round: number; last_round_ok: number; state_json: string;
}
export interface Block {
  badge_id: string; user_id: string; handle: string; chain_id: number | null; height: number | null;
  star: number; joined_at: number | null; bot: number; bot_linked: number; bot_by: string | null;
}
export interface Report {
  badge_id: string; at: number; nearby_json: string; clicks: number; round_id: number; round_clicks: number;
}

export const q = {
  chain: (id: number) => one<Chain>('SELECT * FROM chains WHERE id = ?', [id]),
  chainByName: (name: string) => one<Chain>('SELECT * FROM chains WHERE name = ?', [name]),
  chains: () => all<Chain>('SELECT * FROM chains'),
  block: (id: string) => one<Block>('SELECT * FROM blocks WHERE badge_id = ?', [id]),
  members: (chainId: number) => all<Block>('SELECT * FROM blocks WHERE chain_id = ? ORDER BY height', [chainId]),
  report: (id: string) => one<Report>('SELECT * FROM reports WHERE badge_id = ?', [id]),
};

/** Statements that put a badge in a chain at the next height. Caller checks capacity and isolation. */
export function addMemberStmts(chainId: number, badge: string, user: string, handle: string, now: number): InStatement[] {
  return [
    {
      sql: `INSERT INTO blocks (badge_id, user_id, handle, chain_id, height, joined_at)
        VALUES (?, ?, ?, ?, (SELECT next_height FROM chains WHERE id = ?), ?)
        ON CONFLICT(badge_id) DO UPDATE SET user_id = CASE WHEN excluded.user_id = '' THEN user_id ELSE excluded.user_id END,
        handle = CASE WHEN excluded.handle = '' THEN handle ELSE excluded.handle END,
        chain_id = excluded.chain_id, height = excluded.height, joined_at = excluded.joined_at`,
      args: [badge, user, handle, chainId, chainId, now],
    },
    { sql: 'UPDATE chains SET next_height = next_height + 1 WHERE id = ?', args: [chainId] },
    { sql: 'DELETE FROM reports WHERE badge_id = ?', args: [badge] },
  ];
}

export async function addMember(chainId: number, badge: string, user: string, handle: string, now: number): Promise<void> {
  await batch(addMemberStmts(chainId, badge, user, handle, now));
}

/** Removes a block from its chain; deletes the chain (and its bots) once no badge is left. */
export async function removeMember(badge: string): Promise<void> {
  const b = await q.block(badge);
  if (!b || b.chain_id == null) return;
  await batch([
    b.bot
      ? { sql: 'DELETE FROM blocks WHERE badge_id = ?', args: [badge] }
      : { sql: 'UPDATE blocks SET chain_id = NULL, height = NULL WHERE badge_id = ?', args: [badge] },
    { sql: 'DELETE FROM reports WHERE badge_id = ?', args: [badge] },
  ]);
  const left = await one<{ n: number }>('SELECT COUNT(*) AS n FROM blocks WHERE chain_id = ? AND bot = 0', [b.chain_id]);
  if (!left || left.n === 0) await deleteChain(b.chain_id);
}

export async function deleteChain(id: number): Promise<void> {
  await batch([
    { sql: 'DELETE FROM reports WHERE badge_id IN (SELECT badge_id FROM blocks WHERE chain_id = ?)', args: [id] },
    { sql: 'DELETE FROM blocks WHERE chain_id = ? AND bot = 1', args: [id] },
    { sql: 'UPDATE blocks SET chain_id = NULL, height = NULL WHERE chain_id = ?', args: [id] },
    { sql: 'DELETE FROM join_requests WHERE chain_id = ?', args: [id] },
    { sql: 'DELETE FROM chains WHERE id = ?', args: [id] },
  ]);
}
