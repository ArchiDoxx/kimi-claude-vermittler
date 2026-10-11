// Gemeinsame Testhilfen. Keine Tests in dieser Datei.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tiefFrieren(wert) {
  if (wert && typeof wert === 'object') {
    Object.values(wert).forEach(tiefFrieren);
    Object.freeze(wert);
  }
  return wert;
}

const angelegt = [];
process.on('exit', () => {
  for (const ordner of angelegt) {
    try {
      fs.rmSync(ordner, { recursive: true, force: true });
    } catch {
      // gesperrte Datei: bleibt liegen, kein Testfehler
    }
  }
});

// Temp-Ordner, der beim Ende des Testprozesses wieder entfernt wird.
export function tempOrdner(praefix = 'vermittler-test-') {
  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), praefix));
  angelegt.push(ordner);
  return ordner;
}

export const TESTSCHLUESSEL = 'sk-ant-TESTSCHLUESSEL-0000';

export const WURZEL = path.resolve(import.meta.dirname, '..');

// Liefert einen gerade freien Port auf 127.0.0.1.
export async function freierPort() {
  const { default: http } = await import('node:http');
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export function schreibeKonfig(ordner, werte) {
  const pfad = path.join(ordner, 'vermittler.json');
  fs.writeFileSync(pfad, JSON.stringify(werte, null, 2));
  return pfad;
}

// Startet ein Node-Skript, schreibt stdin, sammelt stdout und stderr.
export async function fuehreAus(args, { stdin = '', timeoutMs = 15000 } = {}) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const kind = spawn(process.execPath, args, { cwd: WURZEL, windowsHide: true });
    const aus = [];
    const fehler = [];
    const start = Date.now();
    const uhr = setTimeout(() => { kind.kill(); reject(new Error(`Zeitueberschreitung: ${args.join(' ')}`)); }, timeoutMs);
    kind.stdout.on('data', (t) => aus.push(t));
    kind.stderr.on('data', (t) => fehler.push(t));
    kind.on('error', reject);
    kind.on('close', (code) => {
      clearTimeout(uhr);
      resolve({ code, stdout: Buffer.concat(aus).toString('utf8'), stderr: Buffer.concat(fehler).toString('utf8'), dauerMs: Date.now() - start });
    });
    kind.stdin.on('error', () => {});
    kind.stdin.end(stdin);
  });
}
