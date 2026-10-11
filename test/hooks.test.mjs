// Integration der Kimi-Hooks: die Skripte laufen als eigene Prozesse wie unter Kimi.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { erzeugeServer, normalisiereKonfig, pruefeDienst } from '../vermittler.mjs';
import { sha12 } from '../lib/protokoll.mjs';
import { tempOrdner, schreibeKonfig, fuehreAus, freierPort, WURZEL } from './hilfen.mjs';

const EREIGNIS = path.join(WURZEL, 'hooks', 'session-ereignis.mjs');
const START = path.join(WURZEL, 'hooks', 'session-start.mjs');
const CLI = path.join(WURZEL, 'vermittler.mjs');

let server;
let sitzungen;
let konfigPfad;
let port;

before(async () => {
  const ordner = tempOrdner();
  // Konfigdatei und laufender Server muessen denselben konfigHash haben (K25), sonst wuerde der
  // Start-Hook den Testserver als veraltet erneuern.
  port = await freierPort();
  const roh = { port, upstream: 'http://127.0.0.1:1', mode: 'ttl1h', logPath: path.join(ordner, 'p.jsonl'), preise: {} };
  const erg = erzeugeServer(normalisiereKonfig(roh, ordner), { log: () => {} });
  server = erg.server;
  sitzungen = erg.sitzungen;
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  konfigPfad = schreibeKonfig(ordner, roh);
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

function ereignis(daten, pfad = konfigPfad) {
  return fuehreAus([EREIGNIS, '--konfig', pfad], { stdin: typeof daten === 'string' ? daten : JSON.stringify(daten) });
}

const BASIS = { session_title: 't', client_type: 'cli', cwd: 'C:/x' };

test('session-ereignis: SessionHeartbeat setzt das Lebenszeichen, stdout bleibt leer', async () => {
  sitzungen.anfrage(sha12('H1'), 'k-h1', 100); // K45: nur bekannte Sessions bekommen Heartbeats
  const erg = await ereignis({ ...BASIS, hook_event_name: 'SessionHeartbeat', session_id: 'H1', uptime_ms: 60000 });
  assert.equal(erg.code, 0);
  assert.equal(erg.stdout, '');
  assert.notEqual(sitzungen.zustand(sha12('H1'))?.letzterHeartbeatMs ?? null, null);
});

test('session-ereignis: SubagentStop und SessionEnd rufen ihre Endpunkte', async () => {
  sitzungen.anfrage(sha12('H2'), 'k-haupt', 9000);
  sitzungen.anfrage(sha12('H2'), 'k-sub', 100);
  const sub = await ereignis({ ...BASIS, hook_event_name: 'SubagentStop', session_id: 'H2' });
  assert.equal(sub.code, 0);
  assert.deepEqual(Object.keys(sitzungen.zustand(sha12('H2')).schluessel), ['k-haupt']);
  const ende = await ereignis({ ...BASIS, hook_event_name: 'SessionEnd', session_id: 'H2' });
  assert.equal(ende.code, 0);
  assert.equal(sitzungen.zustand(sha12('H2')), null);
});

test('session-ereignis: fremdes Ereignis, kaputtes stdin und leeres stdin enden still mit 0', async () => {
  for (const eingabe of [{ ...BASIS, hook_event_name: 'PreCompact', session_id: 'H3' }, 'kein json', '']) {
    const erg = await ereignis(eingabe);
    assert.equal(erg.code, 0);
    assert.equal(erg.stdout, '');
  }
  assert.equal(sitzungen.zustand(sha12('H3')), null);
});

test('K10: kaputtes JSON auf stdin ergibt eine stderr-Zeile, Exit 0, stdout leer', async () => {
  const erg = await ereignis('kein json');
  assert.equal(erg.code, 0);
  assert.equal(erg.stdout, '');
  assert.match(erg.stderr, /JSON/);
  assert.equal(erg.stderr.trim().split('\n').length, 1);
  assert.equal(erg.stderr.includes('kein json'), false, 'Inhalt wird nicht zitiert');
});

test('session-ereignis: Vermittler nicht erreichbar oder Konfig fehlt -> Exit 0, schnell', async () => {
  const ordner = tempOrdner();
  const totPfad = schreibeKonfig(ordner, { port: await freierPort(), upstream: 'http://127.0.0.1:1', logPath: path.join(ordner, 'p.jsonl') });
  const erg = await ereignis({ ...BASIS, hook_event_name: 'SessionEnd', session_id: 'H4' }, totPfad);
  assert.equal(erg.code, 0);
  assert.ok(erg.dauerMs < 4000, `zu langsam: ${erg.dauerMs} ms`);
  const ohneKonfig = await ereignis({ ...BASIS, hook_event_name: 'SessionEnd', session_id: 'H4' }, path.join(ordner, 'fehlt.json'));
  assert.equal(ohneKonfig.code, 0);
});

test('session-ereignis: Vermittler haengt -> Abbruch nach 2 s, Exit 0', async () => {
  const haenger = http.createServer(() => {});
  await new Promise((r) => haenger.listen(0, '127.0.0.1', r));
  const ordner = tempOrdner();
  const pfad = schreibeKonfig(ordner, { port: haenger.address().port, upstream: 'http://127.0.0.1:1', logPath: path.join(ordner, 'p.jsonl') });
  try {
    const erg = await ereignis({ ...BASIS, hook_event_name: 'SessionHeartbeat', session_id: 'H5' }, pfad);
    assert.equal(erg.code, 0);
    assert.ok(erg.dauerMs >= 1900 && erg.dauerMs < 4500, `Dauer ${erg.dauerMs} ms`);
  } finally {
    haenger.closeAllConnections();
    await new Promise((r) => haenger.close(r));
  }
});

test('session-start: eigener Dienst laeuft -> Exit 0 ohne Neustart, stdout leer', async () => {
  const erg = await fuehreAus([START, '--konfig', konfigPfad], { stdin: JSON.stringify({ ...BASIS, hook_event_name: 'SessionStart', session_id: 'S1', source: 'startup' }) });
  assert.equal(erg.code, 0);
  assert.equal(erg.stdout, '');
  assert.equal(erg.stderr, '');
});

test('session-start: fremder Dienst auf dem Port -> Meldung auf stderr, Exit 0', async () => {
  const fremd = http.createServer((req, res) => { res.writeHead(200); res.end('ich bin jemand anderes'); });
  await new Promise((r) => fremd.listen(0, '127.0.0.1', r));
  const ordner = tempOrdner();
  const pfad = schreibeKonfig(ordner, { port: fremd.address().port, upstream: 'http://127.0.0.1:1', logPath: path.join(ordner, 'p.jsonl') });
  try {
    const erg = await fuehreAus([START, '--konfig', pfad], { stdin: '{}' });
    assert.equal(erg.code, 0);
    assert.equal(erg.stdout, '');
    assert.match(erg.stderr, /fremd/);
  } finally {
    fremd.closeAllConnections();
    await new Promise((r) => fremd.close(r));
  }
});

test('K8 im Hook: alte Version wird losgeloest erneuert, der Hook kehrt sofort zurueck (Hook-Timeout 5 s)', { timeout: 30000 }, async () => {
  const ordner = tempOrdner();
  const altPort = await freierPort();
  const pfad = schreibeKonfig(ordner, { port: altPort, upstream: 'http://127.0.0.1:1', logPath: path.join(ordner, 'p.jsonl') });
  let alt;
  alt = http.createServer((req, res) => {
    if (req.url === '/_vermittler/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, dienst: 'anthropic-vermittler', version: '0.0.1', pid: 999999 }));
      return;
    }
    if (req.url === '/_vermittler/stop' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // wie der echte Dienst mit offenen Stroemen: schliesst erst nach der Gnadenfrist
      res.end('{"ok":true}', () => setTimeout(() => { alt.closeAllConnections(); alt.close(); }, 3000));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => alt.listen(altPort, '127.0.0.1', r));
  try {
    const erg = await fuehreAus([START, '--konfig', pfad], { stdin: '{}' });
    assert.equal(erg.code, 0);
    assert.equal(erg.stdout, '');
    assert.ok(erg.dauerMs < 3000, `Hook brauchte ${erg.dauerMs} ms`);
    const ende = Date.now() + 15000;
    let z = await pruefeDienst(altPort, 300);
    while (!(z.art === 'eigen' && z.health.version !== '0.0.1') && Date.now() < ende) {
      await new Promise((r) => setTimeout(r, 200));
      z = await pruefeDienst(altPort, 300);
    }
    assert.equal(z.art, 'eigen');
    assert.notEqual(z.health.version, '0.0.1', 'neuer Stand laeuft');
  } finally {
    const stop = await fuehreAus([CLI, 'stop', '--konfig', pfad]);
    assert.equal(stop.code, 0, stop.stderr);
  }
});

test('session-start: niemand lauscht -> startet losgeloest und wartet auf den Port; zweiter Aufruf unschaedlich', async () => {
  const ordner = tempOrdner();
  const neuerPort = await freierPort();
  const pfad = schreibeKonfig(ordner, { port: neuerPort, upstream: 'http://127.0.0.1:1', logPath: path.join(ordner, 'p.jsonl') });
  try {
    const erg = await fuehreAus([START, '--konfig', pfad], { stdin: '{}' });
    assert.equal(erg.code, 0);
    assert.equal(erg.stdout, '');
    const z = await pruefeDienst(neuerPort);
    assert.equal(z.art, 'eigen');
    const zweiter = await fuehreAus([START, '--konfig', pfad], { stdin: '{}' });
    assert.equal(zweiter.code, 0);
    assert.equal((await pruefeDienst(neuerPort)).health.pid, z.health.pid);
  } finally {
    const stop = await fuehreAus([CLI, 'stop', '--konfig', pfad]);
    assert.equal(stop.code, 0, stop.stderr);
  }
  assert.equal((await pruefeDienst(neuerPort)).art, 'keiner');
});
