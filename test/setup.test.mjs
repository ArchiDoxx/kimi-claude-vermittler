// Einrichtungs-Patcher (setup/lib/toml-patch.mjs) und setup/setup.mjs gegen Testtexte und
// ein temporaeres Kimi-Verzeichnis. Die echte config.toml wird nie beruehrt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  tomlString, setzeProvider, setzeBaseUrl, entferneBaseUrl, ergaenzeModelle, zaehleModelle, modellAliase,
  unsereHooks, hookEintraege, ergaenzeHooks, entferneHooks, leseDefaultModel, leseBaseUrl, setzeCuWin, cuWinStatus,
} from '../setup/lib/toml-patch.mjs';
import { tempOrdner, schreibeKonfig, freierPort, fuehreAus, WURZEL, TESTSCHLUESSEL } from './hilfen.mjs';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const KLON = 'C:\\Users\\jemand\\.kimi-code\\tools\\anthropic-vermittler';
const MODELLE = fs.readFileSync(path.join(WURZEL, 'setup', 'modelle.toml'), 'utf8');

const MIT_KEY = [
  'default_model = "kimi-code/k3"',
  '',
  '[providers."managed:kimi-code"]',
  'type = "kimi"',
  'base_url = "https://api.kimi.com/coding/v1"',
  '',
  '[providers.anthropic]',
  'type = "anthropic"',
  `api_key = "${TESTSCHLUESSEL}"`,
  '',
  '[models."kimi-code/k3"]',
  'provider = "managed:kimi-code"',
  '',
  '[[hooks]]',
  'event = "SessionStart"',
  'command = "\\"C:/py.exe\\" \\"C:/mneme/session_start.py\\" --target kimi"',
  '',
  '[thinking]',
  'mode = "auto"',
  '',
  '[secondary_model]',
  'default_model = "zai-coding-plan/glm-5.3"',
  '',
].join('\n');

const OHNE_PROVIDER = MIT_KEY.replace(/\[providers\.anthropic\]\ntype = "anthropic"\napi_key = "[^"]*"\n\n/, '');

function alles(text, port = 37790) {
  const hooks = unsereHooks(NODE, KLON);
  return ergaenzeHooks(ergaenzeModelle(setzeBaseUrl(setzeProvider(text), port), MODELLE), hooks);
}

// ---------- Grundlagen ----------

test('tomlString maskiert Anfuehrungszeichen und Backslashes', () => {
  assert.equal(tomlString('a"b\\c'), '"a\\"b\\\\c"');
});

test('unsereHooks: vier Eintraege, absolute Pfade mit Vorwaertsschraegstrichen', () => {
  const hooks = unsereHooks(NODE, KLON);
  assert.deepEqual(hooks.map((h) => h.event), ['SessionStart', 'SessionEnd', 'SessionHeartbeat', 'SubagentStop']);
  assert.equal(hooks[0].command, '"C:/Program Files/nodejs/node.exe" "C:/Users/jemand/.kimi-code/tools/anthropic-vermittler/hooks/session-start.mjs"');
  assert.ok(hooks.slice(1).every((h) => h.command.endsWith('/hooks/session-ereignis.mjs"')));
  assert.ok(hooks.every((h) => !h.command.includes('\\')));
});

test('modelle.toml: genau 17 Claude-Bloecke, alle provider anthropic, kein Key, always_thinking bei den vier Pflichtmodellen', () => {
  const aliase = modellAliase(MODELLE);
  assert.equal(aliase.length, 17);
  assert.ok(aliase.every((a) => a.startsWith('anthropic/claude-')));
  assert.equal((MODELLE.match(/^provider = "anthropic"$/gm) ?? []).length, 17);
  assert.equal(/api_key|sk-ant/i.test(MODELLE), false);
  for (const alias of ['anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5', 'anthropic/claude-fable-5', 'anthropic/claude-fable-5-1']) {
    const block = MODELLE.split(`[models."${alias}"]`)[1].split('\n[')[0];
    assert.match(block, /"always_thinking"/, alias);
  }
});

// ---------- Provider und base_url ----------

test('fehlender Provider wird mit api_key_env angehaengt, nie mit einem Key; idempotent', () => {
  const einmal = setzeProvider(OHNE_PROVIDER);
  assert.ok(einmal.startsWith(OHNE_PROVIDER), 'nur angehaengt');
  assert.match(einmal, /\n\[providers\.anthropic\]\ntype = "anthropic"\napi_key_env = "ANTHROPIC_API_KEY"\n$/);
  assert.equal(/^api_key\s*=/m.test(einmal.slice(OHNE_PROVIDER.length)), false);
  assert.equal(setzeProvider(einmal), einmal);
});

