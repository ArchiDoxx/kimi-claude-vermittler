// Kostenprotokoll (JSONL), Gegenrechnung der Varianten, Warnungen und Bericht.
// Es werden nie Inhalte, Prompts, Kopfzeilen oder Schluessel geschrieben: jeder Eintrag
// wird aus einer festen Feldliste aufgebaut.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FUENF_MIN = 300;
const EINE_STUNDE = 3600;
const SESSION_WECHSEL_FENSTER = 600;
const SESSION_RUHE_SEK = 60;
const INAKTIV_MS = 2 * 60 * 60 * 1000;
const PRAEFIX_SCHWELLE = 0.9;

export function sha12(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 12);
}

function rund(dollar) {
  return Number(dollar.toFixed(8));
}

export function preisFuer(preise, modell) {
  if (!preise || typeof modell !== 'string') return null;
  const treffer = Object.keys(preise)
    .filter((praefix) => modell.startsWith(praefix))
    .sort((a, b) => b.length - a.length)[0];
  return treffer ? preise[treffer] : null;
}

function zahl(wert) {
  return Number.isFinite(wert) ? wert : 0;
}

const USAGE_FELDER = Object.freeze(['input', 'cache_read', 'cache_w5m', 'cache_w1h', 'output']);

// Wandelt das usage-Objekt der API in die Protokollform. Idempotent: eine bereits
// normalisierte Form bleibt (nur Zahlen werden abgesichert).
export function normalisiereUsage(roh) {
  const u = roh && typeof roh === 'object' ? roh : {};
  if (USAGE_FELDER.every((f) => Object.hasOwn(u, f))) {
    return Object.fromEntries(USAGE_FELDER.map((f) => [f, zahl(u[f])]));
  }
  const cc = u.cache_creation;
  const hatZerlegung = Boolean(cc && typeof cc === 'object'
    && (Number.isFinite(cc.ephemeral_5m_input_tokens) || Number.isFinite(cc.ephemeral_1h_input_tokens)));
  return {
    input: zahl(u.input_tokens),
    cache_read: zahl(u.cache_read_input_tokens),
    cache_w5m: hatZerlegung ? zahl(cc.ephemeral_5m_input_tokens) : zahl(u.cache_creation_input_tokens),
    cache_w1h: hatZerlegung ? zahl(cc.ephemeral_1h_input_tokens) : 0,
    output: zahl(u.output_tokens),
  };
}

// Fuehrt usage aus message_start und message_delta zusammen; spaetere Werte gewinnen.
export function verschmelzeUsage(alt, neu) {
  if (!neu || typeof neu !== 'object') return alt;
  if (!alt) return neu;
  const definiert = Object.fromEntries(Object.entries(neu).filter(([, w]) => w !== null && w !== undefined));
  const cc = alt.cache_creation && definiert.cache_creation
    ? { ...alt.cache_creation, ...definiert.cache_creation }
    : definiert.cache_creation ?? alt.cache_creation;
  return cc === undefined ? { ...alt, ...definiert } : { ...alt, ...definiert, cache_creation: cc };
}

export function kostenAus(usage, preis) {
  if (!preis) return null;
  const summe = usage.input * preis.input + usage.cache_read * preis.read
    + usage.cache_w5m * preis.w5m + usage.cache_w1h * preis.w1h + usage.output * preis.output;
  return rund(summe / 1e6);
}

// Anzahl der Pings, die Variante B im Abstand gesendet haette: bei k*intervalSec nach dem
// Start der letzten Anfrage, strikt vor der naechsten Anfrage und hoechstens bis maxIdleMin.
// Abstaende sind ganze Sekunden.
export function pingAnzahl(abstandSek, ping) {
  if (abstandSek === null || abstandSek === undefined || abstandSek <= 0) return 0;
  return Math.floor(Math.min(abstandSek - 1, ping.maxIdleMin * 60) / ping.intervalSec);
}

