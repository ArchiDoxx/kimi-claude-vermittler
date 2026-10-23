// Lebenszeichen ueber Kimis Session-Lockdatei (lib/lebenszeichen.mjs), gegen ein temporaeres
// Kimi-Verzeichnis. Die echte ~/.kimi-code wird nie beruehrt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { erzeugeLebenszeichen, pidLebt } from '../lib/lebenszeichen.mjs';
import { tempOrdner } from './hilfen.mjs';

const ID = 'session_45b17fec-fe8a-487d-af63-1691d0006717';

function homeMitLock(inhalt, id = ID) {
  const home = tempOrdner('vermittler-lz-');
  const ordner = path.join(home, 'locks', 'sessions');
  fs.mkdirSync(ordner, { recursive: true });
  if (inhalt !== undefined) {
    fs.writeFileSync(path.join(ordner, `${id}.lock`), typeof inhalt === 'string' ? inhalt : JSON.stringify(inhalt));
  }
  return home;
}

function lock(pid, hostname = 'rechner') {
  return { version: 1, token: `${pid}:x`, pid, hostname, startedAt: 1, clientIdentity: 'kimi_code_cli' };
}

test('pidLebt: eigener Prozess lebt, eine sicher freie PID nicht', () => {
  assert.equal(pidLebt(process.pid), true);
  assert.equal(pidLebt(2 ** 30), false);
});

test('laufender Kimi-Prozess: true; beendeter: false', () => {
  const home = homeMitLock(lock(1234));
  const lebt = (pid) => pid === 1234;
  assert.equal(erzeugeLebenszeichen({ kimiHome: home, hostname: 'rechner', lebt })(ID), true);
  assert.equal(erzeugeLebenszeichen({ kimiHome: home, hostname: 'rechner', lebt: () => false })(ID), false);
});

test('echte PID-Pruefung: Lockdatei mit der eigenen PID lebt', () => {
  const home = homeMitLock(lock(process.pid));
  assert.equal(erzeugeLebenszeichen({ kimiHome: home, hostname: 'rechner' })(ID), true);
});

test('unbekannt (null): keine Lockdatei, kaputtes JSON, keine PID, anderer Rechner', () => {
  const lebt = () => true;
  const fall = (home) => erzeugeLebenszeichen({ kimiHome: home, hostname: 'rechner', lebt })(ID);
  assert.equal(fall(homeMitLock(undefined)), null);
  assert.equal(fall(homeMitLock('{kaputt')), null);
  assert.equal(fall(homeMitLock({ hostname: 'rechner' })), null);
  assert.equal(fall(homeMitLock(lock(-5))), null);
  assert.equal(fall(homeMitLock(lock(1234, 'anderer'))), null);
  assert.equal(fall(homeMitLock('[1,2]')), null);
});

test('nur Session-IDs im Kimi-Format, kein Pfad aus der Anfrage', () => {
  const gelesen = [];
  const lz = erzeugeLebenszeichen({
    kimiHome: 'C:/kimi', hostname: 'rechner', lebt: () => true,
    lese: (datei) => { gelesen.push(datei); return JSON.stringify(lock(1)); },
  });
  for (const id of [undefined, null, 42, '', 'S', '../../etc/passwd', 'session_../x', 'session_a/b', `session_${'a'.repeat(200)}`]) {
    assert.equal(lz(id), null, String(id));
  }
  assert.equal(gelesen.length, 0);
  assert.equal(lz(ID), true);
  assert.equal(path.basename(gelesen[0]), `${ID}.lock`);
  assert.equal(path.basename(path.dirname(gelesen[0])), 'sessions');
});

test('uebergrosse Lockdatei wird nicht ausgewertet', () => {
  const lz = erzeugeLebenszeichen({ kimiHome: 'C:/kimi', hostname: 'rechner', lebt: () => true, lese: () => ' '.repeat(5000) });
  assert.equal(lz(ID), null);
});
