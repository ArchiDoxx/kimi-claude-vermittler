import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  sha12, preisFuer, normalisiereUsage, kostenAus, gegenrechnung, kennungen, pingAnzahl,
  erzeugeProtokoll, leseProtokoll, werteAus, formatiereBericht,
} from '../lib/protokoll.mjs';
import { tempOrdner, TESTSCHLUESSEL } from './hilfen.mjs';

const PREIS = { input: 4, w5m: 5, w1h: 8, read: 0.2, output: 20 };
const PING = { intervalSec: 240, maxIdleMin: 60 };

function gr(usage, abstandSek, vorigesPraefix = null) {
  return gegenrechnung({ usage, preis: PREIS, abstandSek, vorigesPraefix, sockelAnteil: 0.5, ping: PING });
}

test('sha12 liefert 12 Hex-Zeichen und ist deterministisch', () => {
  assert.match(sha12('abc'), /^[0-9a-f]{12}$/);
  assert.equal(sha12('abc'), sha12('abc'));
  assert.notEqual(sha12('abc'), sha12('abd'));
});

test('preisFuer: Praefix-Treffer, unbekannt ergibt null', () => {
  const preise = { 'claude-opus-5-5': PREIS };
  assert.equal(preisFuer(preise, 'claude-opus-5-5'), PREIS);
  assert.equal(preisFuer(preise, 'claude-opus-5-5-20261001'), PREIS);
  assert.equal(preisFuer(preise, 'claude-unbekannt'), null);
  assert.equal(preisFuer(preise, undefined), null);
});

test('normalisiereUsage: zerlegt cache_creation, faellt ohne Zerlegung auf 5m zurueck', () => {
  assert.deepEqual(normalisiereUsage({
    input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 50,
    cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 40 }, output_tokens: 7,
  }), { input: 3, cache_read: 100, cache_w5m: 10, cache_w1h: 40, output: 7 });
  assert.deepEqual(normalisiereUsage({ input_tokens: 1, cache_creation_input_tokens: 9, output_tokens: 2 }),
    { input: 1, cache_read: 0, cache_w5m: 9, cache_w1h: 0, output: 2 });
  assert.deepEqual(normalisiereUsage(undefined), { input: 0, cache_read: 0, cache_w5m: 0, cache_w1h: 0, output: 0 });
});

test('K21: cache_creation ohne ephemeral-Felder faellt auf cache_creation_input_tokens zurueck', () => {
  assert.deepEqual(normalisiereUsage({ input_tokens: 1, cache_creation_input_tokens: 70, cache_creation: {}, output_tokens: 2 }),
    { input: 1, cache_read: 0, cache_w5m: 70, cache_w1h: 0, output: 2 });
});

test('K17: normalisiereUsage ist idempotent (bereits normalisierte Form bleibt)', () => {
  const n = { input: 1, cache_read: 2, cache_w5m: 3, cache_w1h: 4, output: 5 };
  assert.deepEqual(normalisiereUsage(n), n);
});

test('K20: tool_choice gehoert zum Schluessel-Hash', () => {
  const basis = { model: 'm', metadata: { user_id: 'S' }, system: 's', tools: [], messages: [] };
  assert.notEqual(kennungen(basis).schluessel, kennungen({ ...basis, tool_choice: { type: 'auto' } }).schluessel);
});

test('K15: kennungen liefert die Sockellaenge (Zeichen von tools + system)', () => {
  const body = { system: 'abc', tools: [{ name: 'x' }], messages: [{ role: 'user', content: 'lang'.repeat(50) }] };
  assert.equal(kennungen(body).sockelLaenge, JSON.stringify(body.tools).length + JSON.stringify(body.system).length);
});

test('kostenAus rechnet Listenpreise je Million Tokens', () => {
  const usage = { input: 10, cache_read: 1000, cache_w5m: 0, cache_w1h: 100, output: 50 };
  assert.equal(kostenAus(usage, PREIS), 0.00204);
  assert.equal(kostenAus(usage, null), null);
});

