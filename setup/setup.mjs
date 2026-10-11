#!/usr/bin/env node
// Einrichtung des Anthropic-Vermittlers fuer Kimi Code CLI auf einer Maschine.
// Aufruf: node setup/setup.mjs [pruefen|einrichten|rueckweg] [--cu-win]
//         [--base-url-ersetzen] [--kimi-home <pfad>] [--konfig <vermittler.json>] [--ohne-dienst]
// Liest und schreibt config.toml zeilenbasiert; gibt nie Zeilen daraus aus und schreibt nie
// einen API-Schluessel. Ohne Abhaengigkeiten, idempotent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ladeKonfig, standardKonfigPfad, pruefeDienst } from '../vermittler.mjs';
import { schreibeAtomar } from '../lib/dienst.mjs';
import {
  setzeProvider, setzeBaseUrl, entferneBaseUrl, ergaenzeModelle, zaehleModelle, modellAliase, unsereHooks,
  ergaenzeHooks, entferneHooks, zaehleHooks, leseDefaultModel, leseBaseUrl, hatKeyZeile, leseKeyEnv,
  setzeCuWin, cuWinStatus, istLoopbackUrl,
} from './lib/toml-patch.mjs';

const WURZEL = path.resolve(import.meta.dirname, '..');
const MODELLE_PFAD = path.join(import.meta.dirname, 'modelle.toml');
const NODE_MINDEST = [20, 11];
const BEFEHLE = Object.freeze(['pruefen', 'einrichten', 'rueckweg']);

// ---------- Hilfen ----------

function ausgabe(text = '') {
  process.stdout.write(`${text}\n`);
}

function zeile(name, zustand) {
  ausgabe(`  ${name.padEnd(14)} ${zustand}`);
}

