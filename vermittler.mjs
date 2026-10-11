#!/usr/bin/env node
// Anthropic-Vermittler fuer Kimi Code CLI: Konfiguration, Server und CLI.
// Unterbefehle: start | stop | restart | status | bericht [--tage N] | serve (intern)
// Optional: --konfig <pfad> (Standard: vermittler.json neben dieser Datei)
// Die Dienststeuerung (Start, Stopp, PID- und Logdatei) liegt in lib/dienst.mjs.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODI, modusFuer, transformiere } from './lib/transform.mjs';
import { leiteWeiter, sendeFehler, fehlerKoerper, anfrageKopfzeilen, istSichererPfad } from './lib/weiterleitung.mjs';
import { erzeugePingPlaner } from './lib/ping.mjs';
import { erzeugeProtokoll, kennungen, sha12, leseProtokoll, werteAus, formatiereBericht } from './lib/protokoll.mjs';
import { erzeugeSitzungen } from './lib/sitzungen.mjs';
import { VERSION, DIENST } from './lib/kennung.mjs';
import {
  pruefeDienst, stelleSicher, stoppeDienst, stoppeHaengenden, schreibePidDatei, entfernePidDatei,
} from './lib/dienst.mjs';

export { VERSION, DIENST } from './lib/kennung.mjs';
export {
  pruefeDienst, stelleSicher, stoppeDienst, stoppeHaengenden, starteLosgeloest, istGueltigePid, pidDateiFuer,
} from './lib/dienst.mjs';

const MAX_BODY = 32 * 1024 * 1024;
const MAX_HOOK_BODY = 64 * 1024;
const MAX_VERBINDUNGEN = 256;
const PREISFELDER = Object.freeze(['input', 'w5m', 'w1h', 'read', 'output']);
const LOOPBACK = Object.freeze(new Set(['127.0.0.1', 'localhost', '[::1]']));
const STOPP_GNADE_MS = 5000;
const ZU_GROSS_NACHLAUF_MS = 2000;
const BEKANNTE_SCHLUESSEL = Object.freeze(['port', 'upstream', 'mode', 'modeByModel', 'ping', 'logPath', 'preise']);
const PING_GRENZEN = Object.freeze({ intervalSec: [30, 285], maxIdleMin: [1, 1440], heartbeatGraceSec: [30, 3600] });

const STANDARD = Object.freeze({
  port: 37790,
  upstream: 'https://api.anthropic.com',
  mode: 'ttl1h',
  modeByModel: {},
  ping: { intervalSec: 240, maxIdleMin: 60, heartbeatGraceSec: 180 },
  logPath: './protokoll.jsonl',
  preise: {},
});

// ---------- Konfiguration ----------

function tiefFrieren(wert) {
  if (wert && typeof wert === 'object') {
    Object.values(wert).forEach(tiefFrieren);
    Object.freeze(wert);
  }
  return wert;
}

function istObjekt(wert) {
  return Boolean(wert) && typeof wert === 'object' && !Array.isArray(wert);
}

function istGanzzahlIn(wert, min, max) {
  return typeof wert === 'number' && Number.isInteger(wert) && wert >= min && wert <= max;
}

// JSON mit sortierten Schluesseln: Fingerabdruck unabhaengig von der Reihenfolge in der Datei.
function stabil(wert) {
  if (Array.isArray(wert)) return `[${wert.map(stabil).join(',')}]`;
  if (istObjekt(wert)) return `{${Object.keys(wert).sort().map((k) => `${JSON.stringify(k)}:${stabil(wert[k])}`).join(',')}}`;
  return JSON.stringify(wert);
}

function loesePfad(pfad, basisOrdner) {
  if (pfad === '~' || pfad.startsWith('~/') || pfad.startsWith('~\\')) return path.join(os.homedir(), pfad.slice(1));
  return path.resolve(basisOrdner, pfad);
}

function pruefeUpstream(text) {
  if (typeof text !== 'string') throw new Error('Konfig: upstream muss ein Text sein');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('Konfig: upstream ist keine gueltige URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Konfig: upstream muss http(s) sein');
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) throw new Error('Konfig: upstream braucht https (http nur fuer Loopback)');
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new Error('Konfig: upstream darf nur Schema, Host und Port enthalten');
  }
}

