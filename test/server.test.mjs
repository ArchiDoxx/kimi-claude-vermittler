// Integration: Vermittler-Server in-process gegen den Fake-Upstream.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { erzeugeServer, normalisiereKonfig } from '../vermittler.mjs';
import { leseProtokoll, sha12 } from '../lib/protokoll.mjs';
import { starteFakeUpstream, SSE_TEXT, JSON_ANTWORT } from './fake-upstream.mjs';
import { tempOrdner, TESTSCHLUESSEL } from './hilfen.mjs';

let fake;
let server;
let basis;
let logPfad;
let sitzungen;

const PREISE = { 'claude-opus-5-5': { input: 4, w5m: 5, w1h: 8, read: 0.2, output: 20 } };

before(async () => {
  fake = await starteFakeUpstream();
  logPfad = path.join(tempOrdner(), 'protokoll.jsonl');
  const konfig = normalisiereKonfig({ port: 1, upstream: fake.url, mode: 'ttl1h', logPath: logPfad, preise: PREISE }, process.cwd());
  const erg = erzeugeServer(konfig, { log: () => {} });
  server = erg.server;
  sitzungen = erg.sitzungen;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  basis = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await fake.schliessen();
});

// Roh-HTTP-Anfrage, damit Kopfzeilen und Body exakt kontrolliert werden.
function roh({ methode = 'POST', pfad = '/v1/messages', kopfzeilen = {}, body }) {
  return new Promise((resolve, reject) => {
    const url = new URL(pfad, basis);
    const req = http.request(url, { method: methode, headers: kopfzeilen, agent: false }, (res) => {
      const teile = [];
      res.on('data', (t) => teile.push(t));
      res.on('end', () => resolve({ status: res.statusCode, kopfzeilen: res.headers, body: Buffer.concat(teile) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

const STANDARD_KOPF = {
  'x-api-key': TESTSCHLUESSEL,
  'anthropic-version': '2023-06-01',
  'content-type': 'application/json',
};

function messagesBody(extra = {}) {
  return {
    model: 'claude-opus-5-5',
    max_tokens: 100,
    stream: true,
    metadata: { user_id: 'sitzung-integration' },
    system: [{ type: 'text', text: 'Sys', cache_control: { type: 'ephemeral' } }],
    tools: [{ name: 'cu', input_schema: { oneOf: [{ properties: { pid: { type: 'integer' } }, required: ['pid'] }, { properties: { app: { type: 'string' } } }] }, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hallo', cache_control: { type: 'ephemeral' } }] }],
    ...extra,
  };
}

function letzteUpstreamAnfrage() {
  return fake.anfragen[fake.anfragen.length - 1];
}

test('SSE wird bytegleich durchgereicht, T1 und T2 kommen beim Upstream an', async () => {
  const antwort = await roh({ kopfzeilen: STANDARD_KOPF, body: JSON.stringify(messagesBody()) });
  assert.equal(antwort.status, 200);
  assert.equal(antwort.body.toString('utf8'), SSE_TEXT);
  assert.ok(antwort.body.equals(Buffer.from(SSE_TEXT, 'utf8')));
  assert.equal(antwort.kopfzeilen['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(antwort.kopfzeilen['request-id'], 'req_fake_1');
  const oben = JSON.parse(letzteUpstreamAnfrage().body.toString('utf8'));
  assert.deepEqual(oben.system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(oben.tools[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.deepEqual(oben.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(oben.tools[0].input_schema.oneOf, undefined);
  assert.deepEqual(Object.keys(oben.tools[0].input_schema.properties), ['pid', 'app']);
});

test('SSE bei gzip-Antwort des Upstreams: entpackt und bytegleich, ohne content-encoding', async () => {
  const antwort = await roh({ pfad: '/v1/messages?szenario=sse&gzip=1', kopfzeilen: STANDARD_KOPF, body: JSON.stringify(messagesBody()) });
  assert.equal(antwort.status, 200);
  assert.equal(antwort.kopfzeilen['content-encoding'], undefined);
  assert.ok(antwort.body.equals(Buffer.from(SSE_TEXT, 'utf8')));
});

test('Kopfzeilen: Key, Authorization, Beta kommen an; host und Client-content-length nicht; content-length passt zum neuen Body', async () => {
  const body = JSON.stringify(messagesBody());
  await roh({
    pfad: '/v1/messages?beta=true',
    kopfzeilen: {
      ...STANDARD_KOPF,
      authorization: `Bearer ${TESTSCHLUESSEL}`,
      'anthropic-beta': 'fine-grained-tool-streaming-2025-05-14',
      'x-stainless-retry-count': '0',
      'accept-encoding': 'gzip, deflate, br',
      'x-unbekannt': 'weg',
      host: `localhost:${new URL(basis).port}`,
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
  });
  const oben = letzteUpstreamAnfrage();
  assert.equal(oben.pfad, '/v1/messages?beta=true');
  assert.equal(oben.kopfzeilen['x-api-key'], TESTSCHLUESSEL);
  assert.equal(oben.kopfzeilen.authorization, `Bearer ${TESTSCHLUESSEL}`);
  assert.equal(oben.kopfzeilen['anthropic-beta'], 'fine-grained-tool-streaming-2025-05-14');
  assert.equal(oben.kopfzeilen['x-stainless-retry-count'], '0');
  assert.equal(oben.kopfzeilen['accept-encoding'], 'identity');
  assert.equal(oben.kopfzeilen['x-unbekannt'], undefined);
  assert.equal(oben.kopfzeilen.host, new URL(fake.url).host, 'Upstream sieht seinen eigenen Host, nicht den des Clients');
  assert.equal(Number(oben.kopfzeilen['content-length']), oben.body.length);
  assert.notEqual(oben.body.length, Buffer.byteLength(body), 'Body wurde veraendert und neu bemessen');
});

test('Unveraenderter Body (nichts zu tun) geht bytegleich durch', async () => {
  const body = `{ "model":"claude-opus-5-5",  "max_tokens": 1, "messages": [{"role":"user","content":"x"}] }`;
  await roh({ kopfzeilen: STANDARD_KOPF, body });
  assert.equal(letzteUpstreamAnfrage().body.toString('utf8'), body);
});

test('Nicht parsbarer Body geht bytegleich durch', async () => {
  const body = Buffer.from('{"model": "claude-opus-5-5", kaputt ä', 'utf8');
  const antwort = await roh({ pfad: '/v1/messages?szenario=fehler400', kopfzeilen: STANDARD_KOPF, body });
  assert.equal(antwort.status, 400);
  assert.ok(letzteUpstreamAnfrage().body.equals(body));
});

test('count_tokens geht ohne T1 und T2 durch', async () => {
  const body = JSON.stringify(messagesBody({ stream: undefined }));
  const antwort = await roh({ pfad: '/v1/messages/count_tokens', kopfzeilen: STANDARD_KOPF, body });
  assert.equal(antwort.status, 200);
  assert.equal(letzteUpstreamAnfrage().body.toString('utf8'), body);
  const spiegel = JSON.parse(antwort.body.toString('utf8'));
  assert.equal(spiegel.pfad, '/v1/messages/count_tokens');
});

test('GET /v1/models laeuft als Durchgang ohne Body', async () => {
  const antwort = await roh({ methode: 'GET', pfad: '/v1/models?limit=5', kopfzeilen: { 'x-api-key': TESTSCHLUESSEL } });
  assert.equal(antwort.status, 200);
  const spiegel = JSON.parse(antwort.body.toString('utf8'));
  assert.equal(spiegel.methode, 'GET');
  assert.equal(spiegel.pfad, '/v1/models?limit=5');
  assert.equal(spiegel.laenge, 0);
});

for (const status of [400, 401, 429, 500]) {
  test(`Fehlerstatus ${status} geht 1:1 durch`, async () => {
    const antwort = await roh({ pfad: `/v1/messages?szenario=fehler${status}`, kopfzeilen: STANDARD_KOPF, body: JSON.stringify(messagesBody()) });
    assert.equal(antwort.status, status);
    assert.equal(antwort.kopfzeilen['retry-after'], '1');
    assert.deepEqual(JSON.parse(antwort.body.toString('utf8')).error.message, `Fake-Fehler ${status}`);
  });
}

test('stream:false: JSON-Antwort mit usage wird durchgereicht und protokolliert', async () => {
  const antwort = await roh({ pfad: '/v1/messages?szenario=json', kopfzeilen: STANDARD_KOPF, body: JSON.stringify(messagesBody({ stream: false, metadata: { user_id: 'json-sitzung' } })) });
  assert.deepEqual(JSON.parse(antwort.body.toString('utf8')), JSON_ANTWORT);
  const eintrag = leseProtokoll(logPfad).filter((z) => z.session === sha12('json-sitzung')).pop();
  assert.equal(eintrag.cache_read, 2000);
  assert.equal(eintrag.input, 5);
});

test('Protokoll: SSE-Anfrage traegt usage, Modus, Marken, Kosten; ohne Inhalte', async () => {
  const system = [{ type: 'text', text: 'Eigenes System fuer diesen Test', cache_control: { type: 'ephemeral' } }];
  await roh({ kopfzeilen: STANDARD_KOPF, body: JSON.stringify(messagesBody({ system, metadata: { user_id: 'protokoll-sitzung' } })) });
  const eintrag = leseProtokoll(logPfad).filter((z) => z.session === sha12('protokoll-sitzung')).pop();
  assert.equal(eintrag.art, 'anfrage');
  assert.equal(eintrag.modus, 'ttl1h');
  assert.equal(eintrag.status, 200);
  assert.equal(eintrag.input, 12);
  assert.equal(eintrag.cache_read, 3000);
  assert.equal(eintrag.cache_w1h, 1100);
  assert.equal(eintrag.output, 42);
  assert.equal(typeof eintrag.kosten, 'number');
  assert.equal(eintrag.warnung, undefined);
  const inhalt = fs.readFileSync(logPfad, 'utf8');
  assert.equal(inhalt.includes('Hallo'), false);
  assert.equal(inhalt.includes('protokoll-sitzung'), false);
});

test('Upstream-Abbruch mitten im Strom: Client sieht Fehler, Server laeuft weiter', async () => {
  await assert.rejects(roh({ pfad: '/v1/messages?szenario=abbruch', kopfzeilen: STANDARD_KOPF, body: JSON.stringify(messagesBody()) }));
  const health = await roh({ methode: 'GET', pfad: '/_vermittler/health' });
  assert.equal(health.status, 200);
});

test('Anfrage mit Origin-Kopfzeile wird abgewiesen', async () => {
  const antwort = await roh({ kopfzeilen: { ...STANDARD_KOPF, origin: 'https://boese.example' }, body: '{}' });
  assert.equal(antwort.status, 403);
  assert.equal(JSON.parse(antwort.body.toString('utf8')).type, 'error');
});

// ---------- Hook-Endpunkte ----------

test('health liefert ok, version, pid, mode, uptimeSec und Dienstkennung', async () => {
  const antwort = await roh({ methode: 'GET', pfad: '/_vermittler/health' });
  const h = JSON.parse(antwort.body.toString('utf8'));
  assert.equal(h.ok, true);
  assert.equal(h.dienst, 'anthropic-vermittler');
  assert.equal(h.pid, process.pid);
  assert.equal(h.mode, 'ttl1h');
  assert.equal(typeof h.version, 'string');
  assert.equal(typeof h.uptimeSec, 'number');
});

test('heartbeat, subagent-ende und session-ende pflegen den Sitzungszustand', async () => {
  const sid = 'hook-sitzung';
  const s = sha12(sid);
  await roh({ kopfzeilen: STANDARD_KOPF, body: JSON.stringify(messagesBody({ metadata: { user_id: sid } })) });
  await roh({ kopfzeilen: STANDARD_KOPF, body: JSON.stringify(messagesBody({ metadata: { user_id: sid }, system: 'Subagent' })) });
  assert.equal(Object.keys(sitzungen.zustand(s).schluessel).length, 2);
  assert.ok(Object.values(sitzungen.zustand(s).schluessel).every((k) => k.ersteByteMs !== null));

  const hb = await roh({ pfad: '/_vermittler/heartbeat', kopfzeilen: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: sid }) });
  assert.equal(hb.status, 200);
  assert.notEqual(sitzungen.zustand(s).letzterHeartbeatMs, null);

  const sub = await roh({ pfad: '/_vermittler/subagent-ende', kopfzeilen: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: sid }) });
  assert.equal(JSON.parse(sub.body.toString('utf8')).verworfen, 1);
  assert.equal(Object.keys(sitzungen.zustand(s).schluessel).length, 1);

  const ende = await roh({ pfad: '/_vermittler/session-ende', kopfzeilen: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: sid }) });
  assert.equal(ende.status, 200);
  assert.equal(sitzungen.zustand(s), null);
});

test('Hook-Endpunkte: fehlende session_id ergibt 400, unbekannter Pfad 404, falsche Methode 405', async () => {
  assert.equal((await roh({ pfad: '/_vermittler/heartbeat', body: '{}' })).status, 400);
  assert.equal((await roh({ pfad: '/_vermittler/heartbeat', body: 'kein json' })).status, 400);
  assert.equal((await roh({ pfad: '/_vermittler/gibtsnicht', body: '{}' })).status, 404);
  assert.equal((await roh({ methode: 'GET', pfad: '/_vermittler/heartbeat' })).status, 405);
  assert.equal((await roh({ methode: 'POST', pfad: '/_vermittler/health', body: '{}' })).status, 405);
});

test('Upstream nicht erreichbar ergibt 502 im Anthropic-Format ohne Key', async () => {
  const konfig = normalisiereKonfig({ port: 1, upstream: 'http://127.0.0.1:1', mode: 'ttl1h', logPath: path.join(tempOrdner(), 'p.jsonl'), preise: {} }, process.cwd());
  const { server: tot } = erzeugeServer(konfig, { log: () => {} });
  await new Promise((r) => tot.listen(0, '127.0.0.1', r));
  try {
    const antwort = await new Promise((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${tot.address().port}/v1/messages`, { method: 'POST', headers: STANDARD_KOPF, agent: false }, (res) => {
        const t = [];
        res.on('data', (x) => t.push(x));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(t).toString('utf8') }));
      });
      req.on('error', reject);
      req.end(JSON.stringify(messagesBody()));
    });
    assert.equal(antwort.status, 502);
    const fehler = JSON.parse(antwort.body);
    assert.equal(fehler.type, 'error');
    assert.equal(fehler.error.type, 'api_error');
    assert.equal(antwort.body.includes('TESTSCHLUESSEL'), false);
    assert.equal(antwort.body.includes('Hallo'), false);
  } finally {
    tot.closeAllConnections?.();
    await new Promise((r) => tot.close(r));
  }
});

// ---------- Iteration 3 ----------

// Anfrage mit frei gewaehltem Request-Target und Host (umgeht die URL-Normalisierung).
function rohZiel({ methode = 'POST', ziel, host, kopfzeilen = {}, body = '{}' }) {
  const port = Number(new URL(basis).port);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: ziel, method: methode, agent: false, setHost: host === undefined, headers: { ...kopfzeilen, ...(host !== undefined ? { host } : {}) } }, (res) => {
      const t = [];
      res.on('data', (x) => t.push(x));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(t).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('K1: Request-Target mit // oder absoluter URL ergibt 400, Upstream sieht nichts', async () => {
  for (const ziel of ['//example.invalid/v1/messages', 'http://example.invalid/v1/messages', '/\\example.invalid/v1/messages']) {
    const vorher = fake.anfragen.length;
    const antwort = await rohZiel({ ziel, kopfzeilen: STANDARD_KOPF, body: JSON.stringify(messagesBody()) });
    assert.equal(antwort.status, 400, ziel);
    assert.equal(JSON.parse(antwort.body).error.type, 'invalid_request_error');
    assert.equal(fake.anfragen.length, vorher, `Upstream erreicht: ${ziel}`);
  }
});

test('K4: Host ausserhalb von Loopback ergibt 403 vor jedem Routing; erlaubte Hosts gehen durch', async () => {
  const port = new URL(basis).port;
  for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${Number(port) + 1}`, '127.0.0.1']) {
    const antwort = await rohZiel({ methode: 'GET', ziel: '/_vermittler/health', host });
    assert.equal(antwort.status, 403, host);
  }
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
    const antwort = await rohZiel({ methode: 'GET', ziel: '/_vermittler/health', host });
    assert.equal(antwort.status, 200, host);
  }
});

test('K11: /_vermittler/constructor und toString sind unbekannte Endpunkte (404)', async () => {
  assert.equal((await roh({ methode: 'GET', pfad: '/_vermittler/constructor' })).status, 404);
  assert.equal((await roh({ pfad: '/_vermittler/toString', body: '{}' })).status, 404);
});

function eigenerServer(optionen = {}) {
  const konfig = normalisiereKonfig({ port: 1, upstream: fake.url, mode: 'ttl1h', logPath: path.join(tempOrdner(), 'p.jsonl'), preise: PREISE }, process.cwd());
  const meldungen = [];
  const erg = erzeugeServer(konfig, { log: (t) => meldungen.push(t), ...optionen });
  return new Promise((r) => erg.server.listen(0, '127.0.0.1', () => r({ ...erg, konfig, meldungen, port: erg.server.address().port })));
}

test('K12: Client-Abbruch waehrend fetch wird als abbruch mit CLIENT_WEG protokolliert, nicht als 502', async () => {
  const s = await eigenerServer();
  try {
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: s.port, path: '/v1/messages?szenario=langsam', method: 'POST', headers: STANDARD_KOPF, agent: false });
      req.on('error', () => resolve());
      req.end(JSON.stringify(messagesBody({ metadata: { user_id: 'abbruch-sitzung' } })));
      setTimeout(() => { req.destroy(); resolve(); }, 80);
    });
    const ende = Date.now() + 3000;
    let eintrag;
    while (!eintrag && Date.now() < ende) {
      await new Promise((r) => setTimeout(r, 50));
      eintrag = leseProtokoll(s.konfig.logPath).find((z) => z.session === sha12('abbruch-sitzung'));
    }
    assert.ok(eintrag, 'kein Protokolleintrag');
    assert.equal(eintrag.abbruch, true);
    assert.equal(eintrag.status, 0);
    assert.equal(s.meldungen.some((m) => m.includes('Upstream nicht erreichbar')), false);
    assert.ok(s.meldungen.some((m) => m.includes('CLIENT_WEG')));
  } finally {
    s.server.closeAllConnections();
    await new Promise((r) => s.server.close(r));
  }
});

test('K5: POST /_vermittler/stop antwortet, stoppt den Planer, schliesst den Server und ruft beende', async () => {
  let beendet = 0;
  const s = await eigenerServer({ beende: () => { beendet += 1; } });
  const antwort = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, path: '/_vermittler/stop', method: 'POST', agent: false }, (res) => {
      const t = [];
      res.on('data', (x) => t.push(x));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(t).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ pid: process.pid }));
  });
  assert.equal(antwort.status, 200);
  assert.equal(JSON.parse(antwort.body).ok, true);
  const ende = Date.now() + 3000;
  while (beendet === 0 && Date.now() < ende) await new Promise((r) => setTimeout(r, 20));
  assert.equal(beendet, 1);
  assert.equal(s.server.listening, false);
});

test('K5: GET /_vermittler/stop ist nicht erlaubt (405)', async () => {
  assert.equal((await roh({ methode: 'GET', pfad: '/_vermittler/stop' })).status, 405);
});

// ---------- Iteration 5 ----------

function post(port, pfad, body, kopfzeilen = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pfad, method: 'POST', headers: kopfzeilen, agent: false }, (res) => {
      const t = [];
      res.on('data', (x) => t.push(x));
      res.on('end', () => resolve({ status: res.statusCode, kopfzeilen: res.headers, body: Buffer.concat(t).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('K22: Stopp nur mit der eigenen pid im Body, sonst 409 und der Dienst laeuft weiter', async () => {
  let beendet = 0;
  const s = await eigenerServer({ beende: () => { beendet += 1; } });
  try {
    for (const body of ['{}', 'kein json', JSON.stringify({ pid: process.pid + 1 }), JSON.stringify({ pid: String(process.pid) })]) {
      const antwort = await post(s.port, '/_vermittler/stop', body);
      assert.equal(antwort.status, 409, body);
      assert.deepEqual(JSON.parse(antwort.body), { ok: false, fehler: 'pid passt nicht' });
    }
    assert.equal(beendet, 0);
    assert.equal(s.server.listening, true);
  } finally {
    s.server.closeAllConnections();
    await new Promise((r) => s.server.close(r));
  }
});

test('K25: health liefert konfigHash und version', async () => {
  const s = await eigenerServer();
  try {
    const h = JSON.parse((await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: s.port, path: '/_vermittler/health', agent: false }, (res) => {
        const t = [];
        res.on('data', (x) => t.push(x));
        res.on('end', () => resolve(Buffer.concat(t).toString('utf8')));
      }).on('error', reject);
    })));
    assert.equal(h.konfigHash, s.konfig.konfigHash);
    assert.match(h.version, /^\d+\.\d+\.\d+$/);
  } finally {
    s.server.closeAllConnections();
    await new Promise((r) => s.server.close(r));
  }
});

test('K27: zu grosser Body ergibt beim Client 413 (Antwort vor dem Schliessen), Upstream sieht nichts', async () => {
  const s = await eigenerServer({ maxBody: 1024 });
  try {
    const vorher = fake.anfragen.length;
    const antwort = await post(s.port, '/v1/messages', 'x'.repeat(64 * 1024), STANDARD_KOPF);
    assert.equal(antwort.status, 413);
    assert.equal(antwort.kopfzeilen.connection, 'close');
    assert.equal(JSON.parse(antwort.body).error.type, 'request_too_large');
    const hook = await post(s.port, '/_vermittler/heartbeat', JSON.stringify({ session_id: 'x'.repeat(70 * 1024) }));
    assert.equal(hook.status, 413);
    assert.equal(fake.anfragen.length, vorher);
  } finally {
    s.server.closeAllConnections();
    await new Promise((r) => s.server.close(r));
  }
});

test('K28: wirft die Weiterleitung, schliesst finally den Protokolleintrag (Status 0, abbruch)', async () => {
  const s = await eigenerServer({ weiterleiten: async () => { throw new Error('kaputt'); } });
  try {
    const antwort = await post(s.port, '/v1/messages', JSON.stringify(messagesBody({ metadata: { user_id: 'wurf-sitzung' } })), STANDARD_KOPF);
    assert.equal(antwort.status, 500);
    const eintrag = leseProtokoll(s.konfig.logPath).find((z) => z.session === sha12('wurf-sitzung'));
    assert.ok(eintrag, 'kein Protokolleintrag');
    assert.equal(eintrag.status, 0);
    assert.equal(eintrag.abbruch, true);
  } finally {
    s.server.closeAllConnections();
    await new Promise((r) => s.server.close(r));
  }
});

test('K33/K46: maxConnections 256', async () => {
  const s = await eigenerServer();
  try {
    assert.equal(s.server.maxConnections, 256);
  } finally {
    await new Promise((r) => s.server.close(r));
  }
});

// ---------- Iteration 6 ----------

test('K44: waehrend des Stopps antwortet bearbeite mit 503 overloaded_error und connection close', async () => {
  const s = await eigenerServer({ beende: () => {} });
  s.stoppeSauber();
  const antwort = await new Promise((resolve) => {
    const res = {
      headersSent: false,
      writeHead(status, kopf) { this.status = status; this.kopf = kopf; this.headersSent = true; },
      end(text) { resolve({ status: this.status, kopf: this.kopf, text }); },
      destroy() {},
    };
    const req = { method: 'GET', url: '/_vermittler/health', headers: { host: `127.0.0.1:${s.port}` }, socket: { localPort: s.port } };
    s.server.emit('request', req, res);
  });
  assert.equal(antwort.status, 503);
  assert.equal(antwort.kopf.connection, 'close');
  assert.equal(JSON.parse(antwort.text).error.type, 'overloaded_error');
});

test('K45: heartbeat fuer unbekannte Session ergibt 200 ohne Wirkung', async () => {
  const s = await eigenerServer();
  try {
    const antwort = await post(s.port, '/_vermittler/heartbeat', JSON.stringify({ session_id: 'nie-gesehen' }));
    assert.equal(antwort.status, 200);
    assert.equal(JSON.parse(antwort.body).bekannt, false);
    assert.equal(s.sitzungen.zustand(sha12('nie-gesehen')), null);
    assert.equal(s.sitzungen.anzahl(), 0);
  } finally {
    s.server.closeAllConnections();
    await new Promise((r) => s.server.close(r));
  }
});

test('K47: wirft auch protokoll.ende, wird der Ursprungsfehler gemeldet, nicht der des Protokolls', async () => {
  const echtes = { beginn: () => ({ startMs: 0 }), ende: () => { throw Object.assign(new Error('platte'), { code: 'PROTOKOLL' }); }, durchgang: () => {}, ping: () => {} };
  const s = await eigenerServer({ protokoll: echtes, weiterleiten: async () => { throw Object.assign(new Error('weg'), { code: 'URSPRUNG' }); } });
  try {
    const antwort = await post(s.port, '/v1/messages', JSON.stringify(messagesBody()), STANDARD_KOPF);
    assert.equal(antwort.status, 500);
    assert.ok(s.meldungen.some((m) => m.includes('Interner Fehler (URSPRUNG)')), s.meldungen.join(' | '));
    assert.ok(s.meldungen.some((m) => m.includes('Protokoll-Abschluss fehlgeschlagen (PROTOKOLL)')), s.meldungen.join(' | '));
  } finally {
    s.server.closeAllConnections();
    await new Promise((r) => s.server.close(r));
  }
});

test('K49: Request-Targets mit /./ oder /../ ergeben 400, Upstream sieht nichts', async () => {
  for (const ziel of ['/v1/./messages', '/v1/../v1/messages', '/v1/messages/..', '/v1/messages/.', '/./v1/messages']) {
    const vorher = fake.anfragen.length;
    const antwort = await rohZiel({ ziel, kopfzeilen: STANDARD_KOPF, body: JSON.stringify(messagesBody()) });
    assert.equal(antwort.status, 400, ziel);
    assert.equal(fake.anfragen.length, vorher, ziel);
  }
});