test('Gegenrechnung Fall 1: erste Anfrage (kein Abstand)', () => {
  const usage = { input: 10, cache_read: 0, cache_w5m: 0, cache_w1h: 1100, output: 50 };
  assert.deepEqual(gr(usage, null), { ttl1h: 0.00984, ping: 0.00654, sockel1h: 0.00819, heute: 0.00654 });
});

test('Gegenrechnung Fall 2: Abstand unter 5 min', () => {
  const usage = { input: 10, cache_read: 1000, cache_w5m: 0, cache_w1h: 100, output: 50 };
  assert.deepEqual(gr(usage, 120, 1000), { ttl1h: 0.00204, ping: 0.00174, sockel1h: 0.00174, heute: 0.00174 });
});

test('Gegenrechnung Fall 3: Abstand 5 bis 60 min', () => {
  const usage = { input: 10, cache_read: 1000, cache_w5m: 0, cache_w1h: 100, output: 50 };
  assert.deepEqual(gr(usage, 600, 1000), { ttl1h: 0.00204, ping: 0.00214, sockel1h: 0.0039, heute: 0.00654 });
});

test('Gegenrechnung Fall 4: Abstand ueber 60 min', () => {
  const usage = { input: 10, cache_read: 0, cache_w5m: 0, cache_w1h: 1100, output: 50 };
  assert.deepEqual(gr(usage, 4000, 1000), { ttl1h: 0.00984, ping: 0.00954, sockel1h: 0.00819, heute: 0.00654 });
});

test('pingAnzahl: Pings nur bei k*Intervall strikt kleiner als der Abstand, hoechstens bis maxIdle', () => {
  assert.equal(pingAnzahl(null, PING), 0);
  assert.equal(pingAnzahl(120, PING), 0);
  assert.equal(pingAnzahl(240, PING), 0);
  assert.equal(pingAnzahl(241, PING), 1);
  assert.equal(pingAnzahl(480, PING), 1);
  assert.equal(pingAnzahl(600, PING), 2);
  assert.equal(pingAnzahl(3600, PING), 14);
  assert.equal(pingAnzahl(3601, PING), 15);
  assert.equal(pingAnzahl(99999, PING), 15);
});

test('Gegenrechnung: Ping auch unter 5 min Abstand, sobald das Intervall ueberschritten ist (241 s)', () => {
  const usage = { input: 10, cache_read: 1000, cache_w5m: 0, cache_w1h: 100, output: 50 };
  assert.deepEqual(gr(usage, 241, 1000), { ttl1h: 0.00204, ping: 0.00194, sockel1h: 0.00174, heute: 0.00174 });
});

test('Gegenrechnung ohne Preis ergibt null', () => {
  assert.equal(gegenrechnung({ usage: normalisiereUsage({}), preis: null, abstandSek: null, vorigesPraefix: null, sockelAnteil: 0, ping: PING }), null);
});

test('kennungen: Session-Hash, Schluessel trennt Subagenten, Sockelanteil zwischen 0 und 1', () => {
  const haupt = { model: 'm', metadata: { user_id: 'S1' }, system: 'Haupt', tools: [{ name: 'a' }], messages: [{ role: 'user', content: 'x'.repeat(100) }] };
  const sub = { ...haupt, system: 'Subagent' };
  const k1 = kennungen(haupt);
  const k2 = kennungen(sub);
  assert.equal(k1.session, sha12('S1'));
  assert.equal(k1.session, k2.session);
  assert.notEqual(k1.schluessel, k2.schluessel);
  assert.ok(k1.sockelAnteil > 0 && k1.sockelAnteil < 1);
  assert.equal(kennungen({ messages: [] }).session, null);
});

function neuesProtokoll(startMs = Date.parse('2026-10-11T10:00:00Z')) {
  const ordner = tempOrdner();
  const logPfad = path.join(ordner, 'sub', 'protokoll.jsonl');
  let jetztMs = startMs;
  const p = erzeugeProtokoll({
    logPfad,
    konfig: { preise: { 'claude-opus-5-5': PREIS }, ping: PING },
    jetzt: () => jetztMs,
  });
  return { p, logPfad, vorspulen: (sek) => { jetztMs += sek * 1000; } };
}

