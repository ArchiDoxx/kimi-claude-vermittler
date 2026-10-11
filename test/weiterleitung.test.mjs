import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anfrageKopfzeilen, antwortKopfzeilen, erzeugeSseLeser, fehlerKoerper } from '../lib/weiterleitung.mjs';
import { SSE_TEXT } from './fake-upstream.mjs';
import { TESTSCHLUESSEL } from './hilfen.mjs';

test('anfrageKopfzeilen: Allowlist durch, Blocklist raus, accept-encoding identity', () => {
  const ein = {
    'x-api-key': TESTSCHLUESSEL,
    authorization: `Bearer ${TESTSCHLUESSEL}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'a,b',
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': 'Anthropic/JS 0.95.2',
    'x-stainless-retry-count': '0',
    'x-stainless-os': 'Windows',
    host: '127.0.0.1:37790',
    connection: 'keep-alive',
    'content-length': '123',
    'transfer-encoding': 'chunked',
    'keep-alive': 'timeout=5',
    'proxy-authorization': 'x',
    'accept-encoding': 'gzip, br',
    'x-sonstiges': 'nein',
    cookie: 'nein',
  };
  const aus = anfrageKopfzeilen(ein);
  assert.deepEqual(aus, {
    'x-api-key': TESTSCHLUESSEL,
    authorization: `Bearer ${TESTSCHLUESSEL}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'a,b',
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': 'Anthropic/JS 0.95.2',
    'x-stainless-retry-count': '0',
    'x-stainless-os': 'Windows',
    'accept-encoding': 'identity',
  });
  assert.equal(ein['accept-encoding'], 'gzip, br', 'Eingabe unveraendert');
});

test('anfrageKopfzeilen: Mehrfachwerte werden zusammengefuegt', () => {
  assert.equal(anfrageKopfzeilen({ 'anthropic-beta': ['a', 'b'] })['anthropic-beta'], 'a, b');
});

test('antwortKopfzeilen: entfernt content-encoding, content-length, transfer-encoding, connection; behaelt den Rest', () => {
  const h = new Headers({
    'content-type': 'text/event-stream',
    'content-encoding': 'gzip',
    'content-length': '10',
    'transfer-encoding': 'chunked',
    connection: 'keep-alive',
    'keep-alive': 'timeout=5',
    'request-id': 'req_1',
  });
  h.append('set-cookie', 'a=1');
  h.append('set-cookie', 'b=2');
  const aus = antwortKopfzeilen(h);
  assert.equal(aus['content-type'], 'text/event-stream');
  assert.equal(aus['request-id'], 'req_1');
  assert.deepEqual(aus['set-cookie'], ['a=1', 'b=2']);
  for (const weg of ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']) {
    assert.equal(aus[weg], undefined, weg);
  }
});

test('SSE-Leser: liest usage aus message_start und message_delta, auch bei zerstueckelten Zeilen', () => {
  const leser = erzeugeSseLeser();
  for (let i = 0; i < SSE_TEXT.length; i += 13) leser.fuettere(SSE_TEXT.slice(i, i + 13));
  leser.schliesse();
  assert.deepEqual(leser.usage(), {
    input_tokens: 12,
    cache_creation_input_tokens: 1100,
    cache_read_input_tokens: 3000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1100 },
    output_tokens: 42,
  });
});

test('SSE-Leser: CRLF-Zeilenenden und kaputte JSON-Zeilen werden vertragen', () => {
  const leser = erzeugeSseLeser();
  leser.fuettere('data: {kaputt\r\n\r\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\r\n\r\n');
  leser.schliesse();
  assert.deepEqual(leser.usage(), { input_tokens: 3 });
});

test('SSE-Leser ohne usage liefert null', () => {
  const leser = erzeugeSseLeser();
  leser.fuettere('event: ping\ndata: {"type":"ping"}\n\n');
  leser.schliesse();
  assert.equal(leser.usage(), null);
});

