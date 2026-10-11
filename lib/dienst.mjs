// Dienststeuerung: Zustand pruefen, losgeloest starten, sauber stoppen, PID- und Logdatei.
// Alle Dateien liegen neben der Konfiguration (vermittler.json).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { VERSION, DIENST } from './kennung.mjs';

const EINSTIEG = path.join(import.meta.dirname, '..', 'vermittler.mjs');
const MAX_LOG_BYTES = 1024 * 1024;
const WARTEN_PORT_ZU_MS = 6000;
const WARTEN_PROZESS_WEG_MS = 8000;
const WARTEN_NACH_KILL_MS = 5000;

const schlafe = (ms) => new Promise((r) => setTimeout(r, ms));

function nebenKonfig(konfigPfad, name) {
  return path.join(path.dirname(path.resolve(konfigPfad)), name);
}

// Schreibt ueber eine Tempdatei im selben Ordner und benennt sie dann um.
export function schreibeAtomar(datei, inhalt) {
  const temp = `${datei}.${process.pid}.tmp`;
  fs.writeFileSync(temp, inhalt);
  fs.renameSync(temp, datei);
}

// ---------- PID-Datei ----------

export function pidDateiFuer(konfigPfad) {
  return nebenKonfig(konfigPfad, 'vermittler.pid');
}

export function lesePidDatei(konfigPfad) {
  try {
    return JSON.parse(fs.readFileSync(pidDateiFuer(konfigPfad), 'utf8'));
  } catch {
    return null;
  }
}

export function schreibePidDatei(konfigPfad, port) {
  schreibeAtomar(pidDateiFuer(konfigPfad), JSON.stringify({ pid: process.pid, port, version: VERSION, gestartet: new Date().toISOString() }));
}

// Entfernt die PID-Datei nur, wenn sie die genannte pid traegt (nie die einer neueren Instanz).
export function entfernePidDatei(konfigPfad, pid) {
  if (!konfigPfad) return;
  try {
    if (lesePidDatei(konfigPfad)?.pid === pid) fs.unlinkSync(pidDateiFuer(konfigPfad));
  } catch {
    // schon weg
  }
}

export function istGueltigePid(pid) {
  return Number.isInteger(pid) && pid > 0;
}

export function prozessLebt(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (fehler) {
    return fehler?.code === 'EPERM';
  }
}

async function warteBisWeg(pid, wartenMs) {
  const ende = Date.now() + wartenMs;
  for (;;) {
    if (!prozessLebt(pid)) return true;
    if (Date.now() >= ende) return false;
    await schlafe(100);
  }
}

// ---------- Logdatei ----------

// Kuerzt eine zu grosse Logdatei auf ihr letztes MAX_LOG_BYTES, ab der ersten ganzen Zeile,
// und oeffnet sie zum Anhaengen. Bei Fehlern Meldung und Start ohne Log.
function oeffneLog(konfigPfad, melde) {
  const datei = nebenKonfig(konfigPfad, 'vermittler.log');
  try {
    // Unter Windows laesst sich auch ein Ordner "zum Anhaengen" oeffnen; das waere als stderr
    // des Kindes toedlich. Daher ausdruecklich pruefen.
    if (fs.existsSync(datei) && !fs.statSync(datei).isFile()) {
      throw Object.assign(new Error('keine Datei'), { code: 'EISDIR' });
    }
    if (fs.existsSync(datei)) {
      const groesse = fs.statSync(datei).size;
      if (groesse > MAX_LOG_BYTES) {
        const puffer = Buffer.alloc(MAX_LOG_BYTES);
        const fd = fs.openSync(datei, 'r');
        let gelesen;
        try {
          gelesen = fs.readSync(fd, puffer, 0, MAX_LOG_BYTES, groesse - MAX_LOG_BYTES);
        } finally {
          fs.closeSync(fd);
        }
        const teil = puffer.subarray(0, gelesen);
        const zeilenende = teil.indexOf(0x0a);
        schreibeAtomar(datei, zeilenende >= 0 ? teil.subarray(zeilenende + 1) : teil);
      }
    }
    return fs.openSync(datei, 'a');
  } catch (fehler) {
    melde(`Logdatei nicht beschreibbar (${fehler?.code ?? 'unbekannt'}); Start ohne Log.`);
    return null;
  }
}