const KENN = { session: 'aaaaaaaaaaaa', schluessel: 'bbbbbbbbbbbb', systemHash: 'cccccccccccc', sockelAnteil: 0.5 };

test('Protokoll: schreibt JSONL mit allen Pflichtfeldern, legt Ordner an', () => {
  const { p, logPfad } = neuesProtokoll();
  const h = p.beginn({ ...KENN, modell: 'claude-opus-5-5', modus: 'ttl1h', marken: 3 });
  const e = p.ende(h, { status: 200, usage: { input: 10, cache_read: 0, cache_w5m: 0, cache_w1h: 1100, output: 50 } });
  const zeilen = leseProtokoll(logPfad);
  assert.equal(zeilen.length, 1);
  assert.deepEqual(zeilen[0], e);
  for (const feld of ['ts', 'session', 'schluessel', 'modell', 'modus', 'art', 'status', 'input', 'cache_read',
    'cache_w5m', 'cache_w1h', 'output', 'sekundenSeitLetzter', 'kosten', 'gegenrechnung']) {
    assert.ok(feld in e, `fehlt: ${feld}`);
  }
  assert.equal(e.art, 'anfrage');
  assert.equal(e.sekundenSeitLetzter, null);
  assert.equal(e.ts, '2026-10-11T10:00:00.000Z');
  assert.equal(e.warnung, undefined);
});

test('Protokoll: sekundenSeitLetzter je Schluessel und Gegenrechnung mit vorigem Praefix', () => {
  const { p, vorspulen } = neuesProtokoll();
  const h1 = p.beginn({ ...KENN, modell: 'claude-opus-5-5', modus: 'ttl1h', marken: 3 });
  p.ende(h1, { status: 200, usage: { input: 10, cache_read: 0, cache_w5m: 0, cache_w1h: 1000, output: 50 } });
  vorspulen(600);
  const h2 = p.beginn({ ...KENN, modell: 'claude-opus-5-5', modus: 'ttl1h', marken: 3 });
  const e2 = p.ende(h2, { status: 200, usage: { input: 10, cache_read: 1000, cache_w5m: 0, cache_w1h: 100, output: 50 } });
  assert.equal(e2.sekundenSeitLetzter, 600);
  assert.deepEqual(e2.gegenrechnung, { ttl1h: 0.00204, ping: 0.00214, sockel1h: 0.0039, heute: 0.00654 });
  assert.equal(e2.kosten, 0.00204);
});

test('Fehlgeschlagene oder abgebrochene Anfrage schreibt das vorige Praefix nicht fort', () => {
  const { p, vorspulen } = neuesProtokoll();
  p.ende(p.beginn({ ...KENN, modell: 'claude-opus-5-5', modus: 'ttl1h', marken: 3 }), { status: 200, usage: { input: 10, cache_read: 0, cache_w5m: 0, cache_w1h: 1000, output: 50 } });
  vorspulen(10);
  p.ende(p.beginn({ ...KENN, modell: 'claude-opus-5-5', modus: 'ttl1h', marken: 3 }), { status: 529, usage: normalisiereUsage({}) });
  vorspulen(10);
  p.ende(p.beginn({ ...KENN, modell: 'claude-opus-5-5', modus: 'ttl1h', marken: 3 }), { status: 200, usage: normalisiereUsage({}), abbruch: true });
  vorspulen(600);
  const e = p.ende(p.beginn({ ...KENN, modell: 'claude-opus-5-5', modus: 'ttl1h', marken: 3 }), { status: 200, usage: { input: 10, cache_read: 1000, cache_w5m: 0, cache_w1h: 100, output: 50 } });
  assert.deepEqual(e.gegenrechnung, { ttl1h: 0.00204, ping: 0.00214, sockel1h: 0.0039, heute: 0.00654 });
});

test('K17: ende vertraegt fehlende und rohe usage', () => {
  const { p } = neuesProtokoll();
  const e1 = p.ende(p.beginn({ ...KENN, modell: 'claude-opus-5-5', modus: 'ttl1h', marken: 3 }), { status: 502 });
  assert.equal(e1.input, 0);
  const e2 = p.ende(p.beginn({ ...KENN, modell: 'claude-opus-5-5', modus: 'ttl1h', marken: 3 }), { status: 200, usage: { input_tokens: 7, cache_read_input_tokens: 9 } });
  assert.equal(e2.input, 7);
  assert.equal(e2.cache_read, 9);
});

