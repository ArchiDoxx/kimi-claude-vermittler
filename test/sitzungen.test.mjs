import { test } from 'node:test';
import assert from 'node:assert/strict';
import { erzeugeSitzungen } from '../lib/sitzungen.mjs';

function neu() {
  let ms = 1_000_000;
  const s = erzeugeSitzungen({ jetzt: () => ms });
  return { s, vor: (sek) => { ms += sek * 1000; }, jetzt: () => ms };
}

test('anfrage legt Session an, erster Schluessel wird Haupt-Schluessel', () => {
  const { s, jetzt } = neu();
  s.anfrage('S', 'k-haupt', 5000);
  const z = s.zustand('S');
  assert.equal(z.hauptSchluessel, 'k-haupt');
  assert.equal(z.schluessel['k-haupt'].startMs, jetzt());
  assert.equal(z.schluessel['k-haupt'].ersteByteMs, null);
  assert.equal(z.schluessel['k-haupt'].sockelLaenge, 5000);
  assert.equal(z.letzterHeartbeatMs, null);
});

test('K15: kleine Nebenanfrage zuerst, grosse danach -> die grosse ist Haupt; subagent-ende verwirft nur die kleine', () => {
  const { s, vor } = neu();
  s.anfrage('S', 'k-titel', 300);
  vor(1);
  s.anfrage('S', 'k-haupt', 50000);
  assert.equal(s.zustand('S').hauptSchluessel, 'k-haupt');
  vor(1);
  s.anfrage('S', 'k-titel', 300);
  assert.equal(s.zustand('S').hauptSchluessel, 'k-haupt', 'spaetere kleine Anfrage aendert nichts');
  assert.equal(s.subagentEnde('S'), 1);
  assert.deepEqual(Object.keys(s.zustand('S').schluessel), ['k-haupt']);
});

test('K15: Gleichstand der Sockelgroesse -> der juengste Schluessel ist Haupt (Modellwechsel)', () => {
  const { s, vor } = neu();
  s.anfrage('S', 'k1', 50000);
  s.anfrage('S', 'k-sub', 20000);
  assert.equal(s.zustand('S').hauptSchluessel, 'k1');
  vor(1);
  s.anfrage('S', 'k2', 50000);
  assert.equal(s.zustand('S').hauptSchluessel, 'k2');
});

test('ersteByte setzt den Zeitpunkt des ersten Antwort-Bytes', () => {
  const { s, vor, jetzt } = neu();
  s.anfrage('S', 'k', 10);
  vor(2);
  s.ersteByte('S', 'k');
  assert.equal(s.zustand('S').schluessel.k.ersteByteMs, jetzt());
});

test('K45: heartbeat setzt Lebenszeichen nur fuer bekannte Sessions, legt keine neuen an', () => {
  const { s, jetzt } = neu();
  assert.equal(s.heartbeat('S'), false);
  assert.equal(s.zustand('S'), null);
  assert.equal(s.anzahl(), 0);
  s.anfrage('S', 'k', 10);
  assert.equal(s.heartbeat('S'), true);
  assert.equal(s.zustand('S').letzterHeartbeatMs, jetzt());
});

test('sessionEnde verwirft den gesamten Zustand', () => {
  const { s } = neu();
  s.anfrage('S', 'k', 10);
  assert.equal(s.sessionEnde('S'), true);
  assert.equal(s.zustand('S'), null);
  assert.equal(s.sessionEnde('S'), false);
});

test('subagentEnde verwirft alle Schluessel ausser dem Haupt-Schluessel', () => {
  const { s } = neu();
  s.anfrage('S', 'k-haupt', 9000);
  s.anfrage('S', 'k-sub1', 100);
  s.anfrage('S', 'k-sub2', 200);
  assert.equal(s.subagentEnde('S'), 2);
  assert.deepEqual(Object.keys(s.zustand('S').schluessel), ['k-haupt']);
  assert.equal(s.subagentEnde('unbekannt'), 0);
});

test('zustand liefert eine eingefrorene Kopie; Aenderungen daran wirken nicht zurueck', () => {
  const { s } = neu();
  s.anfrage('S', 'k', 10);
  const z = s.zustand('S');
  assert.throws(() => { z.hauptSchluessel = 'x'; });
  assert.equal(s.zustand('S').hauptSchluessel, 'k');
});

test('Sessions ohne Aktivitaet verfallen nach maxAlterMs', () => {
  let ms = 0;
  const s = erzeugeSitzungen({ jetzt: () => ms, maxAlterMs: 1000 });
  s.anfrage('alt', 'k', 10);
  ms = 5000;
  s.anfrage('neu', 'k', 10);
  assert.equal(s.zustand('alt'), null);
  assert.equal(s.anzahl(), 1);
});

test('K20: Standard-Verfall nach 2 h Inaktivitaet', () => {
  const { s, vor } = neu();
  s.anfrage('alt', 'k', 10);
  vor(2 * 3600 - 10);
  s.anfrage('neu', 'k', 10);
  assert.ok(s.zustand('alt'), 'knapp unter 2 h bleibt');
  vor(20);
  s.anfrage('neu', 'k', 10);
  assert.equal(s.zustand('alt'), null);
});

test('Aufrufe ohne Session-Kennung werden ignoriert', () => {
  const { s } = neu();
  s.anfrage(null, 'k', 10);
  s.heartbeat('');
  assert.equal(s.anzahl(), 0);
});
