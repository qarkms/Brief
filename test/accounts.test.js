import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../server/index.js';

async function start() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echad-acct-'));
  const s = createServer({ dataDir });
  await new Promise((r) => s.server.listen(0, r));
  const base = `http://127.0.0.1:${s.server.address().port}/api/account`;
  const call = async (route, { method = 'POST', body, auth, type, raw } = {}) => {
    const headers = {};
    if (auth) headers['x-echad-account'] = auth;
    if (body !== undefined) headers['content-type'] = type || 'application/json';
    const res = await fetch(`${base}/${route}`, {
      method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  const stop = async () => {
    s.server.closeAllConnections?.();
    await new Promise((r) => s.server.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { s, call, stop, dataDir };
}

test('계정: 만들기 → 데이터 저장 → 다른 기기에서 로그인하면 그대로', async () => {
  const { call, stop, dataDir } = await start();
  const key = 'k'.repeat(32);
  const made = await call('signup', { body: { id: 'Drum_Minsu', password: 'secret12', key } });
  assert.equal(made.status, 200);
  assert.equal(made.body.id, 'drum_minsu', '아이디는 소문자로');
  assert.equal(made.body.key, key, '지금 기기의 키가 계정 열쇠가 된다');
  const auth = made.body.token;

  // 같은 아이디는 대소문자가 달라도 못 만든다
  assert.equal((await call('signup', { body: { id: 'DRUM_minsu', password: 'secret12' } })).status, 409);
  assert.equal((await call('signup', { body: { id: 'ab', password: 'secret12' } })).body.error, 'BAD_ID');
  assert.equal((await call('signup', { body: { id: 'abc', password: '123' } })).body.error, 'BAD_PASSWORD');

  // 비밀번호는 저장 파일에 없다
  const files = fs.readdirSync(path.join(dataDir, 'accounts')).filter((f) => f.endsWith('.json'));
  const raw = fs.readFileSync(path.join(dataDir, 'accounts', files[0]), 'utf8');
  assert.ok(!raw.includes('secret12'));

  // 데이터 저장: 판(rev)이 맞아야 저장된다
  const v1 = await call('vault?base=0', { method: 'PUT', auth, body: { 'brief.name': '"민수"' } });
  assert.deepEqual(v1.body, { rev: 1 });
  const stale = await call('vault?base=0', { method: 'PUT', auth, body: { x: 1 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.rev, 1);

  // 악보 그림
  const id = 'a'.repeat(32);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  assert.equal((await call(`blob/${id}`, { method: 'PUT', auth, body: png, raw: true, type: 'image/png' })).status, 200);
  assert.equal((await call(`blob/${id}`, { method: 'PUT', auth: 'x', body: png, raw: true, type: 'image/png' })).status, 401);
  assert.equal((await call(`blob/${'b'.repeat(32)}`, { method: 'PUT', auth, body: png, raw: true, type: 'text/html' })).body.error, 'BAD_TYPE');

  // 다른 기기: 로그인 → 같은 열쇠·데이터·그림
  const other = await call('login', { body: { id: 'drum_minsu', password: 'secret12' } });
  assert.equal(other.status, 200);
  assert.equal(other.body.key, key);
  const vault = await call('vault', { method: 'GET', auth: other.body.token });
  assert.deepEqual(vault.body, { id: 'drum_minsu', rev: 1, data: { 'brief.name': '"민수"' } });
  assert.deepEqual((await call('blobs', { method: 'GET', auth: other.body.token })).body.ids, [id]);
  const got = await call(`blob/${id}`, { method: 'GET', auth: other.body.token });
  assert.deepEqual(got.body, png);

  // 로그아웃하면 그 토큰은 못 쓴다
  await call('logout', { auth: other.body.token });
  assert.equal((await call('vault', { method: 'GET', auth: other.body.token })).status, 401);

  // 비밀번호 바꾸기: 다른 기기 로그인은 풀리고, 새 비밀번호로만
  assert.equal((await call('password', { auth, body: { current: 'wrong!!', next: 'newpass1' } })).status, 401);
  const changed = await call('password', { auth, body: { current: 'secret12', next: 'newpass1' } });
  assert.equal(changed.status, 200);
  assert.equal((await call('vault', { method: 'GET', auth })).status, 401);
  assert.equal((await call('login', { body: { id: 'drum_minsu', password: 'secret12' } })).status, 401);
  const relog = await call('login', { body: { id: 'drum_minsu', password: 'newpass1' } });
  assert.equal(relog.status, 200);

  // 계정 지우기
  assert.equal((await call('delete', { auth: relog.body.token, body: { password: 'newpass1' } })).status, 200);
  assert.equal((await call('login', { body: { id: 'drum_minsu', password: 'newpass1' } })).status, 401);
  assert.equal((await call('signup', { body: { id: 'drum_minsu', password: 'another1' } })).status, 200, '지운 아이디는 다시 쓸 수 있다');
  await stop();
});

test('계정: 비밀번호를 연달아 틀리면 잠시 막힌다', async () => {
  const { call, stop } = await start();
  await call('signup', { body: { id: 'guitar', password: 'right123' } });
  for (let i = 0; i < 5; i++) assert.equal((await call('login', { body: { id: 'guitar', password: `wrong${i}xx` } })).status, 401);
  const blocked = await call('login', { body: { id: 'guitar', password: 'right123' } });
  assert.equal(blocked.status, 429, '맞는 비밀번호도 잠시 기다려야 한다');
  assert.ok(blocked.body.retryAfter > 0);
  await stop();
});

test('계정: 서버 디스크가 지워져도 바깥 저장소에서 돌아온다', async () => {
  // RemoteStore와 같은 모양의 메모리 저장소
  const objects = new Map();
  const remote = {
    async get(name) { return objects.has(name) ? { buf: objects.get(name), type: 'x' } : null; },
    putLatest(name, body) { objects.set(name, Buffer.from(body)); return Promise.resolve(); },
    async remove(names) { for (const n of names) objects.delete(n); },
    async flush() {},
  };
  const run = async (fn) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'echad-acct-'));
    const s = createServer({ dataDir, remote });
    await new Promise((r) => s.server.listen(0, r));
    const base = `http://127.0.0.1:${s.server.address().port}/api/account`;
    try {
      await fn(base);
    } finally {
      s.server.closeAllConnections?.();
      await new Promise((r) => s.server.close(r));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
  const post = (base, route, body, auth) => fetch(`${base}/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { 'x-echad-account': auth } : {}) }, body: JSON.stringify(body),
  });
  await run(async (base) => {
    const { token } = await (await post(base, 'signup', { id: 'keys', password: 'piano123' })).json();
    await fetch(`${base}/vault?base=0`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-echad-account': token }, body: '{"a":"1"}' });
    await fetch(`${base}/blob/${'c'.repeat(32)}`, { method: 'PUT', headers: { 'content-type': 'image/jpeg', 'x-echad-account': token }, body: Buffer.from([1, 2]) });
  });
  await run(async (base) => {
    const res = await post(base, 'login', { id: 'keys', password: 'piano123' });
    assert.equal(res.status, 200);
    const { token } = await res.json();
    const v = await (await fetch(`${base}/vault`, { headers: { 'x-echad-account': token } })).json();
    assert.deepEqual(v.data, { a: '1' });
    const blob = await fetch(`${base}/blob/${'c'.repeat(32)}`, { headers: { 'x-echad-account': token } });
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()), Buffer.from([1, 2]));
  });
});