test('K20: Schluessel- und Systemzustand verfallen nach 2 h Inaktivitaet', () => {
  const { p, vorspulen } = neuesProtokoll();
  p.ende(p.beginn({ ...KENN, modell: 'claude-opus-5-5', modus: 'ttl1h', marken: 3 }), { status: 200, usage: normalisiereUsage({}) });
  vorspulen(3 * 3600);
  p.ende(p.beginn({ ...KENN, schluessel: 'anderer', session: 'zzzzzzzzzzzz', systemHash: 'anderes-system', modell: 'claude-opus-5-5', modus: 'ttl1h', marken: 3 }), { status: 200, usage: normalisiereUsage({}) });
  const e = p.ende(p.beginn({ ...KENN, modell: 'claude-opus-5-5', modus: 'ttl1h', marken: 3 }), { status: 200, usage: normalisiereUsage({}) });
  assert.equal(e.sekundenSeitLetzter, null, 'alter Schluesselzustand ist weg');
});

test('Warnung: Markenzahl ungleich 3', () => {
  const { p } = neuesProtokoll();
  const h = p.beginn({ ...KENN, modell: 'claude-opus-5-5', modus: 'ttl1h', marken: 2 });
  const e = p.ende(h, { status: 200, usage: normalisiereUsage({}) });
  assert.deepEqual(e.warnung, ['marken:2']);
});

test('Warnung: Praefix gebrochen bei Folgeanfrage innerhalb der Haltezeit', () => {
  const { p, vorspulen } = neuesProtokoll();
  const h1 = p.beginn({ ...KENN, modell: 'claude-opus-5-5', modus: 'ttl1h', marken: 3 });
  p.ende(h1, { status: 200, usage: { input: 0, cache_read: 0, cache_w5m: 0, cache_w1h: 1000, output: 1 } });
  vorspulen(60);
  const h2 = p.beginn({ ...KENN, modell: 'claude-opus-5-5', modus: 'ttl1h', marken: 3 });
  const e2 = p.ende(h2, { status: 200, usage: { input: 5, cache_read: 0, cache_w5m: 0, cache_w1h: 1100, output: 1 } });
  assert.deepEqual(e2.warnung, ['praefix-gebrochen']);
});

test('Keine Praefix-Warnung, wenn die Haltezeit abgelaufen ist', () => {
  const { p, vorspulen } = neuesProtokoll();
  const h1 = p.beginn({ ...KENN, modell: 'claude-opus-5-5', modus: 'aus', marken: 3 });
  p.ende(h1, { status: 200, usage: { input: 0, cache_read: 0, cache_w5m: 1000, cache_w1h: 0, output: 1 } });
  vorspulen(400);
  const h2 = p.beginn({ ...KENN, modell: 'claude-opus-5-5', modus: 'aus', marken: 3 });
  const e2 = p.ende(h2, { status: 200, usage: { input: 0, cache_read: 0, cache_w5m: 1100, cache_w1h: 0, output: 1 } });
  assert.equal(e2.warnung, undefined);
});

test('Warnung: user_id-Wechsel binnen 10 min bei gleichem System-Hash', () => {
  const { p, vorspulen } = neuesProtokoll();
  p.ende(p.beginn({ ...KENN, modell: 'claude-opus-5-5', modus: 'ttl1h', marken: 3 }), { status: 200, usage: normalisiereUsage({}) });
  vorspulen(300);
  const h = p.beginn({ ...KENN, session: 'dddddddddddd', schluessel: 'eeeeeeeeeeee', modell: 'claude-opus-5-5', modus: 'ttl1h', marken: 3 });
  const e = p.ende(h, { status: 200, usage: normalisiereUsage({}) });
  assert.deepEqual(e.warnung, ['session-wechsel']);
  vorspulen(700);
  const h3 = p.beginn({ ...KENN, modell: 'claude-opus-5-5', modus: 'ttl1h', marken: 3 });
  assert.equal(p.ende(h3, { status: 200, usage: normalisiereUsage({}) }).warnung, undefined);
});