function pruefeKonfig(k) {
  if (!istGanzzahlIn(k.port, 1, 65535)) throw new Error('Konfig: port muss eine ganze Zahl von 1 bis 65535 sein');
  pruefeUpstream(k.upstream);
  if (!MODI.includes(k.mode)) throw new Error(`Konfig: mode muss einer von ${MODI.join(', ')} sein`);
  for (const [modell, modus] of Object.entries(k.modeByModel)) {
    if (!MODI.includes(modus)) throw new Error(`Konfig: modeByModel.${modell} ungueltig`);
  }
  for (const [modell, preis] of Object.entries(k.preise)) {
    const ok = istObjekt(preis) && PREISFELDER.every((f) => typeof preis[f] === 'number' && Number.isFinite(preis[f]) && preis[f] >= 0);
    if (!ok) throw new Error(`Konfig: preise.${modell} braucht ${PREISFELDER.join(', ')} als Zahlen ab 0`);
  }
  for (const [name, [min, max]] of Object.entries(PING_GRENZEN)) {
    if (!istGanzzahlIn(k.ping[name], min, max)) throw new Error(`Konfig: ping.${name} muss eine ganze Zahl von ${min} bis ${max} sein`);
  }
  if (typeof k.logPath !== 'string' || k.logPath.length === 0) throw new Error('Konfig: logPath muss ein Text sein');
}

function standardWarnung(text) {
  process.stderr.write(`${text}\n`);
}

function warneUnbekannte(roh, warne) {
  const unbekannt = (objekt, erlaubt, praefix) => Object.keys(objekt)
    .filter((n) => !erlaubt.includes(n))
    .forEach((n) => warne(`Konfig: unbekannter Schluessel "${praefix}${n}"`));
  unbekannt(roh, BEKANNTE_SCHLUESSEL, '');
  if (istObjekt(roh.ping)) unbekannt(roh.ping, Object.keys(STANDARD.ping), 'ping.');
  if (istObjekt(roh.preise)) {
    Object.entries(roh.preise).forEach(([modell, preis]) => {
      if (istObjekt(preis)) unbekannt(preis, PREISFELDER, `preise.${modell}.`);
    });
  }
}

// konfigHash: Fingerabdruck der normalisierten Konfiguration mit unaufgeloestem logPath.
// Die Eingabe wird tief kopiert und weder veraendert noch eingefroren.
export function normalisiereKonfig(eingabe, basisOrdner, { warne = standardWarnung } = {}) {
  if (!istObjekt(eingabe)) throw new Error('Konfig: Wurzel muss ein Objekt sein');
  const roh = structuredClone(eingabe);
  warneUnbekannte(roh, warne);
  for (const name of ['modeByModel', 'ping', 'preise']) {
    if (roh[name] !== undefined && !istObjekt(roh[name])) throw new Error(`Konfig: ${name} muss ein Objekt sein`);
  }
  const k = {
    ...STANDARD,
    ...roh,
    modeByModel: { ...(roh.modeByModel ?? {}) },
    ping: { ...STANDARD.ping, ...(roh.ping ?? {}) },
    preise: { ...(roh.preise ?? {}) },
  };
  pruefeKonfig(k);
  return tiefFrieren({ ...k, logPath: loesePfad(k.logPath, basisOrdner), konfigHash: sha12(stabil(k)) });
}

export function standardKonfigPfad() {
  return path.join(import.meta.dirname, 'vermittler.json');
}

// Meldet bei kaputtem JSON nur die Position; V8 zitiert sonst Teile des Quelltexts.
function parseKonfigJson(text, name) {
  try {
    return JSON.parse(text);
  } catch (fehler) {
    const position = /position (\d+)/.exec(String(fehler?.message))?.[1];
    throw new Error(`Konfig ${name} ist kein gueltiges JSON${position ? ` (Position ${position})` : ''}`);
  }
}

