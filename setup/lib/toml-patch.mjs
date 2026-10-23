// Zeilenbasierte Patcher fuer ~/.kimi-code/config.toml (kein TOML-Parser). Reine Funktionen
// (text) => text; die Eingabe wird nie veraendert, unberuehrte Zeilen bleiben bytegleich.
// Tabellenkoepfe werden tolerant erkannt (Einrueckung, Leerraum in den Klammern, Kommentar
// dahinter), aber nur als ganze Kopfzeile: Elemente mehrzeiliger Arrays wie `  ["a"],` gelten
// nicht als Kopf. Keine Funktion gibt Inhalte von Schluesselzeilen zurueck.

const KOPF = /^\s*\[\[?\s*[^[\]\s][^[\]]*?\s*\]\]?\s*(#.*)?$/;
const PROVIDER_KOPF = /^\s*\[\s*providers\s*\.\s*(?:anthropic|"anthropic"|'anthropic')\s*\]\s*(#.*)?$/;
const HOOK_KOPF = /^\s*\[\[\s*hooks\s*\]\]\s*(#.*)?$/;
const MODELL_KOPF = /^\s*\[\s*models\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]\s*(#.*)?$/;
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/?$/;
const EIGENE_SKRIPTE = Object.freeze(['/hooks/session-start.mjs', '/hooks/session-ereignis.mjs']);

export const HOOK_TIMEOUT = 5;

// ---------- Form: BOM und Zeilenende ----------

// Die Patcher arbeiten intern auf LF ohne BOM. Nutzt die Datei CRLF oder eine BOM, wird eine
// geaenderte Fassung wieder so zurueckgegeben; eine unveraenderte bleibt bytegleich.
function zerlegeForm(text) {
  const roh = String(text);
  const bom = roh.startsWith('\uFEFF');
  const ohneBom = bom ? roh.slice(1) : roh;
  const crlf = ohneBom.includes('\r\n');
  return { bom, crlf, lf: crlf ? ohneBom.replace(/\r\n/g, '\n') : ohneBom };
}

function mitZeilenende(patcher) {
  return (text, ...rest) => {
    const form = zerlegeForm(text);
    const neu = patcher(form.lf, ...rest);
    if (neu === form.lf) return text;
    const mitEnde = form.crlf ? neu.replace(/\r?\n/g, '\r\n') : neu;
    return form.bom ? `\uFEFF${mitEnde}` : mitEnde;
  };
}

function aufLf(leser) {
  return (text, ...rest) => leser(zerlegeForm(text).lf, ...rest);
}

// ---------- Grundlagen ----------

export function tomlString(wert) {
  return `"${String(wert).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function istLoopbackUrl(url) {
  return typeof url === 'string' && LOOPBACK_URL.test(url);
}

// Liest einen TOML-Wert der Form "basic" oder 'literal'; sonst null.
function leseString(roh) {
  const t = roh.trim();
  const basic = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(t);
  if (basic) return basic[1].replace(/\\(["\\])/g, '$1');
  const literal = /^'([^']*)'\s*(#.*)?$/.exec(t);
  return literal ? literal[1] : null;
}

function wertVon(zeile, schluessel) {
  const m = new RegExp(`^\\s*${schluessel}\\s*=(.*)$`).exec(zeile);
  return m ? m[1] : null;
}

function zerlege(text) {
  return text.split('\n');
}

// Bloecke: je Kopfzeile { start, ende } mit ende exklusiv (naechster Kopf oder Dateiende).
function bloecke(zeilen) {
  const starts = zeilen.flatMap((z, i) => (KOPF.test(z) ? [i] : []));
  return starts.map((start, i) => ({ start, ende: i + 1 < starts.length ? starts[i + 1] : zeilen.length }));
}

function anhaengen(text, block) {
  if (text.length === 0) return block;
  const basis = text.endsWith('\n') ? text : `${text}\n`;
  return `${basis}\n${block}`;
}

function ohneZeilen(zeilen, weg) {
  return zeilen.filter((_, i) => !weg.has(i));
}

function bereich(start, ende) {
  return Array.from({ length: ende - start }, (_, i) => start + i);
}

// ---------- Provider und base_url ----------

function providerBlock(zeilen) {
  return bloecke(zeilen).find((b) => PROVIDER_KOPF.test(zeilen[b.start])) ?? null;
}

function setzeProviderLf(text) {
  if (providerBlock(zerlege(text))) return text;
  return anhaengen(text, '[providers.anthropic]\ntype = "anthropic"\napi_key_env = "ANTHROPIC_API_KEY"\n');
}

function baseUrlIndex(zeilen, block) {
  return bereich(block.start + 1, block.ende).find((i) => wertVon(zeilen[i], 'base_url') !== null) ?? -1;
}

function leseBaseUrlLf(text) {
  const zeilen = zerlege(text);
  const block = providerBlock(zeilen);
  if (!block) return null;
  const i = baseUrlIndex(zeilen, block);
  return i < 0 ? null : leseString(wertVon(zeilen[i], 'base_url'));
}

function setzeBaseUrlLf(text, port) {
  const zeilen = zerlege(text);
  const block = providerBlock(zeilen);
  if (!block) return text;
  const neu = `base_url = ${tomlString(`http://127.0.0.1:${port}`)}`;
  const i = baseUrlIndex(zeilen, block);
  if (i >= 0) return zeilen[i] === neu ? text : zeilen.map((z, j) => (j === i ? neu : z)).join('\n');
  return [...zeilen.slice(0, block.start + 1), neu, ...zeilen.slice(block.start + 1)].join('\n');
}

// Entfernt base_url im Anthropic-Block nur, wenn sie auf Loopback zeigt (also auf uns).
function entferneBaseUrlLf(text) {
  const zeilen = zerlege(text);
  const block = providerBlock(zeilen);
  if (!block) return text;
  const i = baseUrlIndex(zeilen, block);
  if (i < 0 || !istLoopbackUrl(leseString(wertVon(zeilen[i], 'base_url')))) return text;
  return ohneZeilen(zeilen, new Set([i])).join('\n');
}

function hatKeyZeileLf(text) {
  const zeilen = zerlege(text);
  const block = providerBlock(zeilen);
  if (!block) return false;
  return bereich(block.start + 1, block.ende).some((i) => wertVon(zeilen[i], 'api_key') !== null);
}

function leseKeyEnvLf(text) {
  const zeilen = zerlege(text);
  const block = providerBlock(zeilen);
  if (!block) return null;
  const i = bereich(block.start + 1, block.ende).find((j) => wertVon(zeilen[j], 'api_key_env') !== null);
  return i === undefined ? null : leseString(wertVon(zeilen[i], 'api_key_env'));
}

// ---------- Modelle ----------

// Alias aus einem Modellkopf, gleich ob "quoted", 'literal' oder bare.
function aliasAus(zeile) {
  const m = MODELL_KOPF.exec(zeile);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

// Bloecke einer Modelldatei als { alias, text } ohne nachlaufende Leerzeilen.
function modellBloecke(modelleText) {
  const zeilen = zerlege(zerlegeForm(modelleText).lf);
  return bloecke(zeilen).flatMap(({ start, ende }) => {
    const alias = aliasAus(zeilen[start]);
    if (!alias) return [];
    const teil = zeilen.slice(start, ende);
    while (teil.length > 0 && teil[teil.length - 1].trim() === '') teil.pop();
    return [{ alias, text: `${teil.join('\n')}\n` }];
  });
}

function modellAliaseLf(modelleText) {
  return [...new Set(modellBloecke(modelleText).map((b) => b.alias))];
}

function vorhandeneAliase(text) {
  return new Set(zerlege(text).flatMap((z) => {
    const alias = aliasAus(z);
    return alias ? [alias] : [];
  }));
}

function zaehleModelleLf(text, modelleText) {
  const da = vorhandeneAliase(text);
  return modellAliaseLf(modelleText).filter((a) => da.has(a)).length;
}

// Haengt fehlende Bloecke an; ein Alias, der in der Modelldatei doppelt steht, kommt nur einmal.
function ergaenzeModelleLf(text, modelleText) {
  const start = { text, da: vorhandeneAliase(text) };
  return modellBloecke(modelleText).reduce((acc, b) => (acc.da.has(b.alias)
    ? acc
    : { text: anhaengen(acc.text, b.text), da: new Set([...acc.da, b.alias]) }), start).text;
}

// ---------- Hooks ----------

function vorwaerts(pfad) {
  return String(pfad).replace(/\\/g, '/').replace(/\/+$/, '');
}

// Kein SessionHeartbeat: Kimi Code CLI 2.3.0 lehnt das Ereignis beim Schreiben der config.toml ab
// (Login scheitert mit config.invalid). Das Lebenszeichen liest der Vermittler selbst
// (lib/lebenszeichen.mjs); einrichten ersetzt einen alten Heartbeat-Eintrag durch diese drei.
export function unsereHooks(nodePfad, klonPfad) {
  const node = vorwaerts(nodePfad);
  const klon = vorwaerts(klonPfad);
  const befehl = (skript) => `"${node}" "${klon}/hooks/${skript}"`;
  return Object.freeze([
    { event: 'SessionStart', command: befehl('session-start.mjs') },
    { event: 'SessionEnd', command: befehl('session-ereignis.mjs') },
    { event: 'SubagentStop', command: befehl('session-ereignis.mjs') },
  ].map((h) => Object.freeze(h)));
}

// Eigene Hooks erkennt man am Skriptnamen, gleich welcher Node- oder Klonpfad davor steht.
export function istEigenerHook(command) {
  if (typeof command !== 'string') return false;
  const norm = vorwaerts(command).toLowerCase();
  return EIGENE_SKRIPTE.some((s) => norm.includes(s));
}

function eintraegeMitBereich(zeilen) {
  return bloecke(zeilen)
    .filter((b) => HOOK_KOPF.test(zeilen[b.start]))
    .map((b) => {
      const felder = {};
      for (const i of bereich(b.start + 1, b.ende)) {
        for (const name of ['event', 'command', 'matcher']) {
          const roh = wertVon(zeilen[i], name);
          if (roh !== null && felder[name] === undefined) felder[name] = leseString(roh);
        }
        const t = wertVon(zeilen[i], 'timeout');
        if (t !== null && felder.timeout === undefined) felder.timeout = Number(t.trim());
      }
      return { ...b, ...felder };
    });
}

function hookEintraegeLf(text) {
  return eintraegeMitBereich(zerlege(text)).map(({ event, command, matcher, timeout }) => ({
    event, command, ...(matcher !== undefined ? { matcher } : {}), ...(timeout !== undefined ? { timeout } : {}),
  }));
}

function ohneEigeneHooks(zeilen) {
  const eigene = eintraegeMitBereich(zeilen).filter((e) => istEigenerHook(e.command));
  return { eigene, rest: ohneZeilen(zeilen, new Set(eigene.flatMap((e) => bereich(e.start, e.ende)))) };
}

function hookBlock(h) {
  return `[[hooks]]\nevent = ${tomlString(h.event)}\ncommand = ${tomlString(h.command)}\ntimeout = ${HOOK_TIMEOUT}\n`;
}

// Stehen genau die aktuellen eigenen Hooks je einmal da, bleibt der Text unveraendert. Sonst
// werden alle eigenen Eintraege (alter Node-Pfad, alter Klon, Duplikate) durch die aktuellen ersetzt.
function ergaenzeHooksLf(text, hooks) {
  const zeilen = zerlege(text);
  const { eigene, rest } = ohneEigeneHooks(zeilen);
  const passt = eigene.length === hooks.length
    && hooks.every((h) => eigene.filter((e) => e.event === h.event && e.command === h.command).length === 1);
  if (passt) return text;
  const basis = eigene.length === 0 ? text : rest.join('\n');
  return hooks.reduce((acc, h) => anhaengen(acc, hookBlock(h)), basis);
}

// Entfernt alle eigenen Hook-Eintraege, gleich welcher Klonpfad (zweites Argument wird ignoriert).
function entferneHooksLf(text) {
  const zeilen = zerlege(text);
  const { eigene, rest } = ohneEigeneHooks(zeilen);
  return eigene.length === 0 ? text : rest.join('\n');
}

// Ein SessionHeartbeat-Hook macht config.toml ab Kimi 2.3.0 unschreibbar: 'eigen' (einrichten
// entfernt ihn), 'fremd' (von Hand entfernen) oder null.
function alterHeartbeatLf(text) {
  const hb = hookEintraegeLf(text).filter((e) => e.event === 'SessionHeartbeat');
  if (hb.length === 0) return null;
  return hb.some((e) => !istEigenerHook(e.command)) ? 'fremd' : 'eigen';
}

function zaehleHooksLf(text, hooks) {
  const da = hookEintraegeLf(text);
  return hooks.filter((h) => da.some((e) => e.event === h.event && e.command === h.command)).length;
}

// ---------- default_model ----------

function leseDefaultModelLf(text) {
  const zeilen = zerlege(text);
  const ersterKopf = zeilen.findIndex((z) => KOPF.test(z));
  const oben = ersterKopf < 0 ? zeilen : zeilen.slice(0, ersterKopf);
  const zeile = oben.find((z) => wertVon(z, 'default_model') !== null);
  return zeile ? leseString(wertVon(zeile, 'default_model')) : null;
}

// ---------- kimi-cu-win (plugins/installed.json) ----------

function cuWinEintrag(json) {
  return Array.isArray(json?.plugins) ? json.plugins.find((p) => p?.id === 'kimi-cu-win') : undefined;
}

export function cuWinStatus(rohJson) {
  const eintrag = cuWinEintrag(JSON.parse(zerlegeForm(rohJson).lf));
  if (!eintrag) return 'fehlt';
  return eintrag.enabled === true ? 'an' : 'aus';
}

export function setzeCuWin(rohJson) {
  const json = JSON.parse(zerlegeForm(rohJson).lf);
  const eintrag = cuWinEintrag(json);
  if (!eintrag || eintrag.enabled === true) return rohJson;
  const einrueckung = /\n([ \t]+)"/.exec(rohJson)?.[1] ?? 2;
  const neu = {
    ...json,
    plugins: json.plugins.map((p) => (p === eintrag ? { ...p, enabled: true } : p)),
  };
  return `${JSON.stringify(neu, null, einrueckung)}${rohJson.endsWith('\n') ? '\n' : ''}`;
}

// ---------- Oeffentliche Fassungen (BOM- und Zeilenende-fest) ----------

export const setzeProvider = mitZeilenende(setzeProviderLf);
export const setzeBaseUrl = mitZeilenende(setzeBaseUrlLf);
export const entferneBaseUrl = mitZeilenende(entferneBaseUrlLf);
export const ergaenzeModelle = mitZeilenende(ergaenzeModelleLf);
export const ergaenzeHooks = mitZeilenende(ergaenzeHooksLf);
export const entferneHooks = mitZeilenende(entferneHooksLf);
export const leseBaseUrl = aufLf(leseBaseUrlLf);
export const hatKeyZeile = aufLf(hatKeyZeileLf);
export const leseKeyEnv = aufLf(leseKeyEnvLf);
export const modellAliase = aufLf(modellAliaseLf);
export const zaehleModelle = aufLf(zaehleModelleLf);
export const hookEintraege = aufLf(hookEintraegeLf);
export const zaehleHooks = aufLf(zaehleHooksLf);
export const alterHeartbeat = aufLf(alterHeartbeatLf);
export const leseDefaultModel = aufLf(leseDefaultModelLf);