test('fehlerKoerper: Anthropic-Fehlerformat', () => {
  assert.deepEqual(JSON.parse(fehlerKoerper('Upstream nicht erreichbar')), {
    type: 'error', error: { type: 'api_error', message: 'Upstream nicht erreichbar' },
  });
});

// ---------- Iteration 3 ----------
import http from 'node:http';
import { zielUrl, schreibe, leiteWeiter, istSichererPfad } from '../lib/weiterleitung.mjs';
import { starteFakeUpstream } from './fake-upstream.mjs';

test('K1: zielUrl verkettet statt aufzuloesen; istSichererPfad', () => {
  assert.equal(zielUrl('https://api.anthropic.com', '/v1/messages?beta=true'), 'https://api.anthropic.com/v1/messages?beta=true');
  assert.equal(zielUrl('http://127.0.0.1:9/', '/v1/models'), 'http://127.0.0.1:9/v1/models');
  assert.equal(zielUrl('http://127.0.0.1:9///', '/v1/models'), 'http://127.0.0.1:9/v1/models');
  assert.equal(new URL(zielUrl('https://api.anthropic.com', '/x')).host, 'api.anthropic.com');
  assert.equal(istSichererPfad('/v1/messages'), true);
  for (const p of ['//evil/v1', '/\\evil','http://evil/v1', '', 'v1/messages', undefined]) assert.equal(istSichererPfad(p), false, String(p));
});

test('K2: schreibe verwirft mit CLIENT_WEG, wenn der Client schon weg ist (kein Haengen)', async () => {
  const tot = { destroyed: true, write: () => false, on() {}, off() {} };
  await assert.rejects(schreibe(tot, Buffer.from('x')), { code: 'CLIENT_WEG' });
  const stirbt = { destroyed: false, write() { this.destroyed = true; return false; }, on() {}, off() {} };
  await assert.rejects(schreibe(stirbt, Buffer.from('x')), { code: 'CLIENT_WEG' });
});

test('K2: schreibe verwirft mit CLIENT_WEG, wenn close statt drain kommt', async () => {
  const handler = {};
  const res = { destroyed: false, write: () => false, on: (e, f) => { handler[e] = f; }, off() {} };
  const p = schreibe(res, Buffer.from('x'));
  handler.close();
  await assert.rejects(p, { code: 'CLIENT_WEG' });
});

test('K13: anthropic-* geht durch; upgrade, te, trailer, proxy-authenticate gesperrt (beide Richtungen)', () => {
  const aus = anfrageKopfzeilen({ 'anthropic-dangerous-x': '1', 'anthropic-version': 'v', upgrade: 'h2c', te: 'trailers', trailer: 'x', 'proxy-authenticate': 'y' });
  assert.deepEqual(aus, { 'anthropic-dangerous-x': '1', 'anthropic-version': 'v', 'accept-encoding': 'identity' });
  const h = new Headers({ upgrade: 'h2c', te: 'x', trailer: 'y', 'proxy-authenticate': 'z', 'x-ok': '1' });
  assert.deepEqual(antwortKopfzeilen(h), { 'x-ok': '1' });
});

test('K3: werfende Beobachter killen die Anfrage nicht', async () => {
  const fake = await starteFakeUpstream();
  const meldungen = [];
  const server = http.createServer((req, res) => {
    const teile = [];
    req.on('data', (t) => teile.push(t));
    req.on('end', () => {
      leiteWeiter({
        req, res, upstream: fake.url, body: Buffer.concat(teile), liestUsage: true, log: (m) => meldungen.push(m),
        beobachter: { kopf: () => { throw new Error('kopf kaputt'); }, ersteByte: () => { throw new Error('byte kaputt'); } },
      }).then((erg) => { server.ergebnis = erg; });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const antwort = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/v1/messages', method: 'POST', agent: false }, (res) => {
        const t = [];
        res.on('data', (x) => t.push(x));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(t).toString('utf8') }));
      });
      req.on('error', reject);
      req.end('{"stream":true}');
    });
    assert.equal(antwort.status, 200);
    assert.equal(antwort.body, SSE_TEXT);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(server.ergebnis.abbruch, false);
    assert.equal(server.ergebnis.usage.output_tokens, 42);
    assert.ok(meldungen.some((m) => m.includes('Beobachter')));
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fake.schliessen();
  }
});

