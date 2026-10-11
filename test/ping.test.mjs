import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pingBody, pingAusschluss, erzeugePingPlaner } from '../lib/ping.mjs';
import { erzeugeSitzungen } from '../lib/sitzungen.mjs';
import { erzeugeProtokoll, leseProtokoll } from '../lib/protokoll.mjs';
import { tempOrdner, TESTSCHLUESSEL } from './hilfen.mjs';

const PING = { intervalSec: 240, maxIdleMin: 60, heartbeatGraceSec: 100000 };
const PREISE = { 'claude-opus-5-5': { input: 4, w5m: 5, w1h: 8, read: 0.2, output: 20 } };

const ORIGINAL = {
  model: 'claude-opus-5-5',
  max_tokens: 32000,
  stream: true,
  metadata: { user_id: 'S' },
  thinking: { type: 'adaptive', display: 'summarized' },
  output_config: { effort: 'high' },
  system: [{ type: 'text', text: 'Sys', cache_control: { type: 'ephemeral' } }],
  tools: [{ name: 't', input_schema: { type: 'object', properties: {} } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hallo äöü', cache_control: { type: 'ephemeral' } }] }],
};

const KOPF = Object.freeze({
  'x-api-key': TESTSCHLUESSEL,
  'anthropic-version': '2023-06-01',
  'content-type': 'application/json',
  'accept-encoding': 'identity',
});

function ohne(objekt, ...felder) {
  return Object.fromEntries(Object.entries(objekt).filter(([k]) => !felder.includes(k)));
}

// ---------- reine Funktionen ----------

test('pingBody: max_tokens 0 und stream false, alles andere tiefgleich; String und Buffer', () => {
  for (const ein of [Buffer.from(JSON.stringify(ORIGINAL)), JSON.stringify(ORIGINAL)]) {
    const aus = JSON.parse(pingBody(ein).toString('utf8'));
    assert.equal(aus.max_tokens, 0);
    assert.equal(aus.stream, false);
    assert.deepEqual(ohne(aus, 'max_tokens', 'stream'), ohne(ORIGINAL, 'max_tokens', 'stream'));
  }
});

test('pingBody: Feldreihenfolge bleibt, stream wird ergaenzt, wenn er fehlte', () => {
  const ohneStream = ohne(ORIGINAL, 'stream');
  const aus = JSON.parse(pingBody(JSON.stringify(ohneStream)).toString('utf8'));
  assert.deepEqual(Object.keys(aus), [...Object.keys(ohneStream), 'stream']);
  const mit = JSON.parse(pingBody(JSON.stringify(ORIGINAL)).toString('utf8'));
  assert.deepEqual(Object.keys(mit), Object.keys(ORIGINAL));
});

test('pingBody: nicht parsbar oder kein Objekt ergibt null', () => {
  assert.equal(pingBody('{kaputt'), null);
  assert.equal(pingBody('[1,2]'), null);
});

test('pingAusschluss: die vier Ausschluesse, sonst null', () => {
  assert.equal(pingAusschluss({ ...ORIGINAL, thinking: { type: 'enabled', budget_tokens: 1024 } }), 'thinking-enabled');
  assert.equal(pingAusschluss({ ...ORIGINAL, output_config: { format: { type: 'json_schema' } } }), 'output-format');
  assert.equal(pingAusschluss({ ...ORIGINAL, tool_choice: { type: 'any' } }), 'tool-choice');
  assert.equal(pingAusschluss({ ...ORIGINAL, tool_choice: { type: 'tool', name: 't' } }), 'tool-choice');
  assert.equal(pingAusschluss(ORIGINAL), null);
  assert.equal(pingAusschluss({ ...ORIGINAL, tool_choice: { type: 'auto' } }), null);
  assert.equal(pingAusschluss({ ...ORIGINAL, thinking: { type: 'disabled' } }), null);
});

// ---------- Planer ----------

function aufbau({ ping = PING, antwort = { status: 200, usage: { input_tokens: 3, cache_read_input_tokens: 5000, output_tokens: 0 } } } = {}) {
  let ms = Date.parse('2026-10-11T10:00:00Z');
  const jetzt = () => ms;
  const logPfad = path.join(tempOrdner(), 'p.jsonl');
  const sitzungen = erzeugeSitzungen({ jetzt });
  const protokoll = erzeugeProtokoll({ logPfad, konfig: { preise: PREISE, ping }, jetzt });
  const gesendet = [];
  let naechsteAntwort = antwort;
  const sende = async ({ ziel, body, kopfzeilen, signal }) => {
    gesendet.push({ ziel, body, kopfzeilen, signal });
    if (naechsteAntwort instanceof Error) throw naechsteAntwort;
    return typeof naechsteAntwort === 'function' ? naechsteAntwort() : naechsteAntwort;
  };
  const planer = erzeugePingPlaner({
    konfig: { upstream: 'http://upstream.test', ping }, jetzt, sende, sitzungen, protokoll, timer: null, log: () => {},
  });
  return {
    planer, sitzungen, gesendet, logPfad, jetzt,
    vor: (sek) => { ms += sek * 1000; },
    setzeAntwort: (a) => { naechsteAntwort = a; },
  };
}

function byte(u, schluessel) {
  u.planer.ersteByte(schluessel, u.planer.zustand(schluessel)?.startMs);
}

const TOTMANN = { intervalSec: 240, maxIdleMin: 60, heartbeatGraceSec: 180 };

function melde(u, { session = 'sess', schluessel = 'k1', body = ORIGINAL, modus = 'ping', startMs } = {}) {
  // Wie im Server: die echte Anfrage macht die Session bekannt (K45, Heartbeats nur fuer Bekannte).
  if (session) u.sitzungen.anfrage(session, schluessel, 100);
  return u.planer.anfrage({
    session, schluessel, modell: body.model, modus, pfad: '/v1/messages?beta=true',
    body: Buffer.from(JSON.stringify(body)), json: body, kopfzeilen: KOPF, startMs: startMs ?? u.jetzt(),
  });
}

test('Faelligkeit nach Startzeit, auch bei laufender Anfrage; Kopfzeilen und Pfad identisch', async () => {
  const u = aufbau();
  melde(u);
  u.vor(1);
  byte(u, 'k1');
  u.vor(238); // 239 s nach Start
  await u.planer.pruefe();
  assert.equal(u.gesendet.length, 0);
  u.vor(1); // 240 s
  await u.planer.pruefe();
  assert.equal(u.gesendet.length, 1);
  const p = u.gesendet[0];
  assert.equal(p.ziel, 'http://upstream.test/v1/messages?beta=true');
  assert.deepEqual(p.kopfzeilen, KOPF);
  const body = JSON.parse(p.body.toString('utf8'));
  assert.equal(body.max_tokens, 0);
  assert.equal(body.stream, false);
  assert.deepEqual(ohne(body, 'max_tokens', 'stream'), ohne(ORIGINAL, 'max_tokens', 'stream'));
});

test('Kein Ping vor dem ersten Antwort-Byte; danach sofort faellig', async () => {
  const u = aufbau();
  melde(u);
  u.vor(300);
  await u.planer.pruefe();
  assert.equal(u.gesendet.length, 0);
  byte(u, 'k1');
  await u.planer.pruefe();
  assert.equal(u.gesendet.length, 1);
});

test('Wiederholung alle intervalSec; Ende nach maxIdleMin seit der letzten echten Anfrage', async () => {
  const u = aufbau({ ping: { intervalSec: 240, maxIdleMin: 10, heartbeatGraceSec: 100000 } });
  melde(u);
  byte(u, 'k1');
  for (let s = 0; s < 1000; s += 10) {
    u.vor(10);
    await u.planer.pruefe();
  }
  assert.equal(u.gesendet.length, 2, 'Pings bei 240 und 480 s; 720 s liegt ueber 600 s');
  assert.equal(u.planer.anzahl(), 0, 'Schluessel samt Body verworfen');
});

test('Neue echte Anfrage setzt die Uhr neu und ersetzt den Body (hoechstens ein Body je Schluessel)', async () => {
  const u = aufbau();
  melde(u);
  byte(u, 'k1');
  u.vor(200);
  const neu = { ...ORIGINAL, messages: [...ORIGINAL.messages, { role: 'user', content: 'weiter' }] };
  melde(u, { body: neu });
  byte(u, 'k1');
  u.vor(100); // 300 s nach der ersten, 100 s nach der zweiten Anfrage
  await u.planer.pruefe();
  assert.equal(u.gesendet.length, 0);
  u.vor(140);
  await u.planer.pruefe();
  assert.equal(u.gesendet.length, 1);
  assert.equal(JSON.parse(u.gesendet[0].body.toString('utf8')).messages.length, 2);
  assert.equal(u.planer.anzahl(), 1);
});

test('Kein Ping bei den Ausschluessen und bei Modus ungleich ping; vorhandener Schluessel wird verworfen', async () => {
  for (const body of [
    { ...ORIGINAL, thinking: { type: 'enabled', budget_tokens: 1024 } },
    { ...ORIGINAL, output_config: { format: { type: 'json_schema' } } },
    { ...ORIGINAL, tool_choice: { type: 'any' } },
    { ...ORIGINAL, tool_choice: { type: 'tool', name: 't' } },
  ]) {
    const u = aufbau();
    melde(u);
    assert.equal(u.planer.anzahl(), 1);
    assert.equal(melde(u, { body }), false);
    assert.equal(u.planer.anzahl(), 0);
    byte(u, 'k1');
    u.vor(300);
    await u.planer.pruefe();
    assert.equal(u.gesendet.length, 0);
  }
  for (const modus of ['ttl1h', 'sockel1h', 'aus']) {
    const u = aufbau();
    assert.equal(melde(u, { modus }), false);
    assert.equal(u.planer.anzahl(), 0);
  }
});

test('session-ende verwirft alle Schluessel der Session, andere Sessions bleiben', async () => {
  const u = aufbau();
  melde(u, { session: 'A', schluessel: 'a1' });
  melde(u, { session: 'A', schluessel: 'a2' });
  melde(u, { session: 'B', schluessel: 'b1' });
  ['a1', 'a2', 'b1'].forEach((k) => byte(u, k));
  assert.equal(u.planer.sessionEnde('A'), 2);
  assert.equal(u.planer.zustand('a1'), null);
  u.vor(240);
  await u.planer.pruefe();
  assert.equal(u.gesendet.length, 1);
});

test('subagent-ende verwirft die Nebenschluessel; Subagenten-Schluessel pingen getrennt', async () => {
  const u = aufbau();
  melde(u, { session: 'A', schluessel: 'haupt' });
  melde(u, { session: 'A', schluessel: 'sub', body: { ...ORIGINAL, system: 'Subagent' } });
  byte(u, 'haupt');
  byte(u, 'sub');
  u.vor(240);
  await u.planer.pruefe();
  assert.equal(u.gesendet.length, 2);
  assert.equal(u.planer.subagentEnde('A', 'haupt'), 1);
  assert.equal(u.planer.zustand('sub'), null);
  assert.ok(u.planer.zustand('haupt'));
  u.vor(240);
  await u.planer.pruefe();
  assert.equal(u.gesendet.length, 3);
});

test('Totmannschalter: je gesehener Heartbeat aelter als heartbeatGraceSec beendet die Pings', async () => {
  const u = aufbau({ ping: TOTMANN });
  melde(u);
  assert.equal(u.sitzungen.heartbeat('sess'), true);
  byte(u, 'k1');
  u.vor(240);
  await u.planer.pruefe();
  assert.equal(u.gesendet.length, 0);
  assert.equal(u.planer.anzahl(), 0);
});

test('Totmannschalter: frischer Heartbeat erlaubt den Ping', async () => {
  const u = aufbau({ ping: TOTMANN });
  melde(u);
  byte(u, 'k1');
  u.vor(200);
  u.sitzungen.heartbeat('sess');
  u.vor(40);
  await u.planer.pruefe();
  assert.equal(u.gesendet.length, 1);
});

test('K16: ohne je gesehenen Heartbeat zaehlt der Start der echten Anfrage als Referenz', async () => {
  const u = aufbau({ ping: { intervalSec: 240, maxIdleMin: 60, heartbeatGraceSec: 300 } });
  melde(u);
  byte(u, 'k1');
  u.vor(240);
  await u.planer.pruefe();
  assert.equal(u.gesendet.length, 1, '240 s < 300 s Gnadenfrist');
  u.vor(240);
  await u.planer.pruefe();
  assert.equal(u.gesendet.length, 1, '480 s seit Start ohne Heartbeat: Ende');
  assert.equal(u.planer.anzahl(), 0);
});

test('K16: mit Standard-Gnadenfrist 180 s und ohne Heartbeat-Hook kommt kein Ping', async () => {
  const u = aufbau({ ping: TOTMANN });
  melde(u);
  byte(u, 'k1');
  u.vor(240);
  await u.planer.pruefe();
  assert.equal(u.gesendet.length, 0);
});

test('maxIdleMin begrenzt die Pings (Totmann ausser Kraft)', async () => {
  const u = aufbau();
  melde(u);
  byte(u, 'k1');
  for (let i = 0; i < 15; i += 1) {
    u.vor(240);
    await u.planer.pruefe();
  }
  assert.equal(u.gesendet.length, 15);
  u.vor(240);
  await u.planer.pruefe();
  assert.equal(u.gesendet.length, 15);
  assert.equal(u.planer.anzahl(), 0);
});

test('Fehler eines Pings (Status) beendet die Pings bis zur naechsten echten Anfrage', async () => {
  const u = aufbau({ antwort: { status: 500, usage: null } });
  melde(u);
  byte(u, 'k1');
  u.vor(240);
  await u.planer.pruefe();
  u.vor(240);
  await u.planer.pruefe();
  assert.equal(u.gesendet.length, 1);
  assert.equal(u.planer.anzahl(), 0);
  const zeile = leseProtokoll(u.logPfad).find((z) => z.art === 'ping');
  assert.equal(zeile.status, 500);
  u.setzeAntwort({ status: 200, usage: {} });
  melde(u);
  byte(u, 'k1');
  u.vor(240);
  await u.planer.pruefe();
  assert.equal(u.gesendet.length, 2);
});

test('Netzfehler eines Pings: Protokoll mit Status 0 und Fehlercode, danach kein Ping', async () => {
  const fehler = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const u = aufbau({ antwort: fehler });
  melde(u);
  byte(u, 'k1');
  u.vor(240);
  await u.planer.pruefe();
  const zeile = leseProtokoll(u.logPfad).find((z) => z.art === 'ping');
  assert.equal(zeile.status, 0);
  assert.equal(zeile.fehler, 'ECONNREFUSED');
  assert.equal(u.planer.anzahl(), 0);
});

test('Ping und neue echte Anfrage ueberlappen: der Fehler des alten Pings verwirft den neuen Zustand nicht', async () => {
  let freigeben;
  const u = aufbau({ antwort: () => new Promise((r) => { freigeben = () => r({ status: 500, usage: null }); }) });
  melde(u);
  byte(u, 'k1');
  u.vor(240);
  const laeuft = u.planer.pruefe();
  await new Promise((r) => setImmediate(r));
  melde(u);
  await u.planer.pruefe(); // waehrend der Ping laeuft: kein zweiter
  assert.equal(u.gesendet.length, 1);
  freigeben();
  await laeuft;
  assert.equal(u.planer.anzahl(), 1);
  assert.equal(u.planer.zustand('k1').ersteByteMs, null);
});

test('Protokollzeile art ping: echte usage, Kosten, keine Gegenrechnung, kein Key', async () => {
  const u = aufbau();
  melde(u);
  byte(u, 'k1');
  u.vor(240);
  await u.planer.pruefe();
  const zeile = leseProtokoll(u.logPfad).find((z) => z.art === 'ping');
  assert.equal(zeile.status, 200);
  assert.equal(zeile.modus, 'ping');
  assert.equal(zeile.modell, 'claude-opus-5-5');
  assert.equal(zeile.session, 'sess');
  assert.equal(zeile.schluessel, 'k1');
  assert.equal(zeile.cache_read, 5000);
  assert.equal(zeile.input, 3);
  assert.equal(zeile.kosten, 0.001012);
  assert.equal(zeile.gegenrechnung, null);
  assert.equal(zeile.sekundenSeitLetzter, 240);
  assert.equal(fs.readFileSync(u.logPfad, 'utf8').includes('TESTSCHLUESSEL'), false);
});

test('zustand gibt keinen Body und keine Kopfzeilen heraus', () => {
  const u = aufbau();
  melde(u);
  const z = u.planer.zustand('k1');
  assert.equal(JSON.stringify(z).includes('TESTSCHLUESSEL'), false);
  assert.equal('body' in z, false);
  assert.equal(z.hatBody, true);
});

test('Timer: starte ruft pruefe periodisch ueber den injizierten Timer, stoppe raeumt ab', () => {
  const aufrufe = [];
  const timer = {
    setInterval: (fn, ms) => { aufrufe.push(['set', ms]); return { fn, unref() { aufrufe.push(['unref']); } }; },
    clearInterval: (h) => aufrufe.push(['clear', typeof h.fn]),
  };
  const planer = erzeugePingPlaner({
    konfig: { upstream: 'http://x', ping: { intervalSec: 2, maxIdleMin: 1, heartbeatGraceSec: 180 } },
    sitzungen: erzeugeSitzungen(), protokoll: { ping: () => {} }, sende: async () => ({ status: 200 }), timer, log: () => {},
  });
  planer.starte();
  planer.stoppe();
  assert.deepEqual(aufrufe, [['set', 500], ['unref'], ['clear', 'function']]);
});

// ---------- Iteration 3 ----------

test('K18: kein Ping-Zustand ohne Session', () => {
  const u = aufbau();
  assert.equal(melde(u, { session: null }), false);
  assert.equal(u.planer.anzahl(), 0);
});

test('K18: Ausschluss wird aus dem gesendeten Body bestimmt, nicht aus einem mitgegebenen json', () => {
  const u = aufbau();
  const gesendet = { ...ORIGINAL, thinking: { type: 'enabled', budget_tokens: 1024 } };
  const ok = u.planer.anfrage({
    session: 'sess', schluessel: 'k1', modell: ORIGINAL.model, modus: 'ping', pfad: '/v1/messages',
    body: Buffer.from(JSON.stringify(gesendet)), json: ORIGINAL, kopfzeilen: KOPF, startMs: u.jetzt(),
  });
  assert.equal(ok, false);
  assert.equal(u.planer.anzahl(), 0);
});

test('K18: ersteByte einer alten Anfrage (anderer startMs) wird ignoriert', () => {
  const u = aufbau();
  melde(u);
  const alt = u.planer.zustand('k1').startMs;
  u.vor(5);
  melde(u);
  u.planer.ersteByte('k1', alt);
  assert.equal(u.planer.zustand('k1').ersteByteMs, null);
  u.planer.ersteByte('k1');
  assert.equal(u.planer.zustand('k1').ersteByteMs, null, 'ohne startMs ebenfalls ignoriert');
  byte(u, 'k1');
  assert.notEqual(u.planer.zustand('k1').ersteByteMs, null);
});

test('K1: Pfad, der nicht mit genau einem / beginnt, wird nie gepingt', () => {
  const u = aufbau();
  for (const pfad of ['//example.invalid/v1/messages', 'http://example.invalid/v1/messages', '/\\example.invalid']) {
    const ok = u.planer.anfrage({
      session: 'sess', schluessel: 'k1', modell: ORIGINAL.model, modus: 'ping', pfad,
      body: Buffer.from(JSON.stringify(ORIGINAL)), kopfzeilen: KOPF, startMs: u.jetzt(),
    });
    assert.equal(ok, false, pfad);
  }
  assert.equal(u.planer.anzahl(), 0);
});

test('K1: Ziel-URL entsteht durch Verkettung mit dem Upstream (auch mit Schraegstrich am Ende)', async () => {
  const u = aufbau();
  melde(u);
  byte(u, 'k1');
  u.vor(240);
  await u.planer.pruefe();
  assert.equal(u.gesendet[0].ziel, 'http://upstream.test/v1/messages?beta=true');
});

test('K17: wirft protokoll.ping, wird laeuft trotzdem zurueckgesetzt und der naechste Ping kommt', async () => {
  let ms = 0;
  const gesendet = [];
  const planer = erzeugePingPlaner({
    konfig: { upstream: 'http://u.test', ping: PING }, jetzt: () => ms, timer: null, log: () => {},
    sitzungen: erzeugeSitzungen({ jetzt: () => ms }),
    protokoll: { ping: () => { throw new Error('platte voll'); } },
    sende: async (a) => { gesendet.push(a); return { status: 200, usage: {} }; },
  });
  planer.anfrage({ session: 's', schluessel: 'k', modell: 'm', modus: 'ping', pfad: '/v1/messages', body: Buffer.from(JSON.stringify(ORIGINAL)), kopfzeilen: KOPF, startMs: 0 });
  planer.ersteByte('k', 0);
  ms = 240000;
  await planer.pruefe();
  assert.equal(planer.zustand('k').laeuft, false);
  ms = 480000;
  await planer.pruefe();
  assert.equal(gesendet.length, 2);
});

test('K19: sessionEnde bricht einen laufenden Ping ab (Signal abgebrochen)', async () => {
  let freigeben;
  const u = aufbau({ antwort: () => new Promise((r) => { freigeben = () => r({ status: 200, usage: {} }); }) });
  melde(u);
  byte(u, 'k1');
  u.vor(240);
  const laeuft = u.planer.pruefe();
  await new Promise((r) => setImmediate(r));
  assert.equal(u.gesendet[0].signal.aborted, false);
  u.planer.sessionEnde('sess');
  assert.equal(u.gesendet[0].signal.aborted, true);
  freigeben();
  await laeuft;
  assert.equal(u.planer.anzahl(), 0);
});

// ---------- Iteration 5 ----------

function meldePfad(u, pfad) {
  return u.planer.anfrage({
    session: 'sess', schluessel: 'k1', modell: ORIGINAL.model, modus: 'ping', pfad,
    body: Buffer.from(JSON.stringify(ORIGINAL)), kopfzeilen: KOPF, startMs: u.jetzt(),
  });
}

test('K34: scharf nur fuer den Pfad /v1/messages (Query erlaubt)', () => {
  const u = aufbau();
  for (const pfad of ['/v1/messages/count_tokens', '/v1/models', '/v1/messages/', '/v1/messagesx', '/_vermittler/health']) {
    assert.equal(meldePfad(u, pfad), false, pfad);
  }
  assert.equal(meldePfad(u, '/v1/messages'), true);
  assert.equal(meldePfad(u, '/v1/messages?beta=true'), true);
});

test('K35: eine juengere echte Anfrage zaehlt als Lebenszeichen, auch bei altem Heartbeat', async () => {
  const u = aufbau({ ping: { intervalSec: 240, maxIdleMin: 60, heartbeatGraceSec: 300 } });
  u.sitzungen.anfrage('sess', 'k0', 1);
  assert.equal(u.sitzungen.heartbeat('sess'), true);
  u.vor(200);
  melde(u);
  byte(u, 'k1');
  u.vor(240); // Heartbeat 440 s alt, echte Anfrage 240 s alt
  await u.planer.pruefe();
  assert.equal(u.gesendet.length, 1);
});

test('K36: neue echte Anfrage bricht den laufenden Ping des alten Zustands ab', async () => {
  let freigeben;
  const u = aufbau({ antwort: () => new Promise((r) => { freigeben = () => r({ status: 200, usage: {} }); }) });
  melde(u);
  byte(u, 'k1');
  u.vor(240);
  const laeuft = u.planer.pruefe();
  await new Promise((r) => setImmediate(r));
  assert.equal(u.gesendet[0].signal.aborted, false);
  melde(u);
  assert.equal(u.gesendet[0].signal.aborted, true);
  freigeben();
  await laeuft;
  assert.equal(u.planer.anzahl(), 1);
});

test('K37/K59: von uns abgebrochene Pings: Zeile mit status null, fehler abgebrochen, kosten null; Zustand unberuehrt', async () => {
  const abbruch = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  let ablehnen;
  const u = aufbau({ antwort: () => new Promise((_, rej) => { ablehnen = () => rej(abbruch); }) });
  melde(u);
  byte(u, 'k1');
  u.vor(240);
  const laeuft = u.planer.pruefe();
  await new Promise((r) => setImmediate(r));
  u.planer.sessionEnde('sess');
  ablehnen();
  await laeuft;
  const pings = leseProtokoll(u.logPfad).filter((z) => z.art === 'ping');
  assert.equal(pings.length, 1);
  assert.equal(pings[0].status, null);
  assert.equal(pings[0].fehler, 'abgebrochen');
  assert.equal(pings[0].kosten, null);
  assert.equal(u.planer.anzahl(), 0);
});

test('K59: abgebrochener Ping durch neue Anfrage wird protokolliert, der neue Zustand bleibt', async () => {
  let freigeben;
  const u = aufbau({ antwort: () => new Promise((r) => { freigeben = () => r({ status: 200, usage: {} }); }) });
  melde(u);
  byte(u, 'k1');
  u.vor(240);
  const laeuft = u.planer.pruefe();
  await new Promise((r) => setImmediate(r));
  melde(u);
  freigeben();
  await laeuft;
  const pings = leseProtokoll(u.logPfad).filter((z) => z.art === 'ping');
  assert.deepEqual(pings.map((z) => [z.status, z.fehler]), [[null, 'abgebrochen']]);
  assert.equal(u.planer.anzahl(), 1);
  assert.equal(u.planer.zustand('k1').laeuft, false);
});

test('K60: stoppe bricht laufende Pings ab und leert alle Zustaende', async () => {
  let freigeben;
  const u = aufbau({ antwort: () => new Promise((r) => { freigeben = () => r({ status: 200, usage: {} }); }) });
  melde(u);
  melde(u, { schluessel: 'k2' });
  byte(u, 'k1');
  u.vor(240);
  const laeuft = u.planer.pruefe();
  await new Promise((r) => setImmediate(r));
  u.planer.stoppe();
  assert.equal(u.gesendet[0].signal.aborted, true);
  assert.equal(u.planer.anzahl(), 0);
  freigeben();
  await laeuft;
  assert.equal(u.planer.anzahl(), 0);
});