export function ladeKonfig(pfad = standardKonfigPfad(), optionen = {}) {
  const text = fs.readFileSync(pfad, 'utf8').replace(/^﻿/, '');
  return normalisiereKonfig(parseKonfigJson(text, path.basename(pfad)), path.dirname(path.resolve(pfad)), optionen);
}

// ---------- Server ----------

function stderrLog(text) {
  process.stderr.write(`[vermittler] ${text}\n`);
}

function zuGrossFehler() {
  return Object.assign(new Error('zu gross'), { code: 'ZU_GROSS' });
}

// Liest den Body bis zur Grenze. Danach wird nichts mehr gesammelt; die Verbindung schliesst
// erst, nachdem die 413-Antwort gesendet ist.
function leseBody(req, grenze) {
  return new Promise((resolve, reject) => {
    const teile = [];
    let groesse = 0;
    let zuGross = false;
    req.on('data', (teil) => {
      if (zuGross) return;
      groesse += teil.length;
      if (groesse > grenze) {
        zuGross = true;
        teile.length = 0;
        reject(zuGrossFehler());
        return;
      }
      teile.push(teil);
    });
    req.on('end', () => {
      if (!zuGross) resolve(Buffer.concat(teile));
    });
    req.on('error', reject);
  });
}

function sendeMitSchliessen(res, status, koerper) {
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(koerper), connection: 'close' });
}

// Antwort zuerst (connection: close), dann schliessen. Der Rest des Bodys wird bis zum Ende
// der Anfrage verworfen weitergelesen, hoechstens ZU_GROSS_NACHLAUF_MS lang: sonst setzt ein
// sofortiges Schliessen bei noch sendendem Client die Verbindung zurueck, und unter Windows
// geht die 413-Antwort dabei verloren.
function sendeZuGross(req, res, koerper) {
  sendeMitSchliessen(res, 413, koerper);
  res.end(koerper, () => {
    if (req.complete) {
      req.destroy();
      return;
    }
    const frist = setTimeout(() => req.destroy(), ZU_GROSS_NACHLAUF_MS);
    frist.unref?.();
    req.once('end', () => {
      clearTimeout(frist);
      req.destroy();
    });
    req.resume();
  });
}

function parseObjekt(puffer) {
  try {
    const wert = JSON.parse(puffer.toString('utf8'));
    return istObjekt(wert) ? wert : null;
  } catch {
    return null;
  }
}

