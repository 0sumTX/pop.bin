import { beforeAll, describe, expect, test } from 'bun:test';

process.env.DB_PATH = ':memory:';
const { keys } = await import('../src/auth');
const { handleV1, APP_ID, normalize } = await import('../src/api');
const { runEpoch, canonical, hashrate, fmtRate, fmtHashes, roundAt, lastEndedRound, states } = await import('../src/game');
const { DEFAULTS, q, db } = await import('../src/db');

const KEY_ID = 'testkey';
let priv: CryptoKey;
beforeAll(async () => {
  const kp = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
  priv = kp.privateKey;
  keys.set(KEY_ID, kp.publicKey);
});

let reqN = 0;
async function call(badge: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const url = `https://game.test/v1/${path}`;
  const text = body === undefined ? '' : JSON.stringify(body);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const time = String(Date.now());
  const rid = `r${++reqN}`;
  const signed = ['badge-http-v1', method, url, hash, APP_ID, badge, `u-${badge}`, time, rid].join('\n');
  const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('Ed25519', priv, new TextEncoder().encode(signed)))));
  const headers = {
    'x-badge-app': APP_ID, 'x-badge-id': badge, 'x-badge-user': `u-${badge}`, 'x-badge-time': time,
    'x-badge-request': rid, 'x-badge-key': KEY_ID, 'x-badge-signature': sig, 'content-type': 'application/json',
  };
  const req = new Request(url, { method, headers, body: text || undefined });
  const res = await handleV1(req, new URL(url));
  return { status: res.status, data: await res.json() };
}

const near = (...ids: [string, number, boolean?][]) => ids.map(([id, rssi, bridged]) => ({ id, rssi, bridged: !!bridged }));

describe('pure scoring', () => {
  test('normalize', () => expect(normalize('  Zero   Sum ')).toBe('zero sum'));
  test('hashrate formula', () => {
    expect(hashrate(1, [50], 1, DEFAULTS)).toBe(0);
    expect(hashrate(3, [10, 60, 0], 1, DEFAULTS)).toBe(200 + 2 * (10 + 50));
    expect(hashrate(2, [0, 0], 3, DEFAULTS)).toBe(300);
  });
  test('formatting', () => {
    expect(fmtRate(1400)).toBe('1.40 kH/s');
    expect(fmtRate(420)).toBe('420 H/s');
    expect(fmtHashes(1_234_567)).toBe('1.2M');
  });
  test('canonical: largest group, tie to lowest height', () => {
    const b = (id: string, h: number) => ({ badge_id: id, height: h }) as any;
    const m = [b('a', 0), b('b', 1), b('c', 2), b('d', 3)];
    expect(canonical(m, new Set(['a|b', 'c|d'])).canon.map((x) => x.badge_id)).toEqual(['a', 'b']);
    const r = canonical(m, new Set(['c|d', 'b|c']));
    expect(r.canon.map((x) => x.badge_id)).toEqual(['b', 'c', 'd']);
    expect(r.edges).toEqual([[1, 2], [2, 3]]);
    expect(canonical(m, new Set()).canon).toEqual([]);
  });
  test('round timing', () => {
    const ch = { demo: 0, round_override_at: 0 } as any;
    expect(roundAt(ch, 1205, DEFAULTS)).toBe(1200);
    expect(roundAt(ch, 1211, DEFAULTS)).toBe(1320);
    expect(lastEndedRound(ch, 1215, DEFAULTS)).toBe(1200);
    expect(roundAt({ ...ch, round_override_at: 1250 }, 1248, DEFAULTS)).toBe(1250);
  });
});

