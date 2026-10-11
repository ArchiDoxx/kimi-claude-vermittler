// T1 (Haltezeit) und T2 (Schema-Glaettung). Reine Funktionen: die Eingabe wird nie
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

// ---------- Gesamt ----------

export function transformiere(body, modus) {
  const marken = zaehleMarken(body);
  const geglaettet = zaehleGeglaettete(body);
  const nachT1 = setzeHaltezeit(body, modus);
  const nachT2 = glaetteSchemas(nachT1);
  return { body: nachT2, geaendert: nachT2 !== body, marken, geglaettet };
}