function sendeJson(res, status, objekt) {
  const text = JSON.stringify(objekt);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const HOOK_ROUTEN = Object.freeze({
  health: 'GET',
  'session-ende': 'POST',
  heartbeat: 'POST',
  'subagent-ende': 'POST',
  stop: 'POST',
});

// Host-Kopfzeile muss Loopback mit dem tatsaechlich lauschenden Port sein (DNS-Rebinding).
function istLoopbackHost(host, port) {
  if (typeof host !== 'string') return false;
  return [...LOOPBACK].some((name) => host.toLowerCase() === `${name}:${port}`);
}

function fehlercodeVon(fehler) {
  return fehler?.code ?? fehler?.name ?? 'unbekannt';
}

// Optionen: log, jetzt, pingTimer, sende (Ping-Sendeweg), beende (nach dem Stopp; cliServe:
// process.exit), maxBody, weiterleiten und protokoll (Tests).
// Liefert { server, sitzungen, protokoll, planer, stoppeSauber }.
export function erzeugeServer(konfig, {
  log = stderrLog, jetzt = Date.now, pingTimer = true, sende, beende = () => {}, maxBody = MAX_BODY,
  weiterleiten = leiteWeiter, protokoll: protokollVorgabe,
} = {}) {
  const startMs = jetzt();
  const sitzungen = erzeugeSitzungen({ jetzt });
  const protokoll = protokollVorgabe ?? erzeugeProtokoll({
    logPfad: konfig.logPath, konfig, jetzt, meldeFehler: (f) => log(`Protokoll nicht schreibbar (${f?.code ?? 'unbekannt'})`),
  });
  const planer = erzeugePingPlaner({
    konfig, sitzungen, protokoll, jetzt, log, ...(sende ? { sende } : {}), ...(pingTimer ? {} : { timer: null }),
  });
  let server;
  let stoppt = false;

  function health() {
    return {
      ok: true, dienst: DIENST, version: VERSION, konfigHash: konfig.konfigHash, pid: process.pid, mode: konfig.mode,
      uptimeSec: Math.round((jetzt() - startMs) / 1000), pingSchluessel: planer.anzahl(),
    };
  }

  async function bearbeiteHook(req, res, name) {
    const methode = Object.hasOwn(HOOK_ROUTEN, name) ? HOOK_ROUTEN[name] : undefined;
    if (!methode) return sendeJson(res, 404, { ok: false, fehler: 'unbekannter Endpunkt' });
    if (req.method !== methode) return sendeJson(res, 405, { ok: false, fehler: 'Methode nicht erlaubt' });
    if (name === 'health') return sendeJson(res, 200, health());
    let daten;
    try {
      daten = parseObjekt(await leseBody(req, MAX_HOOK_BODY));
    } catch (fehler) {
      if (fehler?.code === 'ZU_GROSS') return sendeZuGross(req, res, JSON.stringify({ ok: false, fehler: 'zu gross' }));
      return res.destroy();
    }
    if (name === 'stop') {
      if (daten?.pid !== process.pid) return sendeJson(res, 409, { ok: false, fehler: 'pid passt nicht' });
      sendeJson(res, 200, { ok: true, pid: process.pid });
      stoppeSauber();
      return undefined;
    }
    const sessionId = daten?.session_id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return sendeJson(res, 400, { ok: false, fehler: 'session_id fehlt' });
    const session = sha12(sessionId);
    if (name === 'heartbeat') return sendeJson(res, 200, { ok: true, bekannt: sitzungen.heartbeat(session) });
    if (name === 'subagent-ende') {
      const haupt = sitzungen.zustand(session)?.hauptSchluessel ?? null;
      const verworfen = sitzungen.subagentEnde(session);
      return sendeJson(res, 200, { ok: true, verworfen, pings: planer.subagentEnde(session, haupt) });
    }
    const pings = planer.sessionEnde(session);
    return sendeJson(res, 200, { ok: true, verworfen: sitzungen.sessionEnde(session), pings });
  }

  async function bearbeiteMessages(req, res, body, pfad) {
    const json = parseObjekt(body);
    if (!json) {
      const erg = await weiterleiten({ req, res, upstream: konfig.upstream, body, log });
      protokoll.durchgang({ pfad, status: erg.status });
      return;
    }
    const modus = modusFuer(konfig, json.model);
    const t = transformiere(json, modus);
    const k = kennungen(t.body);
    sitzungen.anfrage(k.session, k.schluessel, k.sockelLaenge);
    const h = protokoll.beginn({ ...k, modell: json.model, modus, marken: t.marken });
    const ausgehend = t.geaendert ? Buffer.from(JSON.stringify(t.body), 'utf8') : body;
    let erg = null;
    try {
      erg = await weiterleiten({
        req, res, upstream: konfig.upstream, body: ausgehend, liestUsage: true, log,
        beobachter: {
          // Ping-Planer erst nach erfolgreichem Antwortbeginn; die Uhr laeuft ab Start der Anfrage.
          kopf: (status) => {
            if (status < 200 || status >= 300) return;
            planer.anfrage({
              session: k.session, schluessel: k.schluessel, modell: json.model, modus, pfad: req.url,
              body: ausgehend, kopfzeilen: anfrageKopfzeilen(req.headers), startMs: h.startMs,
            });
          },
          ersteByte: () => {
            sitzungen.ersteByte(k.session, k.schluessel);
            planer.ersteByte(k.schluessel, h.startMs);
          },
        },
      });
    } finally {
      // Ein Fehler beim Protokollieren darf den Ursprungsfehler nicht verdecken.
      try {
        protokoll.ende(h, erg
          ? { status: erg.status, usage: erg.usage, abbruch: erg.abbruch }
          : { status: 0, usage: null, abbruch: true });
      } catch (fehler) {
        log(`Protokoll-Abschluss fehlgeschlagen (${fehlercodeVon(fehler)})`);
      }
    }
  }

  async function bearbeite(req, res) {
    if (stoppt) {
      const koerper = fehlerKoerper('Vermittler: wird gerade beendet', 'overloaded_error');
      sendeMitSchliessen(res, 503, koerper);
      res.end(koerper);
      return undefined;
    }
    if (req.headers.origin !== undefined) {
      return sendeFehler(res, 403, 'Vermittler: Anfragen mit Origin-Kopfzeile werden abgewiesen', 'permission_error');
    }
    if (!istLoopbackHost(req.headers.host, req.socket.localPort)) {
      return sendeFehler(res, 403, 'Vermittler: Host-Kopfzeile ist kein Loopback dieses Dienstes', 'permission_error');
    }
    if (!istSichererPfad(req.url)) {
      return sendeFehler(res, 400, 'Vermittler: ungueltiges Request-Target', 'invalid_request_error');
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/_vermittler/')) return bearbeiteHook(req, res, url.pathname.slice('/_vermittler/'.length));
    let body;
    try {
      body = await leseBody(req, maxBody);
    } catch (fehler) {
      if (fehler?.code === 'ZU_GROSS') return sendeZuGross(req, res, fehlerKoerper('Vermittler: Anfrage zu gross', 'request_too_large'));
      return res.destroy();
    }
    if (req.method === 'POST' && url.pathname === '/v1/messages') return bearbeiteMessages(req, res, body, url.pathname);
    const erg = await weiterleiten({ req, res, upstream: konfig.upstream, body, log });
    protokoll.durchgang({ pfad: url.pathname, status: erg.status });
    return undefined;
  }

  server = http.createServer((req, res) => {
    bearbeite(req, res).catch((fehler) => {
      log(`Interner Fehler (${fehlercodeVon(fehler)})`);
      sendeFehler(res, 500, 'Vermittler: interner Fehler');
    });
  });
  server.maxConnections = MAX_VERBINDUNGEN;

  // Sauberer Stopp (Windows kennt kein SIGTERM): Planer anhalten, neue Anfragen mit 503
  // abweisen, laufende Stroeme bekommen eine Gnadenfrist, dann beenden.
  function stoppeSauber() {
    if (stoppt) return;
    stoppt = true;
    log('Stopp angefordert');
    planer.stoppe();
    let beendet = false;
    const einmal = () => {
      if (beendet) return;
      beendet = true;
      beende();
    };
    const frist = setTimeout(() => {
      server.closeAllConnections();
      einmal();
    }, STOPP_GNADE_MS);
    frist.unref?.();
    server.close(() => {
      clearTimeout(frist);
      einmal();
    });
  }

  server.on('close', () => planer.stoppe());
  planer.starte();
  return { server, sitzungen, protokoll, planer, stoppeSauber };
}

// Erstes Signal: sauber stoppen (gleiche Gnadenfrist wie /_vermittler/stop); zweites: sofort.
export function bindeSignale(prozess, { stoppeSauber, sofort }) {
  let gesehen = false;
  const handler = () => {
    if (gesehen) {
      sofort();
      return;
    }
    gesehen = true;
    stoppeSauber();
  };
  prozess.on('SIGINT', handler);
  prozess.on('SIGTERM', handler);
}

// ---------- CLI ----------

const BEFEHLE = Object.freeze(['start', 'stop', 'restart', 'status', 'bericht', 'serve']);
const FLAGS_MIT_WERT = Object.freeze(['--konfig', '--tage']);
const HILFE = 'Aufruf: node vermittler.mjs start|stop|restart|status|bericht [--tage N] [--konfig pfad]';

function ausgabe(text) {
  process.stdout.write(`${text}\n`);
}

function fehlerAus(text) {
  process.stderr.write(`${text}\n`);
}

// Prueft Befehl und Flags, bevor die Konfiguration geladen wird.
export function leseArgumente(args) {
  const [befehl, ...rest] = args;
  if (!BEFEHLE.includes(befehl)) return { fehler: HILFE };
  const werte = {};
  for (let i = 0; i < rest.length; i += 1) {
    const name = rest[i];
    if (!FLAGS_MIT_WERT.includes(name)) return { fehler: `Unbekanntes Argument "${name}".\n${HILFE}` };
    const wert = rest[i + 1];
    if (wert === undefined || wert.startsWith('--')) return { fehler: `${name} braucht einen Wert.` };
    werte[name] = wert;
    i += 1;
  }
  const tage = werte['--tage'] === undefined ? 7 : Number(werte['--tage']);
  if (!Number.isFinite(tage) || tage <= 0) return { fehler: '--tage braucht eine endliche Zahl groesser 0.' };
  return { befehl, konfigPfad: path.resolve(werte['--konfig'] ?? standardKonfigPfad()), tage };
}

function fremdMeldung(port) {
  return `Port ${port} ist von einem fremden Dienst belegt (kein ${DIENST}).`;
}

function besetztMeldung(port) {
  return `Dienst auf Port ${port} antwortet nicht (Verbindung angenommen, keine Antwort).`;
}

const START_MELDUNG = Object.freeze({
  fremd: (k) => fremdMeldung(k.port),
  besetzt: (k) => besetztMeldung(k.port),
  'spawn-fehler': () => 'Start nicht moeglich: Prozess liess sich nicht starten.',
  'stopp-fehler': () => 'Alte Version liess sich nicht beenden.',
  zeitueberschreitung: () => 'Start nicht bestaetigt: Dienst antwortet nicht binnen 5 s (siehe vermittler.log).',
  'konfig-fehlt': () => 'Start nicht moeglich: kein Konfigurationspfad.',
});

const START_WORT = Object.freeze({ laeuft: 'laeuft bereits', gestartet: 'gestartet', erneuert: 'erneuert (neue Version oder Konfiguration)' });

async function cliStart(konfig, konfigPfad) {
  const { ergebnis, health } = await stelleSicher(konfig, { konfigPfad, wartenMs: 5000, melde: fehlerAus });
  if (Object.hasOwn(START_MELDUNG, ergebnis)) {
    fehlerAus(START_MELDUNG[ergebnis](konfig));
    return 1;
  }
  ausgabe(`${START_WORT[ergebnis]}: 127.0.0.1:${konfig.port}, pid ${health.pid}, Version ${health.version}, Modus ${health.mode}`);
  return 0;
}

const STOPP_MELDUNG = Object.freeze({
  'pid-ungueltig': 'Dienst reagiert nicht auf den Stopp-Endpunkt und meldet eine ungueltige pid; nichts beendet.',
  'pid-unbelegt': 'Dienst reagiert nicht auf den Stopp-Endpunkt; ohne passende vermittler.pid wird nichts getoetet (pid-unbelegt).',
  'pid-fremd': 'PID-Datei veraltet, nichts beendet (pid gehoert keinem Node-Prozess oder diesem Aufruf; Datei entfernt).',
});

async function cliStop(konfig, konfigPfad) {
  const z = await pruefeDienst(konfig.port);
  if (z.art === 'keiner') {
    ausgabe('laeuft nicht');
    return 0;
  }
  if (z.art === 'besetzt') {
    const erg = await stoppeHaengenden(konfig.port, konfigPfad, { melde: fehlerAus });
    if (erg === 'besetzt-getoetet') {
      ausgabe(`besetzt-getoetet: haengende Instanz auf Port ${konfig.port} beendet`);
      return 0;
    }
    if (erg === 'gestoppt' || erg === 'getoetet') {
      ausgabe(`${erg}: Dienst auf Port ${konfig.port} antwortete wieder und ist beendet`);
      return 0;
    }
    if (Object.hasOwn(STOPP_MELDUNG, erg)) {
      fehlerAus(STOPP_MELDUNG[erg]);
      return 1;
    }
    fehlerAus(`${besetztMeldung(konfig.port)} Ohne passende vermittler.pid wird nichts beendet (${erg}).`);
    return 1;
  }
  if (z.art !== 'eigen') {
    fehlerAus(`${fremdMeldung(konfig.port)} Nichts beendet.`);
    return 1;
  }
  const erg = await stoppeDienst(konfig.port, z.health, { konfigPfad, melde: fehlerAus });
  if (erg === 'gestoppt' || erg === 'getoetet') {
    ausgabe(`${erg}: pid ${z.health.pid}`);
    return 0;
  }
  fehlerAus(Object.hasOwn(STOPP_MELDUNG, erg) ? STOPP_MELDUNG[erg] : `Beenden fehlgeschlagen (${erg}).`);
  return 1;
}

async function cliStatus(konfig) {
  const z = await pruefeDienst(konfig.port);
  if (z.art === 'eigen') {
    ausgabe(JSON.stringify({ ...z.health, port: konfig.port, upstream: konfig.upstream, logPath: konfig.logPath }, null, 2));
    return 0;
  }
  if (z.art === 'besetzt') {
    fehlerAus(besetztMeldung(konfig.port));
    return 1;
  }
  if (z.art === 'fremd' || z.art === 'unbekannt') {
    fehlerAus(fremdMeldung(konfig.port));
    return 1;
  }
  ausgabe(`laeuft nicht (Port ${konfig.port})`);
  return 1;
}

function cliBericht(konfig, tage) {
  const auswertung = werteAus(leseProtokoll(konfig.logPath), { seitMs: Date.now() - tage * 86400000 });
  ausgabe(formatiereBericht(auswertung));
  return 0;
}

// PID-Datei wird nach dem Lauschen atomar geschrieben und auf jedem Ausgang entfernt.
function cliServe(konfig, konfigPfad) {
  const raeumePidAuf = () => entfernePidDatei(konfigPfad, process.pid);
  process.on('exit', raeumePidAuf);
  const sofort = () => process.exit(0);
  const { server, stoppeSauber } = erzeugeServer(konfig, { beende: sofort });
  server.on('error', (fehler) => {
    if (fehler?.code === 'EADDRINUSE') {
      stderrLog(`Port ${konfig.port} belegt, kein zweiter Start.`);
      process.exit(0);
    }
    stderrLog(`Serverfehler (${fehler?.code ?? 'unbekannt'})`);
    process.exit(1);
  });
  server.listen(konfig.port, '127.0.0.1', () => {
    try {
      schreibePidDatei(konfigPfad, konfig.port);
    } catch (fehler) {
      stderrLog(`PID-Datei nicht schreibbar (${fehler?.code ?? 'unbekannt'})`);
    }
    stderrLog(`lauscht auf 127.0.0.1:${server.address().port}, Modus ${konfig.mode}, Version ${VERSION}`);
  });
  bindeSignale(process, { stoppeSauber, sofort });
}

async function main(args) {
  const a = leseArgumente(args);
  if (a.fehler) {
    fehlerAus(a.fehler);
    return 2;
  }
  let konfig;
  try {
    konfig = ladeKonfig(a.konfigPfad);
  } catch (fehler) {
    fehlerAus(`Konfiguration nicht lesbar: ${fehler?.code === 'ENOENT' ? `Datei fehlt (${a.konfigPfad})` : fehler.message}`);
    return 2;
  }
  switch (a.befehl) {
    case 'start': return cliStart(konfig, a.konfigPfad);
    case 'stop': return cliStop(konfig, a.konfigPfad);
    case 'restart': {
      const code = await cliStop(konfig, a.konfigPfad);
      return code === 0 ? cliStart(konfig, a.konfigPfad) : code;
    }
    case 'status': return cliStatus(konfig);
    case 'bericht': return cliBericht(konfig, a.tage);
    default: cliServe(konfig, a.konfigPfad); return null;
  }
}

function istEinstieg() {
  if (!process.argv[1]) return false;
  const a = path.resolve(process.argv[1]);
  const b = import.meta.filename;
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (istEinstieg()) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== null) process.exitCode = code;
    })
    .catch((fehler) => {
      process.stderr.write(`Abbruch (${fehler?.code ?? fehler?.name ?? 'unbekannt'})\n`);
      process.exitCode = 1;
    });
}