function sendeAls(p, session) {
  const h = p.beginn({ ...KENN, session, schluessel: `${session}-k`, modell: 'claude-opus-5-5', modus: 'ttl1h', marken: 3 });
  return p.ende(h, { status: 200, usage: normalisiereUsage({}) }).warnung;
}

test('session-wechsel: zwei parallele Sitzungen im selben Ordner erzeugen kein Rauschen', () => {
  const { p, vorspulen } = neuesProtokoll();
  assert.equal(sendeAls(p, 'A'), undefined);
  vorspulen(30);
  assert.equal(sendeAls(p, 'B'), undefined, 'A war vor 30 s aktiv: kein Wechsel');
  for (let i = 0; i < 6; i += 1) {
    vorspulen(90);
    assert.equal(sendeAls(p, i % 2 === 0 ? 'A' : 'B'), undefined, `Hin und Her ${i}`);
  }
});

test('session-wechsel: bekannte Session nach dem Wechsel und dritte Session warnen nicht', () => {
  const { p, vorspulen } = neuesProtokoll();
  sendeAls(p, 'A');
  vorspulen(100);
  assert.deepEqual(sendeAls(p, 'B'), ['session-wechsel']);
  vorspulen(100);
  assert.equal(sendeAls(p, 'A'), undefined, 'A ist bekannt');
  vorspulen(100);
  assert.equal(sendeAls(p, 'C'), undefined, 'zwei andere Sessions in 10 min: kein eindeutiger Wechsel');
});

test('session-wechsel: genau 60 s Ruhe der alten Session reichen', () => {
  const { p, vorspulen } = neuesProtokoll();
  sendeAls(p, 'A');
  vorspulen(60);
  assert.deepEqual(sendeAls(p, 'B'), ['session-wechsel']);
});

test('Unbekanntes Modell: protokolliert, Kosten und Gegenrechnung null', () => {
  const { p } = neuesProtokoll();
  const e = p.ende(p.beginn({ ...KENN, modell: 'claude-neu-9', modus: 'ttl1h', marken: 3 }), { status: 200, usage: normalisiereUsage({ input_tokens: 5 }) });
  assert.equal(e.kosten, null);
  assert.equal(e.gegenrechnung, null);
  assert.equal(e.input, 5);
});

test('Durchgang-Eintrag traegt art durchgang und Pfad ohne Query', () => {
  const { p, logPfad } = neuesProtokoll();
  const e = p.durchgang({ pfad: '/v1/messages/count_tokens?beta=true', status: 200 });
  assert.equal(e.art, 'durchgang');
  assert.equal(e.pfad, '/v1/messages/count_tokens');
  assert.equal(leseProtokoll(logPfad).length, 1);
});

test('Kein Key im Eintrag: Eintragsfelder sind abgeschlossen, fremde Felder werden nicht uebernommen', () => {
  const { p, logPfad } = neuesProtokoll();
  const h = p.beginn({ ...KENN, modell: 'claude-opus-5-5', modus: 'ttl1h', marken: 3, apiKey: TESTSCHLUESSEL });
  p.ende(h, { status: 200, usage: normalisiereUsage({}), kopfzeilen: { 'x-api-key': TESTSCHLUESSEL } });
  p.durchgang({ pfad: `/v1/models?key=${TESTSCHLUESSEL}`, status: 200 });
  const inhalt = fs.readFileSync(logPfad, 'utf8');
  assert.equal(inhalt.includes('TESTSCHLUESSEL'), false);
});

test('Schreibfehler werfen nicht', () => {
  const p = erzeugeProtokoll({ logPfad: 'X:/gibt/es/nicht/\0/p.jsonl', konfig: { preise: {}, ping: PING }, meldeFehler: () => {} });
  assert.doesNotThrow(() => p.durchgang({ pfad: '/v1/models', status: 200 }));
});

