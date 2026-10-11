// Adversariale Probe: ein Testschluessel wird ueber alle Wege eingeschleust (Kopfzeilen,
// Body, metadata.user_id, Query, Hook-Body). Danach werden Protokoll, stdout, stderr und
// alle Antworten des Vermittlers durchsucht. Ein Treffer ist ein Testfehler.
// Teil 1: Dienst als eigener Prozess (echte stdout/stderr). Teil 2: Ping-Weg in-process mit
// injizierter Uhr; das mitgeschnittene Log ist genau das, was sonst auf stderr ginge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { pruefeDienst, erzeugeServer, normalisiereKonfig } from '../vermittler.mjs';
import { starteFakeUpstream } from './fake-upstream.mjs';
import { tempOrdner, schreibeKonfig, freierPort, WURZEL, TESTSCHLUESSEL } from './hilfen.mjs';

const MARKE = 'TESTSCHLUESSEL';
const PREISE = { 'claude-opus-5-5': { input: 4, w5m: 5, w1h: 8, read: 0.2, output: 20 } };

const KOPF = {
  'x-api-key': TESTSCHLUESSEL,
  authorization: `Bearer ${TESTSCHLUESSEL}`,
  'anthropic-version': '2023-06-01',
  'anthropic-beta': `beta-${TESTSCHLUESSEL}`,
  'content-type': 'application/json',
  'x-stainless-geheim': TESTSCHLUESSEL,
};

const BODY = JSON.stringify({
  model: 'claude-opus-5-5', max_tokens: 10, stream: true,
  metadata: { user_id: TESTSCHLUESSEL },
  system: [{ type: 'text', text: `System ${TESTSCHLUESSEL}`, cache_control: { type: 'ephemeral' } }],
  tools: [{ name: TESTSCHLUESSEL, input_schema: { oneOf: [{ properties: { [TESTSCHLUESSEL]: {} } }] } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: `Mein Key ist ${TESTSCHLUESSEL}` }] }],
});

function anfrage(port, { methode = 'POST', pfad, kopfzeilen = {}, body }) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: pfad, method: methode, headers: kopfzeilen, agent: false }, (res) => {
      const t = [];
      res.on('data', (x) => t.push(x));
      res.on('end', () => resolve({ status: res.statusCode, text: `${JSON.stringify(res.headers)}\n${Buffer.concat(t).toString('utf8')}` }));
      res.on('error', () => resolve({ status: -1, text: '' }));
    });
    req.on('error', () => resolve({ status: -1, text: '' }));
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

test('Adversariale Key-Probe (Prozess): kein Testschluessel in Protokoll, stdout, stderr oder Antworten', { timeout: 30000 }, async () => {
  const fake = await starteFakeUpstream();
  const ordner = tempOrdner();
  const logPfad = path.join(ordner, 'protokoll.jsonl');
  const port = await freierPort();
  const konfigPfad = schreibeKonfig(ordner, { port, upstream: fake.url, mode: 'ping', logPath: logPfad, ping: { intervalSec: 30 }, preise: PREISE });
  const kind = spawn(process.execPath, [path.join(WURZEL, 'vermittler.mjs'), 'serve', '--konfig', konfigPfad], { windowsHide: true });
  const stdout = [];
  const stderr = [];
  kind.stdout.on('data', (t) => stdout.push(t));
  kind.stderr.on('data', (t) => stderr.push(t));
  const antworten = [];

  try {
    const ende = Date.now() + 5000;
    while ((await pruefeDienst(port, 300)).art !== 'eigen') {
      assert.ok(Date.now() < ende, 'Vermittler startet nicht');
      await new Promise((r) => setTimeout(r, 100));
    }
    const faelle = [
      { pfad: '/v1/messages', kopfzeilen: KOPF, body: BODY },
      { pfad: '/v1/messages?szenario=sse&gzip=1', kopfzeilen: KOPF, body: BODY },
      { pfad: '/v1/messages?szenario=json', kopfzeilen: KOPF, body: BODY },
      { pfad: '/v1/messages?szenario=fehler401', kopfzeilen: KOPF, body: BODY },
      { pfad: '/v1/messages?szenario=fehler500', kopfzeilen: KOPF, body: BODY },
      { pfad: '/v1/messages?szenario=abbruch', kopfzeilen: KOPF, body: BODY },
      { pfad: `/v1/messages?szenario=fehler400&k=${TESTSCHLUESSEL}`, kopfzeilen: KOPF, body: `{kaputt ${TESTSCHLUESSEL}` },
      { pfad: `/v1/messages/count_tokens?szenario=fehler400&k=${TESTSCHLUESSEL}`, kopfzeilen: KOPF, body: BODY },
      { methode: 'GET', pfad: `/v1/models?szenario=json&k=${TESTSCHLUESSEL}`, kopfzeilen: KOPF },
      { pfad: '/v1/messages', kopfzeilen: { ...KOPF, origin: `https://${TESTSCHLUESSEL}.example` }, body: BODY },
      { pfad: '/_vermittler/heartbeat', kopfzeilen: KOPF, body: JSON.stringify({ session_id: TESTSCHLUESSEL }) },
      { pfad: '/_vermittler/subagent-ende', kopfzeilen: KOPF, body: JSON.stringify({ session_id: TESTSCHLUESSEL }) },
      { pfad: '/_vermittler/session-ende', kopfzeilen: KOPF, body: JSON.stringify({ session_id: TESTSCHLUESSEL }) },
      { pfad: '/_vermittler/stop', kopfzeilen: KOPF, body: JSON.stringify({ pid: TESTSCHLUESSEL }) },
      { pfad: `/_vermittler/${TESTSCHLUESSEL}`, kopfzeilen: KOPF, body: TESTSCHLUESSEL },
      { pfad: '/_vermittler/heartbeat', kopfzeilen: KOPF, body: `kein json ${TESTSCHLUESSEL}` },
    ];
    for (const fall of faelle) antworten.push(await anfrage(port, fall));
    assert.ok(fake.anfragen.some((a) => a.kopfzeilen['x-api-key'] === TESTSCHLUESSEL), 'Key kam nicht beim Upstream an');
    await fake.schliessen();
    const tot = await anfrage(port, { pfad: '/v1/messages', kopfzeilen: KOPF, body: BODY });
    assert.equal(tot.status, 502);
    antworten.push(tot);
  } finally {
    kind.kill();
    await new Promise((r) => kind.on('close', r));
  }

  const protokoll = fs.readFileSync(logPfad, 'utf8');
  assert.ok(protokoll.split('\n').filter(Boolean).length >= 8, 'Protokoll hat zu wenige Eintraege');
  assert.equal(protokoll.includes(MARKE), false, 'Treffer im Protokoll');
  assert.equal(Buffer.concat(stdout).toString('utf8').includes(MARKE), false, 'Treffer in stdout');
  assert.equal(Buffer.concat(stderr).toString('utf8').includes(MARKE), false, 'Treffer in stderr');
  antworten.forEach((a, i) => assert.equal(a.text.includes(MARKE), false, `Treffer in Antwort ${i}`));
});