// Rechnet aus denselben Token-Zahlen und dem echten Zeitabstand, was die vier Varianten
// gekostet haetten. "alt" ist der Praefixteil, der schon in der vorigen Anfrage stand,
// "neu" der Zuwachs. Der Sockel (tools + system) wird ueber den Zeichenanteil geschaetzt.
export function gegenrechnung({ usage, preis, abstandSek, vorigesPraefix, sockelAnteil, ping }) {
  if (!preis) return null;
  const R = usage.cache_read;
  const W = usage.cache_w5m + usage.cache_w1h;
  const P = R + W;
  const S = Math.round(P * Math.min(1, Math.max(0, zahl(sockelAnteil))));
  const basis = usage.input * preis.input + usage.output * preis.output;
  const kurz = abstandSek === null || abstandSek === undefined || abstandSek <= FUENF_MIN;
  const neu = kurz || vorigesPraefix === null || vorigesPraefix === undefined
    ? W
    : Math.min(P, Math.max(0, P - vorigesPraefix));
  const alt = P - neu;
  const maxIdleSec = ping.maxIdleMin * 60;
  const sockelInNeu = Math.max(0, Math.min(S, P) - alt);

  const heute = kurz ? alt * preis.read + neu * preis.w5m : P * preis.w5m;

  const ttl1h = kurz || abstandSek <= EINE_STUNDE
    ? alt * preis.read + neu * preis.w1h
    : P * preis.w1h;

  // Pings lesen das Praefix der vorigen Anfrage ("alt"), auch schon unter 5 min Abstand,
  // sobald das Intervall ueberschritten ist. Jenseits von maxIdle stirbt der Eintrag trotzdem.
  const pings = pingAnzahl(abstandSek, ping);
  const pingKosten = kurz || abstandSek <= maxIdleSec
    ? alt * preis.read * (1 + pings) + neu * preis.w5m
    : pings * alt * preis.read + P * preis.w5m;

  let sockel1h;
  if (kurz) {
    sockel1h = alt * preis.read + sockelInNeu * preis.w1h + (neu - sockelInNeu) * preis.w5m;
  } else if (abstandSek <= EINE_STUNDE) {
    const sockelGelesen = Math.min(S, alt);
    sockel1h = sockelGelesen * preis.read + sockelInNeu * preis.w1h + (P - sockelGelesen - sockelInNeu) * preis.w5m;
  } else {
    sockel1h = S * preis.w1h + (P - S) * preis.w5m;
  }

  const dollar = (x) => rund((basis + x) / 1e6);
  return { ttl1h: dollar(ttl1h), ping: dollar(pingKosten), sockel1h: dollar(sockel1h), heute: dollar(heute) };
}

function laenge(wert) {
  return wert === undefined ? 0 : JSON.stringify(wert).length;
}

// Kennungen einer Anfrage: Session-Hash, Schluessel (Session + Hash ueber den Cache-Kopf),
// System-Hash und geschaetzter Sockelanteil. Die Session-ID selbst wird nicht zurueckgegeben.
export function kennungen(body) {
  const userId = body?.metadata?.user_id;
  const hatSession = typeof userId === 'string' && userId.length > 0;
  const kopf = JSON.stringify({
    model: body?.model, system: body?.system, tools: body?.tools, thinking: body?.thinking, output_config: body?.output_config,
    tool_choice: body?.tool_choice,
  });
  const kopfHash = crypto.createHash('sha256').update(kopf).digest('hex');
  const sockel = laenge(body?.tools) + laenge(body?.system);
  const gesamt = sockel + laenge(body?.messages);
  return {
    session: hatSession ? sha12(userId) : null,
    schluessel: sha12(`${hatSession ? userId : ''}\n${kopfHash}`),
    systemHash: sha12(JSON.stringify(body?.system ?? null)),
    sockelAnteil: gesamt > 0 ? sockel / gesamt : 0,
    sockelLaenge: sockel,
  };
}

function haltezeitSek(modus) {
  return modus === 'ttl1h' ? EINE_STUNDE : FUENF_MIN;
}

function warnungenFuer({ marken, folgeanfrage, abstandSek, modus, usage, sessionWechsel }) {
  const liste = [];
  if (marken !== 3) liste.push(`marken:${marken}`);
  const geschrieben = usage.cache_w5m + usage.cache_w1h;
  const gesamt = usage.input + usage.cache_read + geschrieben;
  if (folgeanfrage && abstandSek <= haltezeitSek(modus) && gesamt > 0 && geschrieben >= PRAEFIX_SCHWELLE * gesamt) {
    liste.push('praefix-gebrochen');
  }
  if (sessionWechsel) liste.push('session-wechsel');
  return liste;
}

// Warnt nur, wenn bei gleichem System-Prompt eine neue Session auftaucht, in den letzten
// 10 min genau eine andere aktiv war und diese seit mindestens 60 s geschwiegen hat.
// Zwei parallel arbeitende Sitzungen im selben Ordner erzeugen so kein Rauschen.
// Rein: liefert die bereinigte, fortgeschriebene Session-Tabelle zurueck.
function pruefeSessionWechsel(bisher, session, startMs) {
  const fenster = Object.entries(bisher ?? {}).filter(([, ms]) => (startMs - ms) / 1000 <= SESSION_WECHSEL_FENSTER);
  if (!session) return { wechsel: false, sessions: Object.fromEntries(fenster) };
  const andere = fenster.filter(([s]) => s !== session);
  const istNeu = andere.length === fenster.length;
  const wechsel = istNeu && andere.length === 1 && (startMs - andere[0][1]) / 1000 >= SESSION_RUHE_SEK;
  return { wechsel, sessions: { ...Object.fromEntries(fenster), [session]: startMs } };
}

