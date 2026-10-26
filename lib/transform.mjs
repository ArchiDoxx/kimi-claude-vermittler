// T1 (Haltezeit), T2 (Schema-Glaettung), T3 (Denkbudget) und die Bausteine von T4
// (Thinking-Bindung; die Wiederholung selbst steuert vermittler.mjs). Reine Funktionen: die Eingabe wird nie
// veraendert; unveraenderte Teile werden als dieselbe Referenz zurueckgegeben.

export const MODI = Object.freeze(['ttl1h', 'sockel1h', 'ping', 'aus']);

const KOMBINATOREN = Object.freeze(['oneOf', 'anyOf', 'allOf']);

const SATZ = Object.freeze({
  oneOf: 'Genau eine dieser Feldgruppen angeben',
  anyOf: 'Mindestens eine dieser Feldgruppen angeben',
  allOf: 'Alle Felder der Gruppen angeben',
});

// ---------- Moduswahl ----------

export function modusFuer(konfig, modell) {
  const tabelle = konfig.modeByModel ?? {};
  if (typeof modell !== 'string') return konfig.mode;
  const treffer = Object.keys(tabelle)
    .filter((praefix) => modell.startsWith(praefix))
    .sort((a, b) => b.length - a.length)[0];
  return treffer ? tabelle[treffer] : konfig.mode;
}

// ---------- Marken finden ----------

// Liefert die Orte aller cache_control-Marken in API-Reihenfolge (tools, system, messages).
// Ein Ort ist { bereich, pfad } mit pfad als Indexliste ab dem Bereich.
function markenOrte(body) {
  const orte = [];
  if (Array.isArray(body.tools)) {
    body.tools.forEach((t, i) => istMarke(t) && orte.push({ bereich: 'tools', pfad: [i] }));
  }
  if (Array.isArray(body.system)) {
    body.system.forEach((b, i) => istMarke(b) && orte.push({ bereich: 'system', pfad: [i] }));
  }
  if (Array.isArray(body.messages)) {
    body.messages.forEach((m, i) => {
      if (!m || !Array.isArray(m.content)) return;
      m.content.forEach((b, j) => {
        if (istMarke(b)) orte.push({ bereich: 'messages', pfad: [i, j] });
        if (b && Array.isArray(b.content)) {
          b.content.forEach((c, k) => istMarke(c) && orte.push({ bereich: 'messages', pfad: [i, j, k] }));
        }
      });
    });
  }
  return orte;
}

function istMarke(block) {
  return Boolean(block && typeof block === 'object' && block.cache_control && typeof block.cache_control === 'object');
}

export function zaehleMarken(body) {
  if (!body || typeof body !== 'object') return 0;
  return markenOrte(body).length;
}

function markeAn(body, { bereich, pfad }) {
  if (bereich === 'tools') return body.tools[pfad[0]];
  if (bereich === 'system') return body.system[pfad[0]];
  const block = body.messages[pfad[0]].content[pfad[1]];
  return pfad.length === 3 ? block.content[pfad[2]] : block;
}

// ---------- unveraenderliches Ersetzen ----------

function ersetzeIndex(liste, index, wert) {
  return liste.map((alt, i) => (i === index ? wert : alt));
}

function ersetzeBlock(body, { bereich, pfad }, neuerBlock) {
  if (bereich === 'tools') return { ...body, tools: ersetzeIndex(body.tools, pfad[0], neuerBlock) };
  if (bereich === 'system') return { ...body, system: ersetzeIndex(body.system, pfad[0], neuerBlock) };
  const [i, j, k] = pfad;
  const nachricht = body.messages[i];
  const block = nachricht.content[j];
  const neuerInhaltsblock = pfad.length === 3
    ? { ...block, content: ersetzeIndex(block.content, k, neuerBlock) }
    : neuerBlock;
  const neueNachricht = { ...nachricht, content: ersetzeIndex(nachricht.content, j, neuerInhaltsblock) };
  return { ...body, messages: ersetzeIndex(body.messages, i, neueNachricht) };
}