function argument(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function optionen(args) {
  const kimiHome = argument(args, '--kimi-home') ?? path.join(os.homedir(), '.kimi-code');
  const befehl = args[0] && !args[0].startsWith('--') ? args[0] : 'pruefen';
  return {
    befehl,
    kimiHome: path.resolve(kimiHome),
    toml: path.join(path.resolve(kimiHome), 'config.toml'),
    plugins: path.join(path.resolve(kimiHome), 'plugins', 'installed.json'),
    konfigPfad: path.resolve(argument(args, '--konfig') ?? standardKonfigPfad()),
    cuWin: args.includes('--cu-win'),
    ohneDienst: args.includes('--ohne-dienst'),
    baseUrlErsetzen: args.includes('--base-url-ersetzen'),
  };
}

function zweistellig(n) {
  return String(n).padStart(2, '0');
}

function zeitstempel(d = new Date()) {
  return `${d.getFullYear()}-${zweistellig(d.getMonth() + 1)}-${zweistellig(d.getDate())}-${zweistellig(d.getHours())}${zweistellig(d.getMinutes())}`;
}

// Sicherung neben der Datei; bei Namensgleichheit innerhalb einer Minute mit Zaehler.
function sichere(datei) {
  const basis = `${datei}.bak-${zeitstempel()}`;
  let ziel = basis;
  for (let n = 2; fs.existsSync(ziel); n += 1) ziel = `${basis}-${n}`;
  fs.copyFileSync(datei, ziel);
  return path.basename(ziel);
}

function nodeOk() {
  const [haupt, neben] = process.versions.node.split('.').map(Number);
  return haupt > NODE_MINDEST[0] || (haupt === NODE_MINDEST[0] && neben >= NODE_MINDEST[1]);
}

// Fester Befehlsstring ohne Nutzereingaben: unter Windows ist npm eine .cmd-Datei und braucht
// die Shell; ein Argument-Array mit shell:true ist veraltet (DEP0190).
const NPM_KIMI = 'npm ls -g @moonshot-ai/kimi-code --depth=0 --json';

function kimiVersion() {
  const erg = spawnSync(NPM_KIMI, {
    encoding: 'utf8', shell: true, timeout: 30000, windowsHide: true,
  });
  try {
    return JSON.parse(erg.stdout)?.dependencies?.['@moonshot-ai/kimi-code']?.version ?? null;
  } catch {
    return null;
  }
}

function hooksFuerDiesenKlon() {
  return unsereHooks(process.execPath, WURZEL);
}

function vorhanden(ok, extra = '') {
  return `${ok ? 'vorhanden' : 'fehlt'}${extra}`;
}

function vermittler(befehl, konfigPfad) {
  return spawnSync(process.execPath, [path.join(WURZEL, 'vermittler.mjs'), befehl, '--konfig', konfigPfad], {
    stdio: 'inherit', windowsHide: true,
  }).status;
}

// ---------- pruefen ----------

async function pruefen(o) {
  const konfig = ladeKonfig(o.konfigPfad);
  const modelle = fs.readFileSync(MODELLE_PFAD, 'utf8');
  const anzahlModelle = modellAliase(modelle).length;
  const kimi = kimiVersion();
  ausgabe('Umgebung');
  zeile('Node', `${process.versions.node} ${nodeOk() ? '(ok, mindestens 20.11)' : '(zu alt, mindestens 20.11)'}`);
  zeile('Node-Pfad', process.execPath);
  zeile('Kimi Code CLI', kimi ? `${kimi} (npm global)` : 'fehlt (npm install -g @moonshot-ai/kimi-code)');
  zeile('Klon', WURZEL);
  zeile('config.toml', fs.existsSync(o.toml) ? `vorhanden (${o.toml})` : `fehlt (${o.toml}; Kimi einmal starten)`);
  ausgabe();
  ausgabe('Einrichtungsschritte');
  if (fs.existsSync(o.toml)) {
    const text = fs.readFileSync(o.toml, 'utf8');
    const url = leseBaseUrl(text);
    const soll = `http://127.0.0.1:${konfig.port}`;
    const hatProvider = setzeProvider(text) === text;
    zeile('Provider', vorhanden(hatProvider, hatProvider ? schluesselQuelle(text) : ''));
    const fremdeUrl = url !== null && !istLoopbackUrl(url);
    zeile('base_url', url === soll ? `vorhanden (${soll})` : fremdeUrl
      ? `fremd (${url}); einrichten bricht ohne --base-url-ersetzen ab`
      : `fehlt${url ? ` (steht auf ${url})` : ''}`);
    const nModelle = zaehleModelle(text, modelle);
    zeile('Modelle', vorhanden(nModelle === anzahlModelle, ` (${nModelle}/${anzahlModelle})`));
    const nHooks = zaehleHooks(text, hooksFuerDiesenKlon());
    zeile('Hooks', vorhanden(nHooks === 4, ` (${nHooks}/4)`));
    zeile('default_model', leseDefaultModel(text) ?? '(nicht gesetzt)');
  } else {
    zeile('Schritte', 'nicht pruefbar ohne config.toml');
  }
  zeile('kimi-cu-win', fs.existsSync(o.plugins) ? cuWinStatus(fs.readFileSync(o.plugins, 'utf8')) : 'fehlt (kein installed.json)');
  if (!o.ohneDienst) {
    const z = await pruefeDienst(konfig.port);
    zeile('Dienst', z.art === 'eigen' ? `laeuft (Version ${z.health.version}, Modus ${z.health.mode}, Port ${konfig.port})` : `${z.art} (Port ${konfig.port})`);
  }
  return 0;
}

// Nur Herkunft des Schluessels, nie sein Wert.
function schluesselQuelle(text) {
  if (hatKeyZeile(text)) return ', Key in config.toml eingetragen';
  const env = leseKeyEnv(text);
  if (env) return `, Key ueber Umgebungsvariable ${env} (${process.env[env] ? 'gesetzt' : 'NICHT gesetzt'})`;
  return ', kein Key konfiguriert';
}

// ---------- einrichten ----------

function patcheToml(o, konfig) {
  const alt = fs.readFileSync(o.toml, 'utf8');
  const modelle = fs.readFileSync(MODELLE_PFAD, 'utf8');
  const schritte = [
    ['Provider', (t) => setzeProvider(t)],
    ['base_url', (t) => setzeBaseUrl(t, konfig.port)],
    ['Modelle', (t) => ergaenzeModelle(t, modelle)],
    ['Hooks', (t) => ergaenzeHooks(t, hooksFuerDiesenKlon())],
  ];
  const { text: neu, berichte } = schritte.reduce(({ text, berichte: b }, [name, f]) => {
    const danach = f(text);
    return { text: danach, berichte: [...b, [name, danach === text ? 'unveraendert' : 'geaendert']] };
  }, { text: alt, berichte: [] });
  if (neu !== alt) {
    const sicherung = sichere(o.toml);
    schreibeAtomar(o.toml, neu);
    return { neu, berichte, sicherung };
  }
  return { neu, berichte, sicherung: null };
}

function patcheCuWin(o) {
  if (!fs.existsSync(o.plugins)) return 'fehlt (kein installed.json)';
  const roh = fs.readFileSync(o.plugins, 'utf8');
  const status = cuWinStatus(roh);
  if (status !== 'aus') return status === 'an' ? 'unveraendert (schon an)' : 'fehlt (Plugin nicht installiert)';
  const sicherung = sichere(o.plugins);
  schreibeAtomar(o.plugins, setzeCuWin(roh));
  return `geaendert (an), Sicherung ${sicherung}`;
}

async function einrichten(o) {
  if (!fs.existsSync(o.toml)) {
    process.stderr.write(`config.toml fehlt (${o.toml}). Kimi einmal starten und beenden, dann erneut.\n`);
    return 1;
  }
  const konfig = ladeKonfig(o.konfigPfad);
  // Eine fremde base_url (Proxy des Menschen) wird nie stillschweigend ueberschrieben.
  const alteUrl = leseBaseUrl(fs.readFileSync(o.toml, 'utf8'));
  const fremdeUrl = alteUrl !== null && !istLoopbackUrl(alteUrl);
  if (fremdeUrl && !o.baseUrlErsetzen) {
    process.stderr.write(`In config.toml steht eine fremde base_url (${alteUrl}). Nichts geaendert; ersetzen nur mit --base-url-ersetzen.\n`);
    return 1;
  }
  // Erst den Dienst starten und bestaetigen, dann die Konfiguration schreiben: Scheitert der
  // Start, zeigt Kimi nicht auf einen Port, an dem niemand lauscht.
  if (!o.ohneDienst) {
    if (vermittler('start', o.konfigPfad) !== 0 || vermittler('status', o.konfigPfad) !== 0) {
      process.stderr.write('Vermittler liess sich nicht starten; config.toml bleibt unveraendert.\n');
      return 1;
    }
    ausgabe();
  }
  const { neu, berichte, sicherung } = patcheToml(o, konfig);
  ausgabe('Einrichtung config.toml');
  berichte.forEach(([name, zustand]) => zeile(name, zustand));
  if (fremdeUrl) zeile('base_url alt', `${alteUrl} (ersetzt)`);
  zeile('Sicherung', sicherung ?? 'keine (nichts geaendert)');
  if (sicherung && hatKeyZeile(neu)) {
    ausgabe('  Hinweis: Die Sicherung enthaelt eine Kopie der Konfig samt eventuellem Key; nicht weitergeben oder einchecken.');
  }
  zeile('Schluessel', schluesselQuelle(neu).replace(/^, /, ''));
  if (o.cuWin) zeile('kimi-cu-win', patcheCuWin(o));
  ausgabe(`default_model: ${leseDefaultModel(neu) ?? '(nicht gesetzt)'} (nicht veraendert)`);
  return 0;
}

// ---------- rueckweg ----------

async function rueckweg(o) {
  if (fs.existsSync(o.toml)) {
    const alt = fs.readFileSync(o.toml, 'utf8');
    const neu = entferneHooks(entferneBaseUrl(alt), WURZEL);
    ausgabe('Rueckweg config.toml');
    if (neu !== alt) {
      zeile('Sicherung', sichere(o.toml));
      schreibeAtomar(o.toml, neu);
    }
    zeile('base_url', leseBaseUrl(neu) === null ? 'entfernt' : `bleibt (${leseBaseUrl(neu)}, nicht Loopback)`);
    zeile('Hooks', `entfernt, verbleibend eigene ${zaehleHooks(neu, hooksFuerDiesenKlon())}`);
    zeile('Modelle', 'bleiben (schaden nicht)');
  } else {
    ausgabe('config.toml fehlt, nichts zurueckzunehmen.');
  }
  if (o.ohneDienst) return 0;
  return vermittler('stop', o.konfigPfad) === 0 ? 0 : 1;
}

// ---------- Einstieg ----------

async function main(args) {
  const o = optionen(args);
  if (!BEFEHLE.includes(o.befehl)) {
    process.stderr.write('Aufruf: node setup/setup.mjs [pruefen|einrichten|rueckweg] [--cu-win] [--base-url-ersetzen] [--kimi-home pfad] [--konfig pfad] [--ohne-dienst]\n');
    return 2;
  }
  if (o.befehl === 'einrichten') return einrichten(o);
  if (o.befehl === 'rueckweg') return rueckweg(o);
  return pruefen(o);
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((fehler) => {
    process.stderr.write(`Abbruch: ${fehler?.message ?? 'unbekannter Fehler'}\n`);
    process.exitCode = 1;
  });
