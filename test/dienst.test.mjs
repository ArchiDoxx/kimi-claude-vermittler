// Dienststeuerung (Iteration 3): sauberer Stopp, pid-Pruefung, Versionswechsel, besetzter Port,
// Spawn-Fehler. Alle Tests auf freien Zufallsports, nie auf 37790.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pruefeDienst, stelleSicher, ladeKonfig, VERSION, DIENST } from '../vermittler.mjs';
import { tempOrdner, schreibeKonfig, freierPort, fuehreAus, WURZEL } from './hilfen.mjs';

const CLI = path.join(WURZEL, 'vermittler.mjs');

async function konfigMitFreiemPort() {
  const ordner = tempOrdner();
  const port = await freierPort();
  const pfad = schreibeKonfig(ordner, { port, upstream: 'http://127.0.0.1:1', logPath: path.join(ordner, 'p.jsonl') });
  return { port, pfad, konfig: ladeKonfig(pfad) };
}

function attrappe(port, handler) {
  const server = http.createServer(handler);
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

async function schliesse(server) {
  server.closeAllConnections();
  await new Promise((r) => server.close(() => r()));
}

test('K5: CLI-stop beendet den Dienst ueber den Stopp-Endpunkt sauber (Exit-Code 0 des Dienstes)', { timeout: 20000 }, async () => {
  const { port, pfad } = await konfigMitFreiemPort();
  const kind = spawn(process.execPath, [CLI, 'serve', '--konfig', pfad], { windowsHide: true });
  const beendet = new Promise((r) => kind.on('close', (code, signal) => r({ code, signal })));
  const ende = Date.now() + 5000;
  while ((await pruefeDienst(port, 300)).art !== 'eigen') {
    assert.ok(Date.now() < ende, 'Dienst startet nicht');
    await new Promise((r) => setTimeout(r, 100));
  }
  const stop = await fuehreAus([CLI, 'stop', '--konfig', pfad]);
  assert.equal(stop.code, 0, stop.stderr);
  const { code, signal } = await beendet;
  assert.equal(code, 0, `Dienst endete mit code ${code}, signal ${signal}`);
});

test('K6: ungueltige pid aus health wird nie an process.kill gegeben', { timeout: 20000 }, async () => {
  const { port, pfad } = await konfigMitFreiemPort();
  const fremd = await attrappe(port, (req, res) => {
    if (req.url === '/_vermittler/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, dienst: DIENST, version: VERSION, pid: 'abc' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const stop = await fuehreAus([CLI, 'stop', '--konfig', pfad]);
    assert.equal(stop.code, 1);
    assert.match(stop.stderr, /ungueltige pid/i);
  } finally {
    await schliesse(fremd);
  }
});

test('K8: eigener Dienst mit anderer Version wird gestoppt und neu gestartet (erneuert)', { timeout: 20000 }, async () => {
  const { port, pfad, konfig } = await konfigMitFreiemPort();
  let alt;
  alt = await attrappe(port, (req, res) => {
    if (req.url === '/_vermittler/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, dienst: DIENST, version: '0.0.1', pid: 999999 }));
      return;
    }
    if (req.url === '/_vermittler/stop' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}', () => schliesse(alt));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const { ergebnis: erg } = await stelleSicher(konfig, { konfigPfad: pfad, wartenMs: 5000 });
    assert.equal(erg, 'erneuert');
    const z = await pruefeDienst(port);
    assert.equal(z.art, 'eigen');
    assert.equal(z.health.version, VERSION);
  } finally {
    const stop = await fuehreAus([CLI, 'stop', '--konfig', pfad]);
    assert.equal(stop.code, 0, stop.stderr);
  }
});

test('K9: Port nimmt an, antwortet aber nicht -> besetzt statt fremd; stelleSicher gibt nach einem zweiten Versuch auf', { timeout: 20000 }, async () => {
  const { port, pfad, konfig } = await konfigMitFreiemPort();
  const haenger = await attrappe(port, () => {});
  try {
    assert.equal((await pruefeDienst(port, 300)).art, 'besetzt');
    const start = Date.now();
    assert.equal((await stelleSicher(konfig, { konfigPfad: pfad, wartenMs: 1000 })).ergebnis, 'besetzt');
    assert.ok(Date.now() - start >= 500, 'kein zweiter Versuch nach 500 ms');
  } finally {
    await schliesse(haenger);
  }
});

test('K14: Spawn-Fehler wird als spawn-fehler gemeldet', { timeout: 20000 }, async () => {
  const { pfad, konfig } = await konfigMitFreiemPort();
  const { ergebnis: erg } = await stelleSicher(konfig, { konfigPfad: pfad, wartenMs: 1000, programm: path.join(tempOrdner(), 'gibt-es-nicht.exe') });
  assert.equal(erg, 'spawn-fehler');
});

// ---------- Iteration 5 ----------
import fs from 'node:fs';
import { bindeSignale } from '../vermittler.mjs';

// Eine pid, die unter Windows nie vergeben ist (Prozess-IDs sind dort Vielfache von 4).
const FREMDE_PID = 999999;

function eigeneAttrappe(port, { version = VERSION, konfigHash, stopp = 'ignorieren' } = {}) {
  let server;
  server = http.createServer((req, res) => {
    if (req.url === '/_vermittler/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, dienst: DIENST, version, pid: FREMDE_PID, ...(konfigHash ? { konfigHash } : {}) }));
      return;
    }
    if (req.url === '/_vermittler/stop' && stopp === 'schliessen') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}', () => { server.closeAllConnections(); server.close(); });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

test('K23: serve schreibt vermittler.pid neben der Konfig und loescht sie beim sauberen Ende', { timeout: 20000 }, async () => {
  const { port, pfad, konfig } = await konfigMitFreiemPort();
  const pidDatei = path.join(path.dirname(pfad), 'vermittler.pid');
  assert.equal((await stelleSicher(konfig, { konfigPfad: pfad, wartenMs: 5000 })).ergebnis, 'gestartet');
  const inhalt = JSON.parse(fs.readFileSync(pidDatei, 'utf8'));
  const z = await pruefeDienst(port);
  assert.equal(inhalt.pid, z.health.pid);
  assert.equal(inhalt.port, port);
  assert.equal(inhalt.version, VERSION);
  assert.match(inhalt.gestartet, /^\d{4}-\d{2}-\d{2}T/);
  const stop = await fuehreAus([CLI, 'stop', '--konfig', pfad]);
  assert.equal(stop.code, 0, stop.stderr);
  assert.equal(fs.existsSync(pidDatei), false, 'PID-Datei blieb liegen');
});

test('K23: ohne PID-Datei wird nie getoetet (pid-unbelegt)', { timeout: 20000 }, async () => {
  const { port, pfad } = await konfigMitFreiemPort();
  const attrappe = await eigeneAttrappe(port);
  try {
    const stop = await fuehreAus([CLI, 'stop', '--konfig', pfad]);
    assert.equal(stop.code, 1);
    assert.match(stop.stderr, /pid-unbelegt/);
  } finally {
    await schliesse(attrappe);
  }
});

test('K23: PID-Datei passt, Prozess existiert nicht (ESRCH) -> gilt als gestoppt', { timeout: 20000 }, async () => {
  const { port, pfad } = await konfigMitFreiemPort();
  fs.writeFileSync(path.join(path.dirname(pfad), 'vermittler.pid'), JSON.stringify({ pid: FREMDE_PID, port, version: VERSION, gestartet: new Date().toISOString() }));
  const attrappe = await eigeneAttrappe(port);
  try {
    const stop = await fuehreAus([CLI, 'stop', '--konfig', pfad]);
    assert.equal(stop.code, 0, stop.stderr);
    assert.match(stop.stdout, /gestoppt/);
  } finally {
    await schliesse(attrappe);
  }
});

test('K25: gleicher Stand, aber anderer konfigHash -> erneuert', { timeout: 20000 }, async () => {
  const { port, pfad, konfig } = await konfigMitFreiemPort();
  await eigeneAttrappe(port, { konfigHash: 'abcdefabcdef', stopp: 'schliessen' });
  try {
    assert.equal((await stelleSicher(konfig, { konfigPfad: pfad, wartenMs: 5000 })).ergebnis, 'erneuert');
    const z = await pruefeDienst(port);
    assert.equal(z.health.konfigHash, konfig.konfigHash);
  } finally {
    const stop = await fuehreAus([CLI, 'stop', '--konfig', pfad]);
    assert.equal(stop.code, 0, stop.stderr);
  }
});

test('K25: gleicher Stand und gleicher konfigHash -> laeuft', { timeout: 20000 }, async () => {
  const { port, pfad, konfig } = await konfigMitFreiemPort();
  const attrappe = await eigeneAttrappe(port, { konfigHash: konfig.konfigHash });
  try {
    assert.equal((await stelleSicher(konfig, { konfigPfad: pfad, wartenMs: 1000 })).ergebnis, 'laeuft');
  } finally {
    await schliesse(attrappe);
  }
});

test('K32: losgeloester Start schreibt stderr nach vermittler.log, vorher auf 1 MB gekuerzt', { timeout: 20000 }, async () => {
  const { pfad, konfig } = await konfigMitFreiemPort();
  const logDatei = path.join(path.dirname(pfad), 'vermittler.log');
  fs.writeFileSync(logDatei, `${'a'.repeat(2 * 1024 * 1024)}\nALTES-ENDE\n`);
  try {
    assert.equal((await stelleSicher(konfig, { konfigPfad: pfad, wartenMs: 5000 })).ergebnis, 'gestartet');
    const ende = Date.now() + 3000;
    let inhalt = '';
    while (!inhalt.includes('lauscht auf') && Date.now() < ende) {
      await new Promise((r) => setTimeout(r, 100));
      inhalt = fs.readFileSync(logDatei, 'utf8');
    }
    assert.match(inhalt, /lauscht auf 127\.0\.0\.1/);
    assert.ok(inhalt.includes('ALTES-ENDE'), 'das Ende der alten Datei bleibt');
    assert.ok(fs.statSync(logDatei).size <= 1024 * 1024 + 4096, `zu gross: ${fs.statSync(logDatei).size}`);
  } finally {
    const stop = await fuehreAus([CLI, 'stop', '--konfig', pfad]);
    assert.equal(stop.code, 0, stop.stderr);
  }
});

test('K24: erstes Signal stoppt sauber, zweites beendet sofort', () => {
  const handler = {};
  const prozess = { on: (sig, fn) => { handler[sig] = fn; } };
  const aufrufe = [];
  bindeSignale(prozess, { stoppeSauber: () => aufrufe.push('sauber'), sofort: () => aufrufe.push('sofort') });
  handler.SIGINT();
  assert.deepEqual(aufrufe, ['sauber']);
  handler.SIGTERM();
  assert.deepEqual(aufrufe, ['sauber', 'sofort']);
});

// ---------- Iteration 6 ----------

const ATTRAPPE = path.join(WURZEL, 'test', 'attrappe-prozess.mjs');

function starteAttrappe(port, verhalten, konfigHash = 'x') {
  const kind = spawn(process.execPath, [ATTRAPPE, String(port), verhalten, VERSION, konfigHash], { windowsHide: true });
  const beendet = new Promise((r) => kind.on('close', () => r()));
  const bereit = new Promise((r) => kind.stdout.once('data', () => r()));
  return { kind, beendet, bereit };
}

function lebt(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (fehler) {
    return fehler.code === 'EPERM';
  }
}

test('K50/K52: Port zu, Prozess lebt -> nach 8 s Kill-Rueckfall (getoetet), PID-Datei weg', { timeout: 40000 }, async () => {
  const { port, pfad } = await konfigMitFreiemPort();
  const a = starteAttrappe(port, 'port-zu-lebt');
  await a.bereit;
  const pidDatei = path.join(path.dirname(pfad), 'vermittler.pid');
  fs.writeFileSync(pidDatei, JSON.stringify({ pid: a.kind.pid, port, version: VERSION, gestartet: new Date().toISOString() }));
  try {
    const stop = await fuehreAus([CLI, 'stop', '--konfig', pfad], { timeoutMs: 30000 });
    assert.equal(stop.code, 0, stop.stderr);
    assert.match(stop.stdout, /getoetet/);
    await a.beendet;
    assert.equal(lebt(a.kind.pid), false);
    assert.equal(fs.existsSync(pidDatei), false, 'PID-Datei blieb liegen');
  } finally {
    if (lebt(a.kind.pid)) a.kind.kill();
  }
});

test('K51/K52: haengende eigene Instanz mit passender PID-Datei -> besetzt-getoetet', { timeout: 40000 }, async () => {
  const { port, pfad } = await konfigMitFreiemPort();
  const a = starteAttrappe(port, 'haengt');
  await a.bereit;
  const pidDatei = path.join(path.dirname(pfad), 'vermittler.pid');
  fs.writeFileSync(pidDatei, JSON.stringify({ pid: a.kind.pid, port, version: VERSION, gestartet: new Date().toISOString() }));
  try {
    const stop = await fuehreAus([CLI, 'stop', '--konfig', pfad], { timeoutMs: 30000 });
    assert.equal(stop.code, 0, stop.stderr);
    assert.match(stop.stdout, /besetzt-getoetet/);
    await a.beendet;
    assert.equal(fs.existsSync(pidDatei), false);
  } finally {
    if (lebt(a.kind.pid)) a.kind.kill();
  }
});

test('K51: haengende Instanz ohne PID-Datei -> eigene Meldung, nichts getoetet; status ebenso', { timeout: 40000 }, async () => {
  const { port, pfad } = await konfigMitFreiemPort();
  const a = starteAttrappe(port, 'haengt');
  await a.bereit;
  try {
    const stop = await fuehreAus([CLI, 'stop', '--konfig', pfad], { timeoutMs: 30000 });
    assert.equal(stop.code, 1);
    assert.match(stop.stderr, /antwortet nicht/);
    assert.equal(lebt(a.kind.pid), true);
    const status = await fuehreAus([CLI, 'status', '--konfig', pfad], { timeoutMs: 30000 });
    assert.equal(status.code, 1);
    assert.match(status.stderr, /antwortet nicht/);
  } finally {
    a.kind.kill();
    await a.beendet;
  }
});

test('K53: Transportfehler -> unbekannt; stelleSicher versucht es erneut und meldet dann fremd', { timeout: 20000 }, async () => {
  const { port, pfad, konfig } = await konfigMitFreiemPort();
  const kappt = await attrappe(port, (req) => req.socket.destroy());
  try {
    assert.equal((await pruefeDienst(port, 1000)).art, 'unbekannt');
    const start = Date.now();
    assert.equal((await stelleSicher(konfig, { konfigPfad: pfad, wartenMs: 1000 })).ergebnis, 'fremd');
    assert.ok(Date.now() - start >= 500, 'kein Wiederholungsversuch');
  } finally {
    await schliesse(kappt);
  }
});

test('K54: gekuerzte Logdatei beginnt an einer Zeilengrenze', { timeout: 20000 }, async () => {
  const { pfad, konfig } = await konfigMitFreiemPort();
  const logDatei = path.join(path.dirname(pfad), 'vermittler.log');
  fs.writeFileSync(logDatei, `${'x'.repeat(2 * 1024 * 1024)}\nERSTE-GANZE-ZEILE\n`);
  try {
    assert.equal((await stelleSicher(konfig, { konfigPfad: pfad, wartenMs: 5000 })).ergebnis, 'gestartet');
    assert.ok(fs.readFileSync(logDatei, 'utf8').startsWith('ERSTE-GANZE-ZEILE\n'));
    assert.equal(fs.readdirSync(path.dirname(pfad)).some((n) => n.includes('.tmp')), false, 'Tempdatei liegt noch');
  } finally {
    const stop = await fuehreAus([CLI, 'stop', '--konfig', pfad]);
    assert.equal(stop.code, 0, stop.stderr);
  }
});

test('K54: nicht beschreibbare Logdatei -> Meldung auf stderr, Start trotzdem', { timeout: 20000 }, async () => {
  const { pfad } = await konfigMitFreiemPort();
  fs.mkdirSync(path.join(path.dirname(pfad), 'vermittler.log'));
  try {
    const start = await fuehreAus([CLI, 'start', '--konfig', pfad]);
    assert.equal(start.code, 0, start.stderr);
    assert.match(start.stderr, /Logdatei nicht beschreibbar \(E[A-Z]+\)/);
    assert.match(start.stdout, /gestartet: .*pid \d+/);
  } finally {
    const stop = await fuehreAus([CLI, 'stop', '--konfig', pfad]);
    assert.equal(stop.code, 0, stop.stderr);
  }
});

test('K55: alter Dienst ohne Stopp-Endpunkt (404) -> Hinweis auf Handarbeit', { timeout: 20000 }, async () => {
  const { port, pfad } = await konfigMitFreiemPort();
  const alt = await eigeneAttrappe(port);
  try {
    const stop = await fuehreAus([CLI, 'stop', '--konfig', pfad]);
    assert.equal(stop.code, 1);
    assert.match(stop.stderr, /Alter Dienst ohne Stopp-Endpunkt/);
  } finally {
    await schliesse(alt);
  }
});

test('K56: stelleSicher liefert ergebnis und health; start druckt die pid aus diesem health', { timeout: 20000 }, async () => {
  const { pfad, konfig } = await konfigMitFreiemPort();
  try {
    const erg = await stelleSicher(konfig, { konfigPfad: pfad, wartenMs: 5000 });
    assert.equal(erg.ergebnis, 'gestartet');
    assert.ok(Number.isInteger(erg.health.pid));
    const zweiter = await stelleSicher(konfig, { konfigPfad: pfad, wartenMs: 5000 });
    assert.equal(zweiter.ergebnis, 'laeuft');
    assert.equal(zweiter.health.pid, erg.health.pid);
    const start = await fuehreAus([CLI, 'start', '--konfig', pfad]);
    assert.match(start.stdout, new RegExp(`laeuft bereits: .*pid ${erg.health.pid},`));
  } finally {
    const stop = await fuehreAus([CLI, 'stop', '--konfig', pfad]);
    assert.equal(stop.code, 0, stop.stderr);
  }
});

test('K57: Argumente pruefen vor dem Laden der Konfig; Hilfe ohne Konfigzwang', async () => {
  const gibtsNicht = path.join(tempOrdner(), 'fehlt.json');
  const faelle = [
    [['status', '--konfig'], /--konfig/],
    [['status', '--konfig', '--tage', '3'], /--konfig/],
    [['bericht', '--tage'], /--tage/],
    [['bericht', '--tage', 'Infinity'], /--tage/],
    [['bericht', '--tage', '0'], /--tage/],
    [['bericht', '--tage', 'abc'], /--tage/],
  ];
  for (const [args, muster] of faelle) {
    const erg = await fuehreAus([CLI, ...args]);
    assert.equal(erg.code, 2, args.join(' '));
    assert.match(erg.stderr, muster, args.join(' '));
  }
  const unbekannt = await fuehreAus([CLI, 'quatsch', '--konfig', gibtsNicht]);
  assert.equal(unbekannt.code, 2);
  assert.match(unbekannt.stderr, /Aufruf:/);
  assert.equal(unbekannt.stderr.includes('Konfiguration nicht lesbar'), false);
});

// ---------- Iteration 7 ----------
import { istNodeProzess, stoppeHaengenden, stoppeDienst, schreibeAtomar, starteLosgeloest as starteLos } from '../lib/dienst.mjs';

test('K68: istNodeProzess erkennt Node-Prozesse, fremde Abbilder und nicht vorhandene pids', async () => {
  const { port } = await konfigMitFreiemPort();
  const a = starteAttrappe(port, 'haengt');
  await a.bereit;
  const fremd = process.platform === 'win32'
    ? spawn('cmd.exe', ['/c', 'ping', '-n', '30', '127.0.0.1'], { windowsHide: true })
    : spawn('sleep', ['30']);
  try {
    assert.equal(istNodeProzess(a.kind.pid), true);
    assert.equal(istNodeProzess(process.pid), true);
    assert.equal(istNodeProzess(fremd.pid), false);
    assert.equal(istNodeProzess(FREMDE_PID), false);
  } finally {
    a.kind.kill();
    fremd.kill();
    await a.beendet;
  }
});

test('K68: kein Node-Abbild -> nicht toeten, PID-Datei als veraltet loeschen, pid-fremd', { timeout: 40000 }, async () => {
  const { port, pfad } = await konfigMitFreiemPort();
  const a = starteAttrappe(port, 'haengt');
  await a.bereit;
  const pidDatei = path.join(path.dirname(pfad), 'vermittler.pid');
  fs.writeFileSync(pidDatei, JSON.stringify({ pid: a.kind.pid, port, version: VERSION, gestartet: new Date().toISOString() }));
  try {
    const erg = await stoppeHaengenden(port, pfad, { istNodeProzess: () => false });
    assert.equal(erg, 'pid-fremd');
    assert.equal(lebt(a.kind.pid), true, 'fremder Prozess wurde getoetet');
    assert.equal(fs.existsSync(pidDatei), false, 'veraltete PID-Datei blieb liegen');
  } finally {
    a.kind.kill();
    await a.beendet;
  }
});

test('K68: die eigene pid wird nie getoetet', { timeout: 40000 }, async () => {
  const { port, pfad } = await konfigMitFreiemPort();
  const attr = await attrappe(port, (req, res) => {
    if (req.url === '/_vermittler/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, dienst: DIENST, version: VERSION, pid: process.pid }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  fs.writeFileSync(path.join(path.dirname(pfad), 'vermittler.pid'), JSON.stringify({ pid: process.pid, port }));
  try {
    const erg = await stoppeDienst(port, { pid: process.pid }, { konfigPfad: pfad });
    assert.equal(erg, 'pid-fremd');
  } finally {
    await schliesse(attr);
  }
});

test('K68/K69: cliStop meldet pid-fremd als veraltete PID-Datei', { timeout: 40000 }, async () => {
  const { port, pfad } = await konfigMitFreiemPort();
  const alt = await eigeneAttrappe(port);
  // PID-Datei zeigt auf einen lebenden Nicht-Node-Prozess
  const fremd = process.platform === 'win32'
    ? spawn('cmd.exe', ['/c', 'ping', '-n', '60', '127.0.0.1'], { windowsHide: true })
    : spawn('sleep', ['60']);
  try {
    const attrappenPid = FREMDE_PID;
    assert.ok(attrappenPid);
    fs.writeFileSync(path.join(path.dirname(pfad), 'vermittler.pid'), JSON.stringify({ pid: fremd.pid, port }));
    // die Attrappe meldet die pid des fremden Prozesses
    await schliesse(alt);
    const meldet = await attrappe(port, (req, res) => {
      if (req.url === '/_vermittler/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, dienst: DIENST, version: VERSION, pid: fremd.pid }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const stop = await fuehreAus([CLI, 'stop', '--konfig', pfad], { timeoutMs: 30000 });
      assert.equal(stop.code, 1);
      assert.match(stop.stderr, /PID-Datei veraltet, nichts beendet/);
      assert.equal(lebt(fremd.pid), true);
    } finally {
      await schliesse(meldet);
    }
  } finally {
    fremd.kill();
  }
});

test('K69: stoppeHaengenden nimmt den sanften Weg, wenn der Dienst wieder antwortet', { timeout: 40000 }, async () => {
  const { port, pfad } = await konfigMitFreiemPort();
  let anfragen = 0;
  let server;
  server = await attrappe(port, (req, res) => {
    anfragen += 1;
    if (anfragen === 1) return; // erste Anfrage haengt
    if (req.url === '/_vermittler/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, dienst: DIENST, version: VERSION, pid: FREMDE_PID }));
      return;
    }
    if (req.url === '/_vermittler/stop') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}', () => { server.closeAllConnections(); server.close(); });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  assert.equal((await pruefeDienst(port, 300)).art, 'besetzt');
  const erg = await stoppeHaengenden(port, pfad, { istNodeProzess: () => { throw new Error('darf nicht gerufen werden'); } });
  assert.equal(erg, 'gestoppt');
  assert.equal((await pruefeDienst(port, 300)).art, 'keiner');
});

test('K70: schreibeAtomar raeumt die Tempdatei auf, wenn das Umbenennen scheitert', () => {
  const ordner = tempOrdner();
  const ziel = path.join(ordner, 'ist-ein-ordner');
  fs.mkdirSync(ziel);
  fs.writeFileSync(path.join(ziel, 'inhalt'), 'x');
  assert.throws(() => schreibeAtomar(ziel, 'text'));
  assert.deepEqual(fs.readdirSync(ordner), ['ist-ein-ordner']);
});

test('K71: fehlender oder leerer konfigPfad -> konfig-fehlt statt eines Wurfs', async () => {
  assert.equal(await starteLos(undefined), 'konfig-fehlt');
  assert.equal(await starteLos(''), 'konfig-fehlt');
  const { konfig } = await konfigMitFreiemPort();
  assert.equal((await stelleSicher(konfig, {})).ergebnis, 'konfig-fehlt');
  assert.equal((await stelleSicher(konfig, { konfigPfad: '' })).ergebnis, 'konfig-fehlt');
});
