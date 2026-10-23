import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ladeKonfig, normalisiereKonfig } from '../vermittler.mjs';
import { WURZEL, tempOrdner } from './hilfen.mjs';

const BASIS = 'C:/basis';
const still = { warne: () => {} };

test('Die ausgelieferte vermittler.json laedt: Port, Modus, vier Preise, Protokoll neben der Konfig (K40)', () => {
  const k = ladeKonfig();
  assert.equal(k.port, 37790);
  assert.equal(k.upstream, 'https://api.anthropic.com');
  assert.equal(k.mode, 'ttl1h');
  assert.deepEqual(Object.keys(k.preise).sort(), ['claude-fable-5-1', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.deepEqual(k.preise['claude-sonnet-5-5'], { input: 2, w5m: 2.5, w1h: 4, read: 0.1, output: 10 });
  assert.equal(k.logPath, path.join(WURZEL, 'protokoll.jsonl'));
  assert.ok(Object.isFrozen(k) && Object.isFrozen(k.preise));
});

test('normalisiereKonfig: Standardwerte, relative Pfade gegen den Konfig-Ordner', () => {
  const k = normalisiereKonfig({ logPath: 'p.jsonl' }, BASIS, still);
  assert.equal(k.port, 37790);
  assert.equal(k.ping.intervalSec, 240);
  assert.equal(k.logPath, path.resolve(BASIS, 'p.jsonl'));
});

test('normalisiereKonfig weist ungueltige Werte ab', () => {
  assert.throws(() => normalisiereKonfig({ mode: 'ewig' }, BASIS, still), /mode/);
  assert.throws(() => normalisiereKonfig({ modeByModel: { 'claude-x': 'ewig' } }, BASIS, still), /modeByModel/);
  assert.throws(() => normalisiereKonfig({ port: 70000 }, BASIS, still), /port/);
  assert.throws(() => normalisiereKonfig({ upstream: 'ftp://x' }, BASIS, still), /upstream/);
  assert.throws(() => normalisiereKonfig({ preise: { m: { input: 1 } } }, BASIS, still), /preise/);
  assert.throws(() => normalisiereKonfig({ ping: { intervalSec: 0 } }, BASIS, still), /ping/);
});

test('K7: port 1-65535, intervalSec unter 300, http nur fuer Loopback', () => {
  assert.throws(() => normalisiereKonfig({ port: 0 }, BASIS, still), /port/);
  assert.doesNotThrow(() => normalisiereKonfig({ port: 1 }, BASIS, still));
  assert.doesNotThrow(() => normalisiereKonfig({ port: 65535 }, BASIS, still));
  assert.throws(() => normalisiereKonfig({ ping: { intervalSec: 286 } }, BASIS, still), /intervalSec/);
  assert.doesNotThrow(() => normalisiereKonfig({ ping: { intervalSec: 285 } }, BASIS, still));
  assert.throws(() => normalisiereKonfig({ upstream: 'http://api.anthropic.com' }, BASIS, still), /https/);
  for (const ok of ['http://127.0.0.1:9', 'http://localhost:9', 'http://[::1]:9', 'https://api.anthropic.com']) {
    assert.doesNotThrow(() => normalisiereKonfig({ upstream: ok }, BASIS, still), ok);
  }
});

test('K26: Typen und Bereiche streng', () => {
  const faelle = [
    [{ port: '37790' }, /port/],
    [{ port: 37790.5 }, /port/],
    [{ ping: { intervalSec: 29 } }, /intervalSec/],
    [{ ping: { intervalSec: 60.5 } }, /intervalSec/],
    [{ ping: { intervalSec: '240' } }, /intervalSec/],
    [{ ping: { maxIdleMin: 0 } }, /maxIdleMin/],
    [{ ping: { maxIdleMin: 1441 } }, /maxIdleMin/],
    [{ ping: { heartbeatGraceSec: 29 } }, /heartbeatGraceSec/],
    [{ ping: { heartbeatGraceSec: 3601 } }, /heartbeatGraceSec/],
    [{ preise: { m: { input: -1, w5m: 1, w1h: 1, read: 1, output: 1 } } }, /preise/],
    [{ preise: { m: { input: '1', w5m: 1, w1h: 1, read: 1, output: 1 } } }, /preise/],
    [{ logPath: 5 }, /logPath/],
    [{ upstream: 'https://api.anthropic.com/v1' }, /upstream/],
    [{ upstream: 'https://api.anthropic.com/?x=1' }, /upstream/],
    [{ upstream: 'https://api.anthropic.com/#x' }, /upstream/],
  ];
  for (const [roh, muster] of faelle) assert.throws(() => normalisiereKonfig(roh, BASIS, still), muster, JSON.stringify(roh));
  for (const roh of [null, [], 'text', 5]) assert.throws(() => normalisiereKonfig(roh, BASIS, still), /Objekt/, JSON.stringify(roh));
  for (const ok of [{ ping: { intervalSec: 30, maxIdleMin: 1, heartbeatGraceSec: 30 } }, { ping: { intervalSec: 285, maxIdleMin: 1440, heartbeatGraceSec: 3600 } }, { upstream: 'https://api.anthropic.com/' }]) {
    assert.doesNotThrow(() => normalisiereKonfig(ok, BASIS, still), JSON.stringify(ok));
  }
});

test('K26: unbekannte Schluessel auf oberster Ebene erzeugen eine Warnung, keinen Abbruch', () => {
  const warnungen = [];
  const k = normalisiereKonfig({ prot: 1, mode: 'ttl1h' }, BASIS, { warne: (t) => warnungen.push(t) });
  assert.equal(k.mode, 'ttl1h');
  assert.deepEqual(warnungen, ['Konfig: unbekannter Schluessel "prot"']);
});

test('K25: konfigHash ist stabil gegen Schluesselreihenfolge und aendert sich mit dem Inhalt', () => {
  const a = normalisiereKonfig({ port: 1000, mode: 'ping' }, BASIS, still);
  const b = normalisiereKonfig({ mode: 'ping', port: 1000 }, 'D:/anderswo', still);
  const c = normalisiereKonfig({ port: 1001, mode: 'ping' }, BASIS, still);
  assert.match(a.konfigHash, /^[0-9a-f]{12}$/);
  assert.equal(a.konfigHash, b.konfigHash, 'Reihenfolge und Konfig-Ordner aendern den Hash nicht');
  assert.notEqual(a.konfigHash, c.konfigHash);
});

test('K29: UTF-8-BOM vor dem JSON wird vertragen', () => {
  const datei = path.join(tempOrdner(), 'vermittler.json');
  fs.writeFileSync(datei, `\uFEFF${JSON.stringify({ port: 4321 })}`);
  assert.equal(ladeKonfig(datei).port, 4321);
});

test('K30: JSON-Fehler meldet nur Position, nie den Quelltext', () => {
  const datei = path.join(tempOrdner(), 'vermittler.json');
  fs.writeFileSync(datei, '{ "port": 1, "geheim": GEHEIMNIS }');
  assert.throws(() => ladeKonfig(datei), (fehler) => {
    assert.match(fehler.message, /kein gueltiges JSON/);
    assert.equal(fehler.message.includes('GEHEIMNIS'), false);
    return true;
  });
});

// ---------- Iteration 6 ----------

test('K43: unbekannte Schluessel in ping und je preise.<modell> erzeugen Warnungen', () => {
  const warnungen = [];
  normalisiereKonfig({
    ping: { intervalSec: 240, intervallSek: 5 },
    preise: { 'claude-x': { input: 1, w5m: 1, w1h: 1, read: 1, output: 1, cache: 2 } },
  }, BASIS, { warne: (w) => warnungen.push(w) });
  assert.deepEqual(warnungen.sort(), ['Konfig: unbekannter Schluessel "ping.intervallSek"', 'Konfig: unbekannter Schluessel "preise.claude-x.cache"']);
});

test('K48: normalisiereKonfig veraendert und friert die Eingabe nicht ein', () => {
  const roh = { modeByModel: { 'claude-x': 'ping' }, ping: { intervalSec: 240 }, preise: { m: { input: 1, w5m: 1, w1h: 1, read: 1, output: 1 } } };
  const vorher = JSON.stringify(roh);
  const k = normalisiereKonfig(roh, BASIS, still);
  assert.equal(JSON.stringify(roh), vorher);
  assert.equal(Object.isFrozen(roh.preise.m), false);
  assert.equal(Object.isFrozen(roh.ping), false);
  assert.ok(Object.isFrozen(k.preise.m));
  assert.notEqual(k.preise.m, roh.preise.m);
});

test('0.5.0: kimiHome ist optional, wird aufgeloest und streng geprueft', () => {
  assert.equal(normalisiereKonfig({}, BASIS, still).kimiHome, null);
  assert.equal(normalisiereKonfig({ kimiHome: './kimi' }, BASIS, still).kimiHome, path.resolve(BASIS, './kimi'));
  assert.equal(normalisiereKonfig({ kimiHome: '~/.kimi-code' }, BASIS, still).kimiHome.endsWith('.kimi-code'), true);
  for (const kimiHome of ['', 5, {}, []]) {
    assert.throws(() => normalisiereKonfig({ kimiHome }, BASIS, still), /kimiHome/, JSON.stringify(kimiHome));
  }
  const warnungen = [];
  normalisiereKonfig({ kimiHome: './k' }, BASIS, { warne: (t) => warnungen.push(t) });
  assert.deepEqual(warnungen, [], 'kimiHome ist ein bekannter Schluessel');
});