function standardFehlerMelder(fehler) {
  process.stderr.write(`[vermittler] Protokoll nicht schreibbar (${fehler?.code ?? 'unbekannt'})\n`);
}

export function erzeugeProtokoll({ logPfad, konfig, jetzt = Date.now, meldeFehler = standardFehlerMelder }) {
  const schluesselZustand = new Map(); // schluessel -> { startMs, praefix }
  const systemZustand = new Map(); // systemHash -> { [session]: letzteAnfrageMs } der letzten 10 min

  function schreibe(eintrag) {
    try {
      fs.mkdirSync(path.dirname(logPfad), { recursive: true });
      fs.appendFileSync(logPfad, `${JSON.stringify(eintrag)}\n`);
    } catch (fehler) {
      meldeFehler(fehler);
    }
    return eintrag;
  }

  // Zustand ohne Aktivitaet seit INAKTIV_MS wird bei jedem beginn verworfen.
  function raeumeAuf(ms) {
    for (const [k, z] of schluesselZustand) if (ms - z.startMs > INAKTIV_MS) schluesselZustand.delete(k);
    for (const [k, sessions] of systemZustand) {
      if (Object.values(sessions).every((t) => ms - t > INAKTIV_MS)) systemZustand.delete(k);
    }
  }

  function beginn({ session, schluessel, systemHash, sockelAnteil, modell, modus, marken }) {
    const startMs = jetzt();
    raeumeAuf(startMs);
    const vorher = schluesselZustand.get(schluessel);
    const abstandSek = vorher ? Math.round((startMs - vorher.startMs) / 1000) : null;
    schluesselZustand.set(schluessel, { startMs, praefix: vorher?.praefix ?? null });

    const { wechsel: sessionWechsel, sessions } = pruefeSessionWechsel(systemZustand.get(systemHash), session, startMs);
    if (session) systemZustand.set(systemHash, sessions);

    return Object.freeze({
      startMs, session, schluessel, sockelAnteil, modell, modus, marken,
      abstandSek, vorigesPraefix: vorher?.praefix ?? null, folgeanfrage: Boolean(vorher), sessionWechsel,
    });
  }

  function ende(h, { status, usage: rohUsage, abbruch = false }) {
    const usage = normalisiereUsage(rohUsage ?? {});
    const preis = preisFuer(konfig.preise, h.modell);
    const praefix = usage.cache_read + usage.cache_w5m + usage.cache_w1h;
    const zustand = schluesselZustand.get(h.schluessel);
    const erfolgreich = status >= 200 && status < 300 && !abbruch;
    if (erfolgreich && zustand && zustand.startMs === h.startMs) schluesselZustand.set(h.schluessel, { ...zustand, praefix });
    const warnung = warnungenFuer({ ...h, usage });
    const eintrag = {
      ts: new Date(h.startMs).toISOString(),
      session: h.session,
      schluessel: h.schluessel,
      modell: typeof h.modell === 'string' ? h.modell : null,
      modus: h.modus,
      art: 'anfrage',
      status,
      input: usage.input,
      cache_read: usage.cache_read,
      cache_w5m: usage.cache_w5m,
      cache_w1h: usage.cache_w1h,
      output: usage.output,
      sekundenSeitLetzter: h.abstandSek,
      kosten: kostenAus(usage, preis),
      gegenrechnung: gegenrechnung({
        usage, preis, abstandSek: h.abstandSek, vorigesPraefix: h.vorigesPraefix, sockelAnteil: h.sockelAnteil, ping: konfig.ping,
      }),
      ...(abbruch ? { abbruch: true } : {}),
      ...(warnung.length > 0 ? { warnung } : {}),
    };
    return schreibe(eintrag);
  }

  // Ein Ping beruehrt den Schluesselzustand der Gegenrechnung nicht. sekundenSeitLetzter ist
  // hier der Abstand zum Start der letzten echten Anfrage.
  function ping({ session, schluessel, modell, status, usage, startMs, fehler }) {
    const ms = jetzt();
    return schreibe({
      ts: new Date(ms).toISOString(),
      session: session ?? null,
      schluessel,
      modell: typeof modell === 'string' ? modell : null,
      modus: 'ping',
      art: 'ping',
      status,
      input: usage.input,
      cache_read: usage.cache_read,
      cache_w5m: usage.cache_w5m,
      cache_w1h: usage.cache_w1h,
      output: usage.output,
      sekundenSeitLetzter: Number.isFinite(startMs) ? Math.round((ms - startMs) / 1000) : null,
      kosten: status === null ? null : kostenAus(usage, preisFuer(konfig.preise, modell)),
      gegenrechnung: null,
      ...(typeof fehler === 'string' ? { fehler } : {}),
    });
  }

  function durchgang({ pfad, status }) {
    const nurPfad = typeof pfad === 'string' ? pfad.split('?')[0] : null;
    return schreibe({ ts: new Date(jetzt()).toISOString(), art: 'durchgang', pfad: nurPfad, status });
  }

  return Object.freeze({ beginn, ende, ping, durchgang });
}

