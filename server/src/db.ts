import { Database } from 'bun:sqlite';

export const db = new Database(process.env.DB_PATH ?? 'constellation.db', { create: true });
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
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
  last_round_ok INTEGER NOT NULL DEFAULT 0
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
`);
// ponytail: no epochs history table (doc marks it optional); add if you want charts.

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

export function cfg(): Config {
  const out: Record<string, unknown> = { ...DEFAULTS };
  for (const r of db.query('SELECT key, value FROM config').all() as { key: string; value: string }[]) {
    if (r.key in DEFAULTS) out[r.key] = JSON.parse(r.value);
  }
  return out as Config;
}

/** Validates the type against the default before storing. Returns an error string or null. */
export function setCfg(key: string, raw: string): string | null {
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
  if (key.endsWith('ROUND_EVERY') && (v as number) <= cfg().ROUND_WINDOW) return `${key} must exceed ROUND_WINDOW`;
  db.query('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(v));
  return null;
}

export interface Chain {
  id: number; name: string; display_name: string; genesis_badge: string; created_at: number;
  hashes: number; consensus_until: number; demo: number; round_override_at: number;
  next_height: number; last_round: number; last_round_ok: number;
}
export interface Block {
  badge_id: string; user_id: string; handle: string; chain_id: number | null; height: number | null;
  star: number; joined_at: number | null; bot: number; bot_linked: number; bot_by: string | null;
}
export interface Report {
  badge_id: string; at: number; nearby_json: string; clicks: number; round_id: number; round_clicks: number;
}

export const q = {
  chain: (id: number) => db.query('SELECT * FROM chains WHERE id = ?').get(id) as Chain | null,
  chainByName: (name: string) => db.query('SELECT * FROM chains WHERE name = ?').get(name) as Chain | null,
  chains: () => db.query('SELECT * FROM chains').all() as Chain[],
  block: (id: string) => db.query('SELECT * FROM blocks WHERE badge_id = ?').get(id) as Block | null,
  members: (chainId: number) =>
    db.query('SELECT * FROM blocks WHERE chain_id = ? ORDER BY height').all(chainId) as Block[],
  report: (id: string) => db.query('SELECT * FROM reports WHERE badge_id = ?').get(id) as Report | null,
};

/** Puts a badge in a chain at the next height. Caller checks capacity and isolation. */
export function addMember(chain: Chain, badge: string, user: string, handle: string, now: number): void {
  db.transaction(() => {
    db.query('UPDATE chains SET next_height = next_height + 1 WHERE id = ?').run(chain.id);
    db.query(`INSERT INTO blocks (badge_id, user_id, handle, chain_id, height, joined_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(badge_id) DO UPDATE SET user_id = excluded.user_id, handle = CASE WHEN excluded.handle = '' THEN handle ELSE excluded.handle END,
      chain_id = excluded.chain_id, height = excluded.height, joined_at = excluded.joined_at`)
      .run(badge, user, handle, chain.id, chain.next_height, now);
    db.query('DELETE FROM reports WHERE badge_id = ?').run(badge);
  })();
}

/** Removes a block from its chain; deletes the chain (and its bots) once no badge is left. */
export function removeMember(badge: string): void {
  const b = q.block(badge);
  if (!b || b.chain_id == null) return;
  db.transaction(() => {
    if (b.bot) db.query('DELETE FROM blocks WHERE badge_id = ?').run(badge);
    else db.query('UPDATE blocks SET chain_id = NULL, height = NULL WHERE badge_id = ?').run(badge);
    db.query('DELETE FROM reports WHERE badge_id = ?').run(badge);
    const left = db.query('SELECT COUNT(*) AS n FROM blocks WHERE chain_id = ? AND bot = 0').get(b.chain_id) as { n: number };
    if (left.n === 0) deleteChain(b.chain_id!);
  })();
}

export function deleteChain(id: number): void {
  db.transaction(() => {
    db.query('DELETE FROM blocks WHERE chain_id = ? AND bot = 1').run(id);
    db.query('DELETE FROM reports WHERE badge_id IN (SELECT badge_id FROM blocks WHERE chain_id = ?)').run(id);
    db.query('UPDATE blocks SET chain_id = NULL, height = NULL WHERE chain_id = ?').run(id);
    db.query('DELETE FROM join_requests WHERE chain_id = ?').run(id);
    db.query('DELETE FROM chains WHERE id = ?').run(id);
  })();
}