test('vorhandener Provider mit Key bleibt bytegleich; base_url ist die einzige Aenderung', () => {
  assert.equal(setzeProvider(MIT_KEY), MIT_KEY);
  const mitUrl = setzeBaseUrl(MIT_KEY, 37790);
  assert.equal(mitUrl.split('\n').filter((z) => z !== 'base_url = "http://127.0.0.1:37790"').join('\n'), MIT_KEY);
  assert.ok(mitUrl.includes(`api_key = "${TESTSCHLUESSEL}"`));
  assert.equal(setzeBaseUrl(mitUrl, 37790), mitUrl);
  assert.equal(leseBaseUrl(mitUrl), 'http://127.0.0.1:37790');
});

test('base_url wird ersetzt, nicht verdoppelt; andere Provider-Bloecke bleiben', () => {
  const alt = setzeBaseUrl(MIT_KEY, 11111);
  const neu = setzeBaseUrl(alt, 22222);
  assert.equal((neu.match(/^base_url = "http:\/\/127\.0\.0\.1:/gm) ?? []).length, 1);
  assert.equal(leseBaseUrl(neu), 'http://127.0.0.1:22222');
  assert.ok(neu.includes('base_url = "https://api.kimi.com/coding/v1"'));
});

test('setzeBaseUrl ohne Provider-Block aendert nichts', () => {
  assert.equal(setzeBaseUrl(OHNE_PROVIDER, 37790), OHNE_PROVIDER);
  assert.equal(leseBaseUrl(OHNE_PROVIDER), null);
});

test('Provider-Block als letzter Block ohne Zeilenende am Dateiende', () => {
  const text = '[providers.anthropic]\ntype = "anthropic"';
  assert.equal(setzeBaseUrl(text, 5), '[providers.anthropic]\nbase_url = "http://127.0.0.1:5"\ntype = "anthropic"');
});

test('entferneBaseUrl entfernt nur eine Loopback-base_url im Anthropic-Block', () => {
  const mitUrl = setzeBaseUrl(MIT_KEY, 37790);
  assert.equal(entferneBaseUrl(mitUrl), MIT_KEY);
  const fremd = MIT_KEY.replace('type = "anthropic"', 'type = "anthropic"\nbase_url = "https://proxy.example"');
  assert.equal(entferneBaseUrl(fremd), fremd);
});

// ---------- Modelle ----------

test('ergaenzeModelle haengt nur fehlende Bloecke an; idempotent', () => {
  const teil = MODELLE.split('[models."anthropic/claude-opus-5-5"]')[0];
  const mitEinem = `${MIT_KEY}\n${teil}`;
  const vorher = zaehleModelle(mitEinem, MODELLE);
  assert.ok(vorher > 0 && vorher < 17);
  const voll = ergaenzeModelle(mitEinem, MODELLE);
  assert.equal(zaehleModelle(voll, MODELLE), 17);
  for (const alias of modellAliase(MODELLE)) {
    assert.equal(voll.split(`[models."${alias}"]`).length, 2, `${alias} genau einmal`);
  }
  assert.equal(ergaenzeModelle(voll, MODELLE), voll);
});

// ---------- Hooks ----------

test('ergaenzeHooks: vier Eintraege mit timeout 5, fremde Hooks bleiben; idempotent', () => {
  const hooks = unsereHooks(NODE, KLON);
  const einmal = ergaenzeHooks(MIT_KEY, hooks);
  const eintraege = hookEintraege(einmal);
  assert.equal(eintraege.length, 5);
  assert.equal(eintraege[0].command, '"C:/py.exe" "C:/mneme/session_start.py" --target kimi');
  for (const h of hooks) {
    const treffer = eintraege.filter((e) => e.event === h.event && e.command === h.command);
    assert.equal(treffer.length, 1, h.event);
    assert.equal(treffer[0].timeout, 5);
  }
  assert.equal(ergaenzeHooks(einmal, hooks), einmal);
});

test('ergaenzeHooks: doppelt vorhandener eigener Hook wird zu einem', () => {
  const hooks = unsereHooks(NODE, KLON);
  const einmal = ergaenzeHooks(MIT_KEY, hooks);
  const block = `\n[[hooks]]\nevent = "SessionEnd"\ncommand = ${tomlString(hooks[1].command)}\ntimeout = 5\n`;
  const doppelt = `${einmal}${block}`;
  const bereinigt = ergaenzeHooks(doppelt, hooks);
  assert.equal(hookEintraege(doppelt).filter((e) => e.event === 'SessionEnd' && e.command === hooks[1].command).length, 2);
  assert.equal(hookEintraege(bereinigt).filter((e) => e.event === 'SessionEnd' && e.command === hooks[1].command).length, 1);
  assert.equal(bereinigt, einmal);
});

test('entferneHooks entfernt nur unsere Hooks; mneme und nachfolgende Tabellen bleiben', () => {
  const hooks = unsereHooks(NODE, KLON);
  const mitHooks = ergaenzeHooks(MIT_KEY, hooks);
  const ohne = entferneHooks(mitHooks, KLON);
  assert.equal(ohne, MIT_KEY);
  const mitten = MIT_KEY.replace('[thinking]', `[[hooks]]\nevent = "SessionEnd"\ncommand = ${tomlString(hooks[1].command)}\ntimeout = 5\n\n[thinking]`);
  assert.equal(entferneHooks(mitten, KLON), MIT_KEY);
});

test('entferneHooks vergleicht den Klonpfad ohne Ruecksicht auf Schraegstrich-Art und Gross-/Kleinschreibung', () => {
  const hooks = unsereHooks(NODE, KLON);
  const mitHooks = ergaenzeHooks(MIT_KEY, hooks);
  assert.equal(entferneHooks(mitHooks, KLON.toLowerCase().replace(/\\/g, '/')), MIT_KEY);
});

// ---------- Gesamtfolge ----------

test('Gesamtfolge: zweimal angewendet ist einmal; der Key bleibt bytegleich erhalten', () => {
  const einmal = alles(MIT_KEY);
  assert.equal(alles(einmal), einmal);
  assert.equal(einmal.split('\n').filter((z) => z.startsWith('api_key')).join(), `api_key = "${TESTSCHLUESSEL}"`);
  assert.ok(einmal.startsWith(MIT_KEY.split('[providers.anthropic]')[0]), 'Kopf unveraendert');
});

test('Rueckweg nach der Einrichtung: keine base_url, keine eigenen Hooks; Provider und Modelle bleiben', () => {
  const eingerichtet = alles(MIT_KEY);
  const zurueck = entferneHooks(entferneBaseUrl(eingerichtet), KLON);
  assert.equal(leseBaseUrl(zurueck), null);
  assert.equal(hookEintraege(zurueck).length, 1);
  assert.equal(zaehleModelle(zurueck, MODELLE), 17);
  assert.ok(zurueck.includes(`api_key = "${TESTSCHLUESSEL}"`));
});

test('leseDefaultModel liest nur den Wert auf oberster Ebene', () => {
  assert.equal(leseDefaultModel(MIT_KEY), 'kimi-code/k3');
  assert.equal(leseDefaultModel('[secondary_model]\ndefault_model = "x"\n'), null);
});

// ---------- kimi-cu-win ----------

test('setzeCuWin setzt nur kimi-cu-win auf enabled, Einrueckung bleibt; fehlt der Eintrag, keine Aenderung', () => {
  const roh = `${JSON.stringify({ version: 1, plugins: [{ id: 'a', enabled: false }, { id: 'kimi-cu-win', enabled: false, root: 'C:/x' }] }, null, 2)}\n`;
  assert.equal(cuWinStatus(roh), 'aus');
  const neu = setzeCuWin(roh);
  assert.equal(cuWinStatus(neu), 'an');
  assert.equal(neu, roh.replace('"enabled": false,\n      "root"', '"enabled": true,\n      "root"'));
  assert.equal(setzeCuWin(neu), neu);
  const ohne = `${JSON.stringify({ version: 1, plugins: [{ id: 'a', enabled: false }] }, null, 2)}\n`;
  assert.equal(cuWinStatus(ohne), 'fehlt');
  assert.equal(setzeCuWin(ohne), ohne);
});

// ---------- setup.mjs gegen ein temporaeres Kimi-Verzeichnis ----------

test('setup.mjs: pruefen, einrichten, idempotent, rueckweg; nie ein Key in der Ausgabe', { timeout: 60000 }, async () => {
  const home = tempOrdner('vermittler-test-home-');
  fs.mkdirSync(path.join(home, 'plugins'));
  const toml = path.join(home, 'config.toml');
  fs.writeFileSync(toml, MIT_KEY);
  fs.writeFileSync(path.join(home, 'plugins', 'installed.json'), `${JSON.stringify({ version: 1, plugins: [{ id: 'kimi-cu-win', enabled: false }] }, null, 2)}\n`);
  const ordner = tempOrdner();
  const port = await freierPort();
  const konfig = schreibeKonfig(ordner, { port, upstream: 'http://127.0.0.1:1', logPath: path.join(ordner, 'p.jsonl') });
  const setup = path.join(WURZEL, 'setup', 'setup.mjs');
  const basis = ['--kimi-home', home, '--konfig', konfig, '--ohne-dienst'];
  const ausgaben = [];
  const lauf = async (...args) => {
    const erg = await fuehreAus([setup, ...args, ...basis]);
    ausgaben.push(erg.stdout, erg.stderr);
    return erg;
  };

  const vorher = await lauf('pruefen');
  assert.equal(vorher.code, 0, vorher.stderr);
  assert.match(vorher.stdout, /base_url\s+fehlt/);

  const ein = await lauf('einrichten', '--cu-win');
  assert.equal(ein.code, 0, ein.stderr);
  const nachher = fs.readFileSync(toml, 'utf8');
  assert.equal(leseBaseUrl(nachher), `http://127.0.0.1:${port}`);
  assert.equal(zaehleModelle(nachher, MODELLE), 17);
  const klon = WURZEL.replace(/\\/g, '/');
  assert.equal(hookEintraege(nachher).filter((e) => e.command.includes(`${klon}/hooks/`)).length, 4);
  assert.ok(nachher.includes(`api_key = "${TESTSCHLUESSEL}"`));
  const sicherungen = fs.readdirSync(home).filter((n) => /^config\.toml\.bak-\d{4}-\d{2}-\d{2}-\d{4}/.test(n));
  assert.ok(sicherungen.length >= 1, 'Sicherung fehlt');
  assert.equal(cuWinStatus(fs.readFileSync(path.join(home, 'plugins', 'installed.json'), 'utf8')), 'an');
  assert.match(ein.stdout, /default_model: kimi-code\/k3/);

  const zweites = await lauf('einrichten');
  assert.equal(zweites.code, 0);
  assert.equal(fs.readFileSync(toml, 'utf8'), nachher, 'zweites einrichten aendert nichts');

  const geprueft = await lauf('pruefen');
  assert.match(geprueft.stdout, /base_url\s+vorhanden/);
  assert.match(geprueft.stdout, /Hooks\s+vorhanden \(4\/4\)/);

  const zurueck = await lauf('rueckweg');
  assert.equal(zurueck.code, 0, zurueck.stderr);
  const danach = fs.readFileSync(toml, 'utf8');
  assert.equal(leseBaseUrl(danach), null);
  assert.equal(hookEintraege(danach).length, 1);
  assert.ok(danach.includes(`api_key = "${TESTSCHLUESSEL}"`));

  assert.equal(ausgaben.join('\n').includes('TESTSCHLUESSEL'), false, 'Key in der Ausgabe');
});

test('setup.mjs: fehlende config.toml -> pruefen meldet es mit Exit 0, einrichten bricht mit Exit 1 ab', async () => {
  const home = tempOrdner('vermittler-test-home-');
  const setup = path.join(WURZEL, 'setup', 'setup.mjs');
  const p = await fuehreAus([setup, 'pruefen', '--kimi-home', home, '--ohne-dienst']);
  assert.equal(p.code, 0);
  assert.match(p.stdout, /config\.toml\s+fehlt/);
  const e = await fuehreAus([setup, 'einrichten', '--kimi-home', home, '--ohne-dienst']);
  assert.equal(e.code, 1);
  assert.equal(fs.existsSync(path.join(home, 'config.toml')), false);
});

// ---------- Iteration 5: CRLF (K39) ----------

function nurCrlf(text) {
  return !/(^|[^\r])\n/.test(text);
}

test('K39: CRLF-Datei: alle Patcher idempotent, kein gemischtes Zeilenende, Leser funktionieren', () => {
  const crlf = MIT_KEY.replace(/\n/g, '\r\n');
  const einmal = alles(crlf, 4242);
  assert.ok(nurCrlf(einmal), 'gemischte Zeilenenden');
  assert.equal(alles(einmal, 4242), einmal, 'zweimal = einmal');
  assert.equal(setzeBaseUrl(einmal, 4242), einmal);
  assert.equal(leseBaseUrl(einmal), 'http://127.0.0.1:4242');
  assert.equal(leseDefaultModel(einmal), 'kimi-code/k3');
  assert.equal(zaehleModelle(einmal, MODELLE), 17);
  assert.equal(hookEintraege(einmal).length, 5);
  const zurueck = entferneHooks(entferneBaseUrl(einmal), KLON);
  assert.ok(nurCrlf(zurueck));
  assert.equal(leseBaseUrl(zurueck), null);
  assert.equal(hookEintraege(zurueck).length, 1);
});

test('K39: unveraenderte CRLF-Datei bleibt bytegleich, neuer Provider-Block bekommt CRLF', () => {
  const crlf = MIT_KEY.replace(/\n/g, '\r\n');
  assert.equal(setzeProvider(crlf), crlf);
  const ohne = OHNE_PROVIDER.replace(/\n/g, '\r\n');
  const mit = setzeProvider(ohne);
  assert.ok(mit.endsWith('[providers.anthropic]\r\ntype = "anthropic"\r\napi_key_env = "ANTHROPIC_API_KEY"\r\n'));
  assert.ok(nurCrlf(mit));
});

// ---------- Iteration 6 ----------
import http from 'node:http';

test('K61: Koepfe mit Einrueckung, Leerraum und Kommentar werden erkannt', () => {
  const text = 'default_model = "a"\n\n  [ providers.anthropic ]  # Claude\ntype = "anthropic"\n\n[models."kimi"] # x\nprovider = "kimi"\n';
  assert.equal(setzeProvider(text), text, 'kein zweiter Provider-Block');
  const mitUrl = setzeBaseUrl(text, 7);
  assert.equal(leseBaseUrl(mitUrl), 'http://127.0.0.1:7');
  assert.ok(mitUrl.includes('  [ providers.anthropic ]  # Claude\nbase_url = "http://127.0.0.1:7"\ntype = "anthropic"'));
  assert.equal(setzeBaseUrl(mitUrl, 7), mitUrl);
});

test('K61: Provider in Anfuehrungszeichen und BOM am Dateianfang', () => {
  const text = '\uFEFFdefault_model = "b"\n[providers."anthropic"]\ntype = "anthropic"\n';
  assert.equal(setzeProvider(text), text);
  assert.equal(leseDefaultModel(text), 'b');
  assert.equal(leseBaseUrl(setzeBaseUrl(text, 8)), 'http://127.0.0.1:8');
});

test('K61: bare Alias gilt als vorhanden, kein Duplikat beim zweiten Lauf', () => {
  const modelle = '[models."mein-modell"]\nprovider = "anthropic"\n\n[models."anthropic/x"]\nprovider = "anthropic"\n';
  const text = '[models.mein-modell]\nprovider = "anthropic"\n';
  assert.equal(zaehleModelle(text, modelle), 1);
  const einmal = ergaenzeModelle(text, modelle);
  assert.equal(einmal.split('mein-modell').length, 2, 'mein-modell genau einmal');
  assert.equal(zaehleModelle(einmal, modelle), 2);
  assert.equal(ergaenzeModelle(einmal, modelle), einmal);
});

test('K67: doppelter Block in modelle.toml wird nur einmal angehaengt', () => {
  const modelle = '[models."anthropic/x"]\nprovider = "anthropic"\n\n[models."anthropic/x"]\nprovider = "anthropic"\n';
  const neu = ergaenzeModelle('', modelle);
  assert.equal(neu.split('[models."anthropic/x"]').length, 2);
});

test('K62: eigene Hooks werden am Skriptnamen erkannt und durch die vier aktuellen ersetzt', () => {
  const alt = [
    MIT_KEY.trimEnd(),
    '',
    '[[hooks]]',
    'event = "SessionStart"',
    `command = ${tomlString('"C:/alt/node.exe" "D:/alter-klon/hooks/session-start.mjs"')}`,
    'timeout = 5',
    '',
    '[[hooks]]',
    'event = "SessionEnd"',
    `command = ${tomlString('"C:/alt/node.exe" "D:\\Alter-Klon\\HOOKS\\Session-Ereignis.mjs"')}`,
    '',
  ].join('\n');
  const hooks = unsereHooks(NODE, KLON);
  const neu = ergaenzeHooks(alt, hooks);
  const eintraege = hookEintraege(neu);
  assert.equal(eintraege.length, 5, 'mneme + vier aktuelle');
  assert.equal(eintraege.filter((e) => e.command.toLowerCase().includes('alter-klon')).length, 0);
  for (const h of hooks) assert.equal(eintraege.filter((e) => e.event === h.event && e.command === h.command).length, 1, h.event);
  assert.equal(ergaenzeHooks(neu, hooks), neu);
  assert.equal(hookEintraege(entferneHooks(alt)).length, 1, 'rueckweg entfernt eigene Hooks jeden Pfads');
  assert.equal(hookEintraege(entferneHooks(neu)).length, 1);
});

function homeMit(text) {
  const home = tempOrdner('vermittler-test-home-');
  fs.writeFileSync(path.join(home, 'config.toml'), text);
  return home;
}

test('K63: fremde base_url bricht einrichten ab; mit --base-url-ersetzen wird sie ersetzt und genannt', { timeout: 60000 }, async () => {
  const fremd = MIT_KEY.replace('type = "anthropic"', 'type = "anthropic"\nbase_url = "https://proxy.example"');
  const home = homeMit(fremd);
  const ordner = tempOrdner();
  const konfig = schreibeKonfig(ordner, { port: await freierPort(), upstream: 'http://127.0.0.1:1', logPath: path.join(ordner, 'p.jsonl') });
  const setup = path.join(WURZEL, 'setup', 'setup.mjs');
  const basis = ['--kimi-home', home, '--konfig', konfig, '--ohne-dienst'];
  const ab = await fuehreAus([setup, 'einrichten', ...basis]);
  assert.equal(ab.code, 1);
  assert.match(`${ab.stdout}${ab.stderr}`, /https:\/\/proxy\.example/);
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), fremd, 'Konfig unveraendert');
  const ersetzt = await fuehreAus([setup, 'einrichten', '--base-url-ersetzen', ...basis]);
  assert.equal(ersetzt.code, 0, ersetzt.stderr);
  assert.match(ersetzt.stdout, /https:\/\/proxy\.example/);
  assert.match(leseBaseUrl(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')), /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(`${ab.stdout}${ab.stderr}${ersetzt.stdout}${ersetzt.stderr}`.includes('TESTSCHLUESSEL'), false);
});

test('K64: scheitert der Dienststart, bleibt config.toml unveraendert (Exit 1, keine Sicherung)', { timeout: 60000 }, async () => {
  const home = homeMit(MIT_KEY);
  const fremd = http.createServer((req, res) => { res.writeHead(200); res.end('fremd'); });
  await new Promise((r) => fremd.listen(0, '127.0.0.1', r));
  const ordner = tempOrdner();
  const konfig = schreibeKonfig(ordner, { port: fremd.address().port, upstream: 'http://127.0.0.1:1', logPath: path.join(ordner, 'p.jsonl') });
  try {
    const erg = await fuehreAus([path.join(WURZEL, 'setup', 'setup.mjs'), 'einrichten', '--kimi-home', home, '--konfig', konfig]);
    assert.equal(erg.code, 1);
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), MIT_KEY);
    assert.deepEqual(fs.readdirSync(home), ['config.toml']);
  } finally {
    fremd.closeAllConnections();
    await new Promise((r) => fremd.close(r));
  }
});

test('K65/K66: atomar geschrieben (keine Tempdateien), Hinweis auf Key in der Sicherung', { timeout: 60000 }, async () => {
  const home = homeMit(MIT_KEY);
  fs.mkdirSync(path.join(home, 'plugins'));
  fs.writeFileSync(path.join(home, 'plugins', 'installed.json'), `${JSON.stringify({ version: 1, plugins: [{ id: 'kimi-cu-win', enabled: false }] }, null, 2)}\n`);
  const ordner = tempOrdner();
  const konfig = schreibeKonfig(ordner, { port: await freierPort(), upstream: 'http://127.0.0.1:1', logPath: path.join(ordner, 'p.jsonl') });
  const erg = await fuehreAus([path.join(WURZEL, 'setup', 'setup.mjs'), 'einrichten', '--cu-win', '--kimi-home', home, '--konfig', konfig, '--ohne-dienst']);
  assert.equal(erg.code, 0, erg.stderr);
  assert.match(erg.stdout, /Sicherung enthaelt eine Kopie der Konfig samt eventuellem Key/);
  const alle = [...fs.readdirSync(home), ...fs.readdirSync(path.join(home, 'plugins'))];
  assert.equal(alle.some((n) => n.includes('.tmp')), false, alle.join(', '));
});