// ---------- Iteration 5 ----------

function vermittlerFuer(fake, optionen, vorbereiten = () => {}) {
  const server = http.createServer((req, res) => {
    const teile = [];
    req.on('data', (t) => teile.push(t));
    req.on('end', () => {
      vorbereiten(res);
      leiteWeiter({ req, res, upstream: fake.url, body: Buffer.concat(teile), log: () => {}, ...optionen })
        .then((erg) => { server.ergebnis = erg; }, (fehler) => { server.wurf = fehler; });
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

function hole(server, pfad) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: pfad, method: 'POST', agent: false }, (res) => {
      const t = [];
      res.on('data', (x) => t.push(x));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(t).toString('utf8') }));
    });
    req.on('error', reject);
    req.end('{"stream":true}');
  });
}

async function zu(server, fake) {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await fake.schliessen();
}

test('K38: wirft writeHead, gibt es 502 und ein Ergebnis statt eines Wurfs', async () => {
  const fake = await starteFakeUpstream();
  const server = await vermittlerFuer(fake, {}, (res) => {
    const echt = res.writeHead.bind(res);
    let erstes = true;
    res.writeHead = (...args) => {
      if (erstes) {
        erstes = false;
        throw Object.assign(new Error('ungueltige Kopfzeile'), { code: 'ERR_INVALID_CHAR' });
      }
      return echt(...args);
    };
  });
  try {
    const antwort = await hole(server, '/v1/messages');
    assert.equal(antwort.status, 502);
    assert.equal(JSON.parse(antwort.body).type, 'error');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(server.wurf, undefined, 'leiteWeiter hat geworfen');
    assert.equal(server.ergebnis.status, 502);
    assert.equal(server.ergebnis.fehlercode, 'ERR_INVALID_CHAR');
  } finally {
    await zu(server, fake);
  }
});

test('K38: Client schon weg beim Eintritt -> CLIENT_WEG ohne Upstream-Aufruf', async () => {
  const fake = await starteFakeUpstream();
  try {
    const res = { destroyed: true, headersSent: false, writableFinished: false, on() {}, off() {}, destroy() {} };
    const req = { url: '/v1/messages', method: 'POST', headers: {} };
    const erg = await leiteWeiter({ req, res, upstream: fake.url, body: Buffer.from('{}') });
    assert.equal(erg.abbruch, true);
    assert.equal(erg.fehlercode, 'CLIENT_WEG');
    assert.equal(fake.anfragen.length, 0);
  } finally {
    await fake.schliessen();
  }
});

test('K38: nach Ueberschreiten von maxJson wird nichts mehr gesammelt (usage bleibt null)', async () => {
  const fake = await starteFakeUpstream();
  const server = await vermittlerFuer(fake, { liestUsage: true, maxJson: 50 });
  try {
    const antwort = await hole(server, '/v1/messages?szenario=jsonteile');
    assert.equal(antwort.status, 200);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(server.ergebnis.usage, null);
  } finally {
    await zu(server, fake);
  }
});

test('K49: istSichererPfad lehnt Punkt-Segmente ab, auch am Ende; Query bleibt erlaubt', () => {
  for (const p of ['/v1/./x', '/v1/../x', '/v1/x/..', '/v1/x/.', '/./x', '/..']) assert.equal(istSichererPfad(p), false, p);
  for (const p of ['/v1/messages?a=../b', '/v1/x.y/z', '/v1/.hidden', '/v1/messages?beta=true']) assert.equal(istSichererPfad(p), true, p);
});
