// Lebenszeichen einer Kimi-Session ohne SessionHeartbeat-Hook (ab Version 0.5.0).
// Kimi Code CLI 2.3.0 lehnt `event = "SessionHeartbeat"` beim Schreiben der config.toml ab
// (Login, Provider- und Modellwechsel scheitern mit config.invalid), obwohl die Hook-Engine das
// Ereignis kennt. Der Vermittler fragt deshalb selbst: Kimi legt je laufender Session
// `<kimiHome>/locks/sessions/<session-id>.lock` mit `pid` und `hostname` an, und die Session-ID
// steht in jeder Claude-Anfrage als `metadata.user_id`.
//
// Ergebnis je Session: true (Kimi-Prozess laeuft), false (Lockdatei da, Prozess weg: Absturz)
// oder null (unbekannt: keine Lockdatei, fremdes Format, anderer Rechner). Bei null greift im
// Ping-Planer die alte Gnadenfrist. Gelesen wird nur die Lockdatei, nie etwas anderes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SESSION_ID = /^session_[A-Za-z0-9-]{1,128}$/;
const MAX_LOCK_BYTES = 4096;

export function standardKimiHome() {
  const env = process.env.KIMI_CODE_HOME;
  return typeof env === 'string' && env.length > 0 ? env : path.join(os.homedir(), '.kimi-code');
}

export function pidLebt(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (fehler) {
    return fehler?.code === 'EPERM';
  }
}

function leseLock(datei, lese) {
  try {
    const text = lese(datei);
    if (typeof text !== 'string' || text.length > MAX_LOCK_BYTES) return null;
    const json = JSON.parse(text);
    return json && typeof json === 'object' && !Array.isArray(json) ? json : null;
  } catch {
    return null;
  }
}

export function erzeugeLebenszeichen({
  kimiHome = standardKimiHome(),
  hostname = os.hostname(),
  lebt = pidLebt,
  lese = (datei) => fs.readFileSync(datei, 'utf8'),
} = {}) {
  const ordner = path.join(kimiHome, 'locks', 'sessions');
  return function lebenszeichen(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
    const lock = leseLock(path.join(ordner, `${sessionId}.lock`), lese);
    if (!lock || !Number.isInteger(lock.pid) || lock.pid <= 0) return null;
    if (typeof lock.hostname === 'string' && lock.hostname !== hostname) return null;
    return lebt(lock.pid);
  };
}