test('leseProtokoll: fehlende Datei ergibt leere Liste, kaputte Zeilen werden uebersprungen', () => {
  const ordner = tempOrdner();
  assert.deepEqual(leseProtokoll(path.join(ordner, 'fehlt.jsonl')), []);
  const datei = path.join(ordner, 'p.jsonl');
  fs.writeFileSync(datei, '{"a":1}\nkaputt\n\n{"b":2}\n');
  assert.deepEqual(leseProtokoll(datei), [{ a: 1 }, { b: 2 }]);
});

test('protokoll.ping: Zeile art ping, Abstand zur echten Anfrage, ohne Gegenrechnung; Bericht zaehlt sie', () => {
  const { p, logPfad, vorspulen } = neuesProtokoll();
  const startMs = Date.parse('2026-10-11T10:00:00Z');
  vorspulen(240);
  const e = p.ping({ session: 'aaaaaaaaaaaa', schluessel: 'bbbbbbbbbbbb', modell: 'claude-opus-5-5', status: 200, usage: { input: 3, cache_read: 5000, cache_w5m: 0, cache_w1h: 0, output: 0 }, startMs });
  assert.equal(e.art, 'ping');
  assert.equal(e.modus, 'ping');
  assert.equal(e.sekundenSeitLetzter, 240);
  assert.equal(e.kosten, 0.001012);
  assert.equal(e.gegenrechnung, null);
  assert.equal(e.ts, '2026-10-11T10:04:00.000Z');
  const a = werteAus(leseProtokoll(logPfad), { seitMs: 0 });
  assert.equal(a.gruppen[0].pings, 1);
  assert.equal(a.gruppen[0].anfragen, 0);
  assert.equal(a.gruppen[0].kosten, 0.001012);
});

test('protokoll.ping mit Netzfehler: Status 0 und Fehlercode', () => {
  const { p } = neuesProtokoll();
  const e = p.ping({ session: null, schluessel: 'b', modell: 'claude-opus-5-5', status: 0, fehler: 'ECONNREFUSED', usage: normalisiereUsage(null), startMs: 0 });
  assert.equal(e.status, 0);
  assert.equal(e.fehler, 'ECONNREFUSED');
});

test('Bericht: summiert je Modell und Modus, Ersparnis gegen ttl1h, Zeitfenster', () => {
  const jetzt = Date.parse('2026-10-11T12:00:00Z');
  const zeilen = [
    { ts: '2026-10-11T11:00:00Z', art: 'anfrage', modell: 'claude-opus-5-5', modus: 'ttl1h', kosten: 1, gegenrechnung: { ttl1h: 1, ping: 0.5, sockel1h: 0.8, heute: 2 } },
    { ts: '2026-10-11T11:30:00Z', art: 'anfrage', modell: 'claude-opus-5-5', modus: 'ttl1h', kosten: 1, gegenrechnung: { ttl1h: 1, ping: 0.7, sockel1h: 0.8, heute: 1 }, warnung: ['marken:2'] },
    { ts: '2026-09-01T11:30:00Z', art: 'anfrage', modell: 'claude-opus-5-5', modus: 'ttl1h', kosten: 99, gegenrechnung: { ttl1h: 99, ping: 99, sockel1h: 99, heute: 99 } },
    { ts: '2026-10-11T11:40:00Z', art: 'durchgang', status: 200 },
    { ts: '2026-10-11T11:45:00Z', art: 'anfrage', modell: 'claude-neu', modus: 'ttl1h', kosten: null, gegenrechnung: null },
  ];
  const a = werteAus(zeilen, { seitMs: jetzt - 7 * 86400000 });
  const opus = a.gruppen.find((g) => g.modell === 'claude-opus-5-5');
  assert.equal(opus.anfragen, 2);
  assert.equal(opus.kosten, 2);
  assert.deepEqual(opus.gegenrechnung, { ttl1h: 2, ping: 1.2, sockel1h: 1.6, heute: 3 });
  assert.equal(opus.ersparnisGegenTtl1h.ping, 40);
  assert.equal(opus.warnungen, 1);
  assert.equal(a.durchgaenge, 1);
  const text = formatiereBericht(a);
  assert.match(text, /claude-opus-5-5/);
  assert.match(text, /claude-neu/);
});