// ---------- T1: Haltezeit ----------

function bereichErfasst(modus, bereich) {
  if (modus === 'ttl1h') return true;
  if (modus === 'sockel1h') return bereich === 'tools' || bereich === 'system';
  return false;
}

// Setzt ttl "1h" auf ephemeral-Marken ohne ttl. Vorhandene ttl bleiben. Steht eine Marke mit
// kuerzerer vorhandener ttl im Weg, wird dahinter nichts mehr angehoben (Reihenfolge-Regel).
export function setzeHaltezeit(body, modus) {
  if (!body || typeof body !== 'object') return body;
  if (modus !== 'ttl1h' && modus !== 'sockel1h') return body;
  const orte = markenOrte(body);
  let ergebnis = body;
  let kuerzerGesehen = false;
  for (const ort of orte) {
    const block = markeAn(ergebnis, ort);
    const marke = block.cache_control;
    if (marke.ttl !== undefined) {
      if (marke.ttl !== '1h') kuerzerGesehen = true;
      continue;
    }
    if (marke.type !== 'ephemeral' || kuerzerGesehen || !bereichErfasst(modus, ort.bereich)) {
      kuerzerGesehen = kuerzerGesehen || marke.type === 'ephemeral';
      continue;
    }
    ergebnis = ersetzeBlock(ergebnis, ort, { ...block, cache_control: { ...marke, ttl: '1h' } });
  }
  return ergebnis;
}

// ---------- T2: Schema-Glaettung ----------

function hatOberstenKombinator(schema) {
  return Boolean(schema && typeof schema === 'object' && KOMBINATOREN.some((k) => Array.isArray(schema[k])));
}

function gruppeText(zweig) {
  const felder = Array.isArray(zweig?.required) && zweig.required.length > 0
    ? zweig.required
    : Object.keys(zweig?.properties ?? {});
  return `(${felder.join(', ')})`;
}

function vereinigeProperties(schema) {
  const quellen = [schema.properties ?? {}];
  for (const k of KOMBINATOREN) {
    if (Array.isArray(schema[k])) schema[k].forEach((z) => quellen.push(z?.properties ?? {}));
  }
  return quellen.reduce((acc, props) => {
    const neu = Object.entries(props).filter(([schluessel]) => !Object.hasOwn(acc, schluessel));
    return { ...acc, ...Object.fromEntries(neu) };
  }, {});
}

export function glaetteSchema(schema) {
  if (!hatOberstenKombinator(schema)) return schema;
  const saetze = KOMBINATOREN
    .filter((k) => Array.isArray(schema[k]))
    .map((k) => `${SATZ[k]}: ${schema[k].map(gruppeText).join(' | ')}.`);
  const rest = Object.fromEntries(Object.entries(schema).filter(([k]) => !KOMBINATOREN.includes(k)));
  const beschreibung = [schema.description, ...saetze].filter((s) => typeof s === 'string' && s.length > 0).join(' ');
  return {
    ...rest,
    type: schema.type ?? 'object',
    properties: vereinigeProperties(schema),
    description: beschreibung,
  };
}

export function glaetteSchemas(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.tools)) return body;
  const betroffen = body.tools.some((t) => hatOberstenKombinator(t?.input_schema));
  if (!betroffen) return body;
  const tools = body.tools.map((t) => (hatOberstenKombinator(t?.input_schema)
    ? { ...t, input_schema: glaetteSchema(t.input_schema) }
    : t));
  return { ...body, tools };
}

function zaehleGeglaettete(body) {
  if (!body || !Array.isArray(body.tools)) return 0;
  return body.tools.filter((t) => hatOberstenKombinator(t?.input_schema)).length;
}

// ---------- T3: Denkbudget ----------