// ---------- Auswertung ----------

export function leseProtokoll(pfad) {
  let inhalt;
  try {
    inhalt = fs.readFileSync(pfad, 'utf8');
  } catch {
    return [];
  }
  return inhalt.split('\n').flatMap((zeile) => {
    if (zeile.trim() === '') return [];
    try {
      return [JSON.parse(zeile)];
    } catch {
      return [];
    }
  });
}

const VARIANTEN = Object.freeze(['ttl1h', 'ping', 'sockel1h', 'heute']);

function leereGruppe(modell, modus) {
  return { modell, modus, anfragen: 0, pings: 0, kosten: 0, gegenrechnung: { ttl1h: 0, ping: 0, sockel1h: 0, heute: 0 }, warnungen: 0, ohnePreis: 0 };
}

function addiere(gruppe, z) {
  const gr = z.gegenrechnung;
  return {
    ...gruppe,
    anfragen: gruppe.anfragen + (z.art === 'anfrage' ? 1 : 0),
    pings: gruppe.pings + (z.art === 'ping' ? 1 : 0),
    kosten: rund(gruppe.kosten + zahl(z.kosten)),
    gegenrechnung: gr
      ? Object.fromEntries(VARIANTEN.map((v) => [v, rund(gruppe.gegenrechnung[v] + zahl(gr[v]))]))
      : gruppe.gegenrechnung,
    warnungen: gruppe.warnungen + (Array.isArray(z.warnung) && z.warnung.length > 0 ? 1 : 0),
    ohnePreis: gruppe.ohnePreis + (z.kosten === null || z.kosten === undefined ? 1 : 0),
  };
}

function ersparnis(gruppe) {
  const basis = gruppe.gegenrechnung.ttl1h;
  return Object.fromEntries(VARIANTEN.map((v) => [v, basis > 0
    ? Math.round(((basis - gruppe.gegenrechnung[v]) / basis) * 1000) / 10
    : null]));
}

export function werteAus(zeilen, { seitMs }) {
  const imFenster = zeilen.filter((z) => Date.parse(z.ts) >= seitMs);
  const anfragen = imFenster.filter((z) => z.art === 'anfrage' || z.art === 'ping');
  const gruppenMap = anfragen.reduce((acc, z) => {
    const k = `${z.modell}|${z.modus}`;
    return new Map(acc).set(k, addiere(acc.get(k) ?? leereGruppe(z.modell, z.modus), z));
  }, new Map());
  const gruppen = [...gruppenMap.values()].map((g) => ({ ...g, ersparnisGegenTtl1h: ersparnis(g) }));
  return { seit: new Date(seitMs).toISOString(), gruppen, durchgaenge: imFenster.filter((z) => z.art === 'durchgang').length };
}

function dollarText(x) {
  return `$${x.toFixed(4)}`;
}

function prozentText(x) {
  return x === null ? '-' : `${x.toFixed(1)} %`;
}

export function formatiereBericht(auswertung) {
  const zeilen = [`Bericht seit ${auswertung.seit}`, ''];
  if (auswertung.gruppen.length === 0) zeilen.push('Keine Anfragen im Zeitraum.');
  for (const g of auswertung.gruppen) {
    zeilen.push(`${g.modell ?? '(ohne Modell)'} | Modus ${g.modus}`);
    zeilen.push(`  Anfragen ${g.anfragen}, Pings ${g.pings}, Warnungen ${g.warnungen}${g.ohnePreis > 0 ? `, ohne Preis ${g.ohnePreis}` : ''}`);
    zeilen.push(`  Echte Kosten ${dollarText(g.kosten)}`);
    for (const v of VARIANTEN) {
      zeilen.push(`  ${v.padEnd(9)} ${dollarText(g.gegenrechnung[v]).padStart(10)}   Ersparnis gegen ttl1h ${prozentText(g.ersparnisGegenTtl1h[v])}`);
    }
    zeilen.push('');
  }
  zeilen.push(`Durchgaenge (ohne Kostenrechnung): ${auswertung.durchgaenge}`);
  return zeilen.join('\n');
}