// ---------- Zustand ----------

// art: 'eigen' (mit health) | 'fremd' (antwortet, ist aber nicht der Vermittler) |
//      'keiner' (Verbindung abgelehnt) | 'besetzt' (nimmt an, antwortet nicht rechtzeitig) |
//      'unbekannt' (anderer Transportfehler, z. B. Verbindung gekappt)
export async function pruefeDienst(port, timeoutMs = 1000) {
  try {
    const antwort = await fetch(`http://127.0.0.1:${port}/_vermittler/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await antwort.text();
    let health = null;
    try {
      health = JSON.parse(text);
    } catch {
      health = null;
    }
    if (antwort.ok && health?.dienst === DIENST) return { art: 'eigen', health };
    return { art: 'fremd' };
  } catch (fehler) {
    if (fehler?.cause?.code === 'ECONNREFUSED') return { art: 'keiner' };
    if (fehler?.name === 'TimeoutError' || fehler?.name === 'AbortError') return { art: 'besetzt' };
    return { art: 'unbekannt', code: fehler?.cause?.code ?? fehler?.name };
  }
}

export async function warteAuf(port, gewuenscht, wartenMs) {
  const ende = Date.now() + wartenMs;
  for (;;) {
    const z = await pruefeDienst(port, 500);
    if (z.art === gewuenscht) return z;
    if (Date.now() >= ende) return null;
    await schlafe(100);
  }
}

// ---------- Start ----------

// Startet "serve" (oder einen anderen Unterbefehl) losgeloest; stderr des Kindes geht nach
// vermittler.log neben der Konfiguration. Liefert null bei Erfolg oder den Fehlercode.
export function starteLosgeloest(konfigPfad, { programm = process.execPath, befehl = 'serve', melde = () => {} } = {}) {
  return new Promise((resolve) => {
    const logFd = oeffneLog(konfigPfad, melde);
    const schliesseLog = () => {
      if (logFd === null) return;
      try {
        fs.closeSync(logFd);
      } catch {
        // schon zu
      }
    };
    let kind;
    try {
      kind = spawn(programm, [EINSTIEG, befehl, '--konfig', path.resolve(konfigPfad)], {
        detached: true, stdio: ['ignore', 'ignore', logFd ?? 'ignore'], windowsHide: true,
      });
    } catch (fehler) {
      schliesseLog();
      resolve(fehler?.code ?? 'SPAWN');
      return;
    }
    kind.once('spawn', () => {
      schliesseLog();
      kind.unref();
      resolve(null);
    });
    kind.once('error', (fehler) => {
      schliesseLog();
      resolve(fehler?.code ?? 'SPAWN');
    });
  });
}

// ---------- Stopp ----------

async function toete(pid, konfigPfad) {
  try {
    process.kill(pid);
  } catch (fehler) {
    if (fehler?.code === 'ESRCH') {
      entfernePidDatei(konfigPfad, pid);
      return 'weg';
    }
    return `kill-fehler:${fehler?.code ?? 'unbekannt'}`;
  }
  if (!(await warteBisWeg(pid, WARTEN_NACH_KILL_MS))) return 'haengt';
  entfernePidDatei(konfigPfad, pid);
  return 'getoetet';
}

// Beendet den eigenen Dienst: erst sauber ueber /_vermittler/stop (mit seiner pid). "gestoppt"
// heisst Prozess weg: Ist der Port zu und passt die PID-Datei, wird bis 8 s gewartet, bis der
// Prozess verschwunden ist, sonst Kill-Rueckfall. Getoetet wird nur mit gueltiger pid, die zur
// PID-Datei passt.
// Ergebnis: 'gestoppt' | 'getoetet' | 'pid-ungueltig' | 'pid-unbelegt' | 'kill-fehler:<code>' | 'haengt'.
export async function stoppeDienst(port, health, { konfigPfad, melde = () => {} } = {}) {
  try {
    const antwort = await fetch(`http://127.0.0.1:${port}/_vermittler/stop`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pid: health?.pid }), signal: AbortSignal.timeout(2000),
    });
    await antwort.arrayBuffer();
    if (antwort.status === 404) melde('Alter Dienst ohne Stopp-Endpunkt; pid aus `node vermittler.mjs status` von Hand beenden.');
    else if (!antwort.ok) melde(`Stopp-Endpunkt antwortet mit ${antwort.status}.`);
  } catch {
    // antwortet nicht: Rueckfall unten
  }
  const portZu = await warteAuf(port, 'keiner', WARTEN_PORT_ZU_MS);
  const gueltig = istGueltigePid(health?.pid);
  const passend = gueltig && Boolean(konfigPfad) && lesePidDatei(konfigPfad)?.pid === health.pid;
  if (portZu) {
    if (!passend || (await warteBisWeg(health.pid, WARTEN_PROZESS_WEG_MS))) return 'gestoppt';
  } else {
    if (!gueltig) return 'pid-ungueltig';
    if (!passend) return 'pid-unbelegt';
  }
  const erg = await toete(health.pid, konfigPfad);
  return erg === 'weg' ? 'gestoppt' : erg;
}