test('Adversariale Key-Probe (Ping-Weg): erfolgreicher und gescheiterter Ping ohne Testschluessel in Protokoll und Log', { timeout: 30000 }, async () => {
  const fake = await starteFakeUpstream();
  const logPfad = path.join(tempOrdner(), 'protokoll.jsonl');
  let ms = Date.parse('2026-10-11T10:00:00Z');
  const meldungen = [];
  const konfig = normalisiereKonfig({ port: 1, upstream: fake.url, mode: 'ping', logPath: logPfad, preise: PREISE }, process.cwd());
  const { server, planer } = erzeugeServer(konfig, { log: (t) => meldungen.push(t), jetzt: () => ms, pingTimer: false });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const antworten = [];
  const istPing = (a) => { try { return JSON.parse(a.body.toString('utf8')).max_tokens === 0; } catch { return false; } };
  try {
    antworten.push(await anfrage(port, { pfad: '/v1/messages', kopfzeilen: KOPF, body: BODY }));
    ms += 241000;
    antworten.push(await anfrage(port, { pfad: '/_vermittler/heartbeat', body: JSON.stringify({ session_id: TESTSCHLUESSEL }) }));
    await planer.pruefe();
    const ping = fake.anfragen.find(istPing);
    assert.ok(ping, 'kein Ping beim Fake');
    assert.equal(ping.kopfzeilen['x-api-key'], TESTSCHLUESSEL, 'Ping traegt den Key zum Upstream');
    await fake.schliessen();
    ms += 241000;
    antworten.push(await anfrage(port, { pfad: '/_vermittler/heartbeat', body: JSON.stringify({ session_id: TESTSCHLUESSEL }) }));
    await planer.pruefe();
    assert.ok(meldungen.some((m) => m.includes('Ping fehlgeschlagen')), 'kein gescheiterter Ping gemeldet');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  const protokoll = fs.readFileSync(logPfad, 'utf8');
  const zeilen = protokoll.split('\n').filter(Boolean).map((z) => JSON.parse(z));
  assert.ok(zeilen.some((z) => z.art === 'ping' && z.status === 200), 'erfolgreicher Ping im Protokoll');
  assert.ok(zeilen.some((z) => z.art === 'ping' && z.status === 0), 'gescheiterter Ping im Protokoll');
  assert.equal(protokoll.includes(MARKE), false, 'Treffer im Protokoll');
  assert.equal(meldungen.join('\n').includes(MARKE), false, 'Treffer im Log');
  antworten.forEach((a, i) => assert.equal(a.text.includes(MARKE), false, `Treffer in Antwort ${i}`));
});
