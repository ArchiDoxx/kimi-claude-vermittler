// Integration Stufe 2: Server in-process im Modus ping, injizierte Uhr, Fake-Upstream.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { erzeugeServer, normalisiereKonfig } from '../vermittler.mjs';
import { leseProtokoll, sha12 } from '../lib/protokoll.mjs';
import { starteFakeUpstream } from './fake-upstream.mjs';
import { tempOrdner, TESTSCHLUESSEL } from './hilfen.mjs';

let fake;
let server;
let planer;
let basis;
let logPfad;
let ms = Date.parse('2026-10-11T10:00:00Z');
const vor = (sek) => { ms += sek * 1000; };

before(async () => {
  fake = await starteFakeUpstream();
  logPfad = path.join(tempOrdner(), 'protokoll.jsonl');
  const konfig = normalisiereKonfig({
    port: 1, upstream: fake.url, mode: 'ttl1h', modeByModel: { 'claude-opus-5-5': 'ping' }, logPath: logPfad,
    ping: { intervalSec: 240, maxIdleMin: 60, heartbeatGraceSec: 180 },
    preise: { 'claude-opus-5-5': { input: 4, w5m: 5, w1h: 8, read: 0.2, output: 20 } },
  }, process.cwd());
  const erg = erzeugeServer(konfig, { log: () => {}, jetzt: () => ms, pingTimer: false });
  server = erg.server;
  planer = erg.planer;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  basis = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await fake.schliessen();
});

function roh({ methode = 'POST', pfad = '/v1/messages', kopfzeilen = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(pfad, basis), { method: methode, headers: kopfzeilen, agent: false }, (res) => {
      const t = [];
      res.on('data', (x) => t.push(x));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(t).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

const KOPF = {
  'x-api-key': TESTSCHLUESSEL,
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
  'content-type': 'application/json',
};

function body(sid, extra = {}) {
  return {
    model: 'claude-opus-5-5', max_tokens: 2000, stream: true, metadata: { user_id: sid },
    thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'high' },
    system: [{ type: 'text', text: `System ${sid}`, cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'cu', input_schema: { oneOf: [{ properties: { pid: {} }, required: ['pid'] }] } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hallo', cache_control: { type: 'ephemeral' } }] }],
    ...extra,
  };
}

async function health() {
  return JSON.parse((await roh({ methode: 'GET', pfad: '/_vermittler/health' })).body);
}

function pings() {
  return fake.anfragen.filter((a) => {
    try {
      return JSON.parse(a.body.toString('utf8')).max_tokens === 0;
    } catch {
      return false;
    }
  });
}

async function hook(name, sid) {
  return roh({ pfad: `/_vermittler/${name}`, kopfzeilen: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: sid }) });
}

test('Echte Anfrage, Uhr +241 s, Tick: Fake sieht den Ping mit max_tokens 0, stream false, gleichem Key und gleichem gesendeten Body', async () => {
  const antwort = await roh({ pfad: '/v1/messages?beta=true', kopfzeilen: KOPF, body: JSON.stringify(body('P1')) });
  assert.equal(antwort.status, 200);
  const echt = fake.anfragen[fake.anfragen.length - 1];
  assert.equal((await health()).pingSchluessel, 1);
  vor(241);
  await hook('heartbeat', 'P1'); // K16: ohne frischen Heartbeat kein Ping
  await planer.pruefe();
  const p = pings();
  assert.equal(p.length, 1);
  const ping = p[0];
  assert.equal(ping.pfad, '/v1/messages?beta=true');
  assert.equal(ping.kopfzeilen['x-api-key'], TESTSCHLUESSEL);
  assert.equal(ping.kopfzeilen['anthropic-beta'], KOPF['anthropic-beta']);
  assert.equal(Number(ping.kopfzeilen['content-length']), ping.body.length);
  const pj = JSON.parse(ping.body.toString('utf8'));
  const ej = JSON.parse(echt.body.toString('utf8'));
  assert.equal(pj.stream, false);
  const { max_tokens: _a, stream: _b, ...pRest } = pj;
  const { max_tokens: _c, stream: _d, ...eRest } = ej;
  assert.deepEqual(pRest, eRest, 'gleich dem tatsaechlich gesendeten (geglaetteten) Body');
  assert.equal(pj.tools[0].input_schema.oneOf, undefined);
  const zeile = leseProtokoll(logPfad).find((z) => z.art === 'ping');
  assert.equal(zeile.status, 200);
  assert.equal(zeile.cache_read, 2000);
  assert.equal(zeile.session, sha12('P1'));
  assert.equal(fs.readFileSync(logPfad, 'utf8').includes('TESTSCHLUESSEL'), false);
});

test('session-ende ueber den Hook-Endpunkt beendet die Pings', async () => {
  await roh({ kopfzeilen: KOPF, body: JSON.stringify(body('P2')) });
  const vorher = pings().length;
  assert.equal((await hook('session-ende', 'P2')).status, 200);
  vor(241);
  await planer.pruefe();
  const neu = pings().slice(vorher).filter((a) => JSON.parse(a.body.toString('utf8')).metadata.user_id === 'P2');
  assert.equal(neu.length, 0);
});

test('subagent-ende ueber den Hook-Endpunkt verwirft den Nebenschluessel im Planer', async () => {
  await roh({ kopfzeilen: KOPF, body: JSON.stringify(body('P3')) });
  await roh({ kopfzeilen: KOPF, body: JSON.stringify(body('P3', { system: 'Subagent' })) });
  const vorher = planer.anzahl();
  const antwort = JSON.parse((await hook('subagent-ende', 'P3')).body);
  assert.equal(antwort.verworfen, 1);
  assert.equal(planer.anzahl(), vorher - 1);
});

test('Kein Ping-Schluessel bei Fehlerantwort, Ausschluss oder anderem Modus', async () => {
  const vorher = planer.anzahl();
  await roh({ pfad: '/v1/messages?szenario=fehler500', kopfzeilen: KOPF, body: JSON.stringify(body('P4')) });
  await roh({ kopfzeilen: KOPF, body: JSON.stringify(body('P5', { thinking: { type: 'enabled', budget_tokens: 1024 } })) });
  await roh({ kopfzeilen: KOPF, body: JSON.stringify(body('P6', { model: 'claude-sonnet-5-5' })) });
  assert.equal(planer.anzahl(), vorher);
});

test('Server-Schliessen stoppt den Planer-Timer (kein offener Handle)', async () => {
  const konfig = normalisiereKonfig({ port: 1, upstream: fake.url, mode: 'ping', logPath: path.join(tempOrdner(), 'p.jsonl') }, process.cwd());
  const { server: s } = erzeugeServer(konfig, { log: () => {} });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  await new Promise((r) => s.close(r));
});