// Haengende eigene Instanz (nimmt an, antwortet nicht): nur mit PID-Datei fuer diesen Port und
// lebender pid wird getoetet. Ergebnis: 'besetzt-getoetet' | 'besetzt' | 'kill-fehler:<code>' | 'haengt'.
export async function stoppeHaengenden(port, konfigPfad) {
  const datei = lesePidDatei(konfigPfad);
  if (!datei || !istGueltigePid(datei.pid) || datei.port !== port || !prozessLebt(datei.pid)) return 'besetzt';
  const erg = await toete(datei.pid, konfigPfad);
  return erg === 'weg' || erg === 'getoetet' ? 'besetzt-getoetet' : erg;
}

// ---------- Sicherstellen ----------

// Liefert { ergebnis, health }. ergebnis: 'laeuft' | 'gestartet' | 'erneuert' |
// 'erneuerung-angestossen' | 'fremd' | 'besetzt' | 'spawn-fehler' | 'stopp-fehler' | 'zeitueberschreitung'.
// Erneuert wird bei anderer Version oder anderem konfigHash. 'besetzt' und 'unbekannt' bekommen
// einen zweiten Versuch nach 500 ms. erneuernLosgeloest: fuer den Start-Hook (Timeout 5 s).
export async function stelleSicher(konfig, { konfigPfad, wartenMs = 2000, programm, erneuernLosgeloest = false, melde = () => {} } = {}) {
  const ohne = (ergebnis) => ({ ergebnis, health: null });
  let z = await pruefeDienst(konfig.port, 500);
  if (z.art === 'besetzt' || z.art === 'unbekannt') {
    await schlafe(500);
    z = await pruefeDienst(konfig.port, 500);
  }
  if (z.art === 'besetzt') return ohne('besetzt');
  if (z.art === 'fremd' || z.art === 'unbekannt') return ohne('fremd');
  const startOptionen = { melde, ...(programm ? { programm } : {}) };
  let ergebnis = 'gestartet';
  if (z.art === 'eigen') {
    if (z.health.version === VERSION && z.health.konfigHash === konfig.konfigHash) return { ergebnis: 'laeuft', health: z.health };
    if (erneuernLosgeloest) {
      const fehler = await starteLosgeloest(konfigPfad, { ...startOptionen, befehl: 'start' });
      return ohne(fehler ? 'spawn-fehler' : 'erneuerung-angestossen');
    }
    const stopp = await stoppeDienst(konfig.port, z.health, { konfigPfad, melde });
    if (stopp !== 'gestoppt' && stopp !== 'getoetet') return ohne('stopp-fehler');
    ergebnis = 'erneuert';
  }
  if (await starteLosgeloest(konfigPfad, startOptionen)) return ohne('spawn-fehler');
  const neu = await warteAuf(konfig.port, 'eigen', wartenMs);
  return neu ? { ergebnis, health: neu.health } : ohne('zeitueberschreitung');
}