describe('api flow', () => {
  test('rejects a bad signature', async () => {
    const req = new Request('https://game.test/v1/me', { headers: { 'x-badge-app': APP_ID } });
    expect((await handleV1(req, new URL(req.url))).status).toBe(403);
  });

  test('create, join, link, orphan, consensus', async () => {
    expect((await call('A1', 'POST', 'chains', { name: '  Zero  Sum ', handle: '@alice' })).data.chain).toBe('ZERO SUM');
    expect((await call('B1', 'POST', 'chains', { name: 'zero sum' })).status).toBe(409);
    expect((await call('A1', 'POST', 'chains', { name: 'other' })).data.error).toBe('in chain');

    // B joins via A: request + accept.
    expect((await call('B1', 'POST', 'join/request', { chain: 'ZERO SUM', via: 'A1', handle: '@bob' })).data.joined).toBe(false);
    expect((await call('A1', 'POST', 'join/accept', { joiner: 'B1' })).data.joined).toBe(true);
    // C joins via B (any member can accept).
    await call('C1', 'POST', 'join/request', { chain: 'zero sum', via: 'B1' });
    await call('B1', 'POST', 'join/accept', { joiner: 'C1' });
    const me = await call('C1', 'GET', 'me');
    expect(me.data.block.h).toBe(2);
    expect(me.data.demo).toBe(false);

    // A<->B strong, C only heard one way: canonical = {A, B}; C orphaned.
    await call('A1', 'POST', 'report', { nearby: near(['B1', -50], ['C1', -80]), clicks: 100 });
    await call('B1', 'POST', 'report', { nearby: near(['A1', -50]), clicks: 5 });
    await call('C1', 'POST', 'report', { nearby: near(['A1', -50]), clicks: 5 });
    runEpoch();
    const s = (await call('C1', 'POST', 'report', { nearby: near(['A1', -50]) })).data;
    expect(s.orphaned).toBe(true);
    expect(s.edges).toEqual([[0, 1]]);
    expect(s.hashrate).toBe(fmtRate(100 + 2 * (50 + 5))); // A capped at 50; C's clicks don't count
    const id = q.chainByName('zero sum')!.id;
    expect(states.get(id)!.hashrate).toBe(210);

    // Bridged entries never link real badges.
    await call('A1', 'POST', 'report', { nearby: near(['B1', 0, true]) });
    await call('B1', 'POST', 'report', { nearby: near(['A1', 0, true]) });
    runEpoch();
    expect(states.get(id)!.canon.size).toBe(0);

    // Consensus: both canonical blocks clicked enough in the round that just ended.
    db.query('UPDATE chains SET last_round = 0 WHERE id = ?').run(id); // chain predates that round
    const t = Math.floor(Date.now() / 1000);
    const ended = Math.floor((t - 10) / 120) * 120;
    await call('A1', 'POST', 'report', { nearby: near(['B1', -50]), round: { id: ended, clicks: 10 } });
    await call('B1', 'POST', 'report', { nearby: near(['A1', -50]), round: { id: ended, clicks: 12 } });
    runEpoch(t);
    expect(states.get(id)!.mult).toBe(3);
    expect((await call('A1', 'POST', 'report', { nearby: near(['B1', -50]) })).data.last).toEqual({ at: ended, ok: true });

    // Board, leave.
    const board = (await call('A1', 'GET', 'board')).data;
    expect(board.rows[0]).toMatchObject({ rank: 1, name: 'ZERO SUM', mine: true });
    await call('C1', 'POST', 'leave');
    expect((await call('C1', 'GET', 'me')).data.chain).toBe(null);
  });

  test('demo isolation, bots, sim signal', async () => {
    expect((await call('A1', 'POST', 'demo/round')).status).toBe(403); // real badge
    const made = await call('e123', 'POST', 'chains', { name: 'testnet' });
    expect(made.data.demo).toBe(true);
    // Real badges can't see or join demo chains.
    expect((await call('D1', 'GET', 'chains/testnet')).data.exists).toBe(false);
    expect((await call('D1', 'POST', 'join/request', { chain: 'testnet', via: 'e123' })).status).toBe(404);
    // Demo join is instant; bridged entries link with sim signal.
    expect((await call('e456', 'POST', 'demo/join', { chain: 'testnet' })).data.chain).toBe('TESTNET');
    await call('e123', 'POST', 'demo/bots', { op: 'add' });
    await call('e123', 'POST', 'report', { nearby: [{ id: 'e456', rssi: 0, bridged: true, sim: -55 }] });
    await call('e456', 'POST', 'report', { nearby: [{ id: 'e123', rssi: 0, bridged: true }] }); // DEMO_BRIDGED_RSSI
    runEpoch();
    const id = q.chainByName('testnet')!.id;
    expect(states.get(id)!.canon.size).toBe(3);
    // Weak sim breaks the link; bot still linked to e123.
    await call('e123', 'POST', 'report', { nearby: [{ id: 'e456', rssi: 0, bridged: true, sim: -90 }] });
    runEpoch();
    expect([...states.get(id)!.canon].sort()).toEqual([`bot-1-${id}`, 'e123']);
    await call('e123', 'POST', 'demo/bots', { op: 'toggle_link', on: false });
    runEpoch();
    expect(states.get(id)!.canon.size).toBe(0);
    // Demo board shows only demo chains.
    const board = (await call('e456', 'GET', 'board')).data;
    expect(board.rows.map((r: any) => r.name)).toEqual(['TESTNET']);
    // Forced round opens in 3 s.
    const r = (await call('e123', 'POST', 'demo/round')).data;
    expect(r.round.at - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(3);
  });
});