// Kimi Code CLI 2.3.0 schickt fuer Budget-Modelle (Claude bis 4.5) bei effort max oder xhigh
// `thinking: { type: "enabled" }` ohne `budget_tokens` und dazu `output_config.effort`; die API
// antwortet mit 400 ("thinking.enabled.budget_tokens: Field required"). Ergaenzt wird das Budget
// nach Kimis eigener Staffel (low 1024, medium 4096, sonst 32000), hoechstens max_tokens - 1;
// der effort-Wert entfaellt, das Budget traegt ihn. Reicht max_tokens nicht fuer das
// Mindestbudget 1024, wird Thinking abgeschaltet. Ein vorhandenes Budget bleibt unberuehrt.
const MINDESTBUDGET = 1024;
const BUDGET_JE_EFFORT = Object.freeze({ low: 1024, medium: 4096 });
const STANDARDBUDGET = 32000;

function brauchtBudget(body) {
  const t = body?.thinking;
  return Boolean(t && typeof t === 'object' && t.type === 'enabled' && t.budget_tokens === undefined);
}

export function ergaenzeDenkbudget(body) {
  if (!body || typeof body !== 'object' || !brauchtBudget(body)) return body;
  const oc = body.output_config;
  const effort = oc?.effort;
  const wunsch = Object.hasOwn(BUDGET_JE_EFFORT, effort) ? BUDGET_JE_EFFORT[effort] : STANDARDBUDGET;
  const budget = Number.isInteger(body.max_tokens) ? Math.min(wunsch, body.max_tokens - 1) : wunsch;
  const thinking = budget >= MINDESTBUDGET ? { ...body.thinking, budget_tokens: budget } : { type: 'disabled' };
  const ergebnis = { ...body, thinking };
  if (oc && typeof oc === 'object' && Object.hasOwn(oc, 'effort')) {
    const rest = Object.fromEntries(Object.entries(oc).filter(([k]) => k !== 'effort'));
    if (Object.keys(rest).length > 0) ergebnis.output_config = rest;
    else delete ergebnis.output_config;
  }
  return ergebnis;
}

// ---------- T4: Thinking-Bindung ----------

// Die API bindet jeden signierten Thinking-Block an den Gespraechsanfang samt Tool-Liste.
// Kimi Code schreibt die Secondary-Modell-Liste in die Beschreibung der Tools Agent und
// AgentSwarm und aktualisiert sie in laufenden Sessions, sobald sich config.toml aendert;
// danach lehnt die API jede Anfrage der Session mit 400 ab. Abhilfe laut Fehlermeldung:
// `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` plus Beta-Kopfzeile.
export const BINDUNGS_BETA = 'thinking-binding-controls-2026-08-01';

export function istBindungsFehler(status, text) {
  if (status !== 400 || typeof text !== 'string') return false;
  try {
    const nachricht = JSON.parse(text)?.error?.message;
    return typeof nachricht === 'string' && nachricht.includes('thinking.block_binding.prefix_mismatch_behavior');
  } catch {
    return false;
  }
}

export function verwirfFremdbindung(body) {
  const t = body?.thinking;
  if (!t || typeof t !== 'object') return body;
  if (t.block_binding?.prefix_mismatch_behavior === 'drop_block') return body;
  return { ...body, thinking: { ...t, block_binding: { ...t.block_binding, prefix_mismatch_behavior: 'drop_block' } } };
}

// ---------- Gesamt ----------

export function transformiere(body, modus) {
  const marken = zaehleMarken(body);
  const geglaettet = zaehleGeglaettete(body);
  const denkbudget = brauchtBudget(body);
  const nachT1 = setzeHaltezeit(body, modus);
  const nachT2 = glaetteSchemas(nachT1);
  const nachT3 = ergaenzeDenkbudget(nachT2);
  return { body: nachT3, geaendert: nachT3 !== body, marken, geglaettet, denkbudget };
}
