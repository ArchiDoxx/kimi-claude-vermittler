// Proxy-Mechanik nach Bauplan 8.2 Schritt 4 bis 7: Kopfzeilen filtern, Body weiterreichen,
// Antwort unveraendert streamen und dabei usage mitlesen. Fehlermeldungen zitieren nie
// Kopfzeilen oder Body-Inhalte.
import { verschmelzeUsage } from './protokoll.mjs';

const DURCHGEREICHT = Object.freeze(new Set([
  'x-api-key', 'authorization', 'content-type', 'accept', 'user-agent',
]));
const DURCHGEREICHT_PRAEFIXE = Object.freeze(['x-stainless-', 'anthropic-']);

// Ausdrueckliche Sperrliste; greift auch, falls die Allowlist einmal erweitert wird.
const GESPERRT = Object.freeze(new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'accept-encoding',
  'upgrade', 'te', 'trailer', 'proxy-authenticate',
]));
const GESPERRT_PRAEFIX = 'proxy-';

const ANTWORT_ENTFERNT = Object.freeze(new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'upgrade', 'te', 'trailer', 'proxy-authenticate',
]));

const MAX_JSON_ANTWORT = 16 * 1024 * 1024;

export function anfrageKopfzeilen(eingehend) {
  const erlaubt = Object.entries(eingehend ?? {}).filter(([name]) => {
    const n = name.toLowerCase();
    if (GESPERRT.has(n) || n.startsWith(GESPERRT_PRAEFIX)) return false;
    return DURCHGEREICHT.has(n) || DURCHGEREICHT_PRAEFIXE.some((p) => n.startsWith(p));
  });
  const gefiltert = Object.fromEntries(erlaubt.map(([name, wert]) => [
    name.toLowerCase(),
    Array.isArray(wert) ? wert.join(', ') : String(wert),
  ]));
  return { ...gefiltert, 'accept-encoding': 'identity' };
}

export function antwortKopfzeilen(headers) {
  const eintraege = [];
  headers.forEach((wert, name) => {
    if (name === 'set-cookie' || ANTWORT_ENTFERNT.has(name)) return;
    eintraege.push([name, wert]);
  });
  const cookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  return cookies.length > 0
    ? { ...Object.fromEntries(eintraege), 'set-cookie': cookies }
    : Object.fromEntries(eintraege);
}

export function fehlerKoerper(nachricht, typ = 'api_error') {
  return JSON.stringify({ type: 'error', error: { type: typ, message: nachricht } });
}

export function sendeFehler(res, status, nachricht, typ = 'api_error') {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const text = fehlerKoerper(nachricht, typ);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

// Liest SSE zeilenweise und fuehrt usage aus message_start und message_delta zusammen.
// Haelt nur die angefangene letzte Zeile im Speicher.
export function erzeugeSseLeser() {
  let rest = '';
  let usage = null;

  function zeile(z) {
    const text = z.endsWith('\r') ? z.slice(0, -1) : z;
    if (!text.startsWith('data:')) return;
    const daten = text.slice(5).trimStart();
    if (!daten.includes('"message_start"') && !daten.includes('"message_delta"')) return;
    try {
      const ereignis = JSON.parse(daten);
      if (ereignis.type === 'message_start') usage = verschmelzeUsage(usage, ereignis.message?.usage);
      else if (ereignis.type === 'message_delta') usage = verschmelzeUsage(usage, ereignis.usage);
    } catch {
      // kaputte Zeile: ignorieren, der Strom geht unveraendert durch
    }
  }

  function fuettere(text) {
    const teile = (rest + text).split('\n');
    rest = teile.pop();
    teile.forEach(zeile);
  }

  function schliesse() {
    if (rest.length > 0) zeile(rest);
    rest = '';
  }

  return Object.freeze({ fuettere, schliesse, usage: () => usage });
}


// Request-Target muss mit genau einem "/" beginnen; "//host", "/\host" und absolute URLs
// koennten sonst den Upstream-Host ueberschreiben.
// Punkt-Segmente ("/./", "/../", auch am Ende) im Pfadteil werden ebenfalls abgelehnt.
export function istSichererPfad(pfad) {
  if (typeof pfad !== 'string' || !/^\/(?![/\\])/.test(pfad)) return false;
  const segmente = pfad.split('?')[0].split('/');
  return !segmente.some((s) => s === '.' || s === '..');
}

// Ziel-URL per Verkettung, nie per Aufloesung gegen den Upstream.
export function zielUrl(upstream, pfad) {
  return `${upstream.replace(/\/+$/, '')}${pfad}`;
}

function clientWegFehler() {
  return Object.assign(new Error('Client nicht mehr verbunden'), { code: 'CLIENT_WEG' });
}

// Schreibt ein Stueck; verwirft mit CLIENT_WEG, wenn der Client weg ist oder geht,
// statt auf ein drain zu warten, das nie mehr kommt.
export function schreibe(res, teil) {
  if (res.destroyed) return Promise.reject(clientWegFehler());
  if (res.write(teil)) return Promise.resolve();
  if (res.destroyed) return Promise.reject(clientWegFehler());
  return new Promise((resolve, reject) => {
    const aufraeumen = () => {
      res.off('drain', weiter);
      res.off('close', weg);
      res.off('error', weg);
    };
    const weiter = () => { aufraeumen(); resolve(); };
    const weg = () => { aufraeumen(); reject(clientWegFehler()); };
    res.on('drain', weiter);
    res.on('close', weg);
    res.on('error', weg);
  });
}

function fehlercode(fehler) {
  return fehler?.cause?.code ?? fehler?.code ?? fehler?.name ?? 'unbekannt';
}

// Beobachter duerfen die Anfrage nie beenden: Fehler werden nur gemeldet.
function rufe(funktion, wert, log, ...weitere) {
  if (typeof funktion !== 'function') return;
  try {
    funktion(wert, ...weitere);
  } catch (fehler) {
    log(`Beobachter-Fehler (${fehler?.code ?? fehler?.name ?? 'unbekannt'})`);
  }
}

const ABBRUCH = (code, status, usage) => ({ status, usage, abbruch: true, fehlercode: code });

// Leitet eine Anfrage weiter und streamt die Antwort. Liefert
// { status, usage (roh oder null), abbruch, fehlercode }.
// beobachter.kopf(status, kopfzeilen) wird gerufen, sobald die Upstream-Kopfzeilen da sind;
// beobachter.ersteByte() beim ersten Antwort-Byte.
export async function leiteWeiter({
  req, res, upstream, body, liestUsage = false, beobachter = {}, log = () => {}, maxJson = MAX_JSON_ANTWORT,
}) {
  if (!istSichererPfad(req.url)) {
    sendeFehler(res, 400, 'Vermittler: ungueltiges Request-Target', 'invalid_request_error');
    return { status: 400, usage: null, abbruch: false, fehlercode: 'PFAD' };
  }
  if (res.destroyed) {
    log('Client schon vor der Weiterleitung gegangen (CLIENT_WEG)');
    return ABBRUCH('CLIENT_WEG', 0, null);
  }
  const steuerung = new AbortController();
  let clientWeg = false;
  res.on('close', () => {
    if (!res.writableFinished) {
      clientWeg = true;
      steuerung.abort();
    }
  });

  let antwort;
  try {
    antwort = await fetch(zielUrl(upstream, req.url), {
      method: req.method,
      headers: anfrageKopfzeilen(req.headers),
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      redirect: 'manual',
      signal: steuerung.signal,
    });
  } catch (fehler) {
    if (clientWeg || res.destroyed) {
      log('Client vor der Antwort gegangen (CLIENT_WEG)');
      return ABBRUCH('CLIENT_WEG', 0, null);
    }
    const code = fehlercode(fehler);
    log(`Upstream nicht erreichbar (${code})`);
    sendeFehler(res, 502, `Vermittler: Upstream nicht erreichbar (${code})`);
    return { status: 502, usage: null, abbruch: false, fehlercode: code };
  }

  const typ = antwort.headers.get('content-type') ?? '';
  const istSse = liestUsage && typ.includes('text/event-stream');
  const istJson = liestUsage && typ.includes('application/json');
  const sse = istSse ? erzeugeSseLeser() : null;
  const dekodierer = new TextDecoder();
  const jsonTeile = [];
  let jsonGroesse = 0;
  let jsonVoll = false;
  let erstes = true;

  rufe(beobachter.kopf, antwort.status, log, antwort.headers);
  try {
    res.writeHead(antwort.status, antwortKopfzeilen(antwort.headers));
    res.flushHeaders();
  } catch (fehler) {
    // z. B. eine Kopfzeile, die Node nicht schreiben will: Upstream-Body abbrechen, 502 melden.
    await antwort.body?.cancel().catch(() => {});
    const code = fehlercode(fehler);
    log(`Antwortkopf nicht schreibbar (${code})`);
    try {
      sendeFehler(res, 502, 'Vermittler: Antwort des Upstreams nicht weiterreichbar');
    } catch {
      res.destroy();
    }
    return { status: 502, usage: null, abbruch: false, fehlercode: code };
  }

  try {
    if (antwort.body) {
      for await (const teil of antwort.body) {
        if (erstes) {
          erstes = false;
          rufe(beobachter.ersteByte, undefined, log);
        }
        await schreibe(res, teil);
        if (sse) sse.fuettere(dekodierer.decode(teil, { stream: true }));
        // Einmal ueber der Grenze, wird nichts mehr gesammelt: Teilstuecke koennten sonst
        // zufaellig gueltiges JSON ergeben.
        if (istJson && !jsonVoll) {
          if (jsonGroesse + teil.length > maxJson) {
            jsonVoll = true;
            jsonTeile.length = 0;
          } else {
            jsonTeile.push(teil);
            jsonGroesse += teil.length;
          }
        }
      }
    }
    res.end();
  } catch (fehler) {
    const code = clientWeg && fehler?.code !== 'CLIENT_WEG' ? 'CLIENT_WEG' : fehlercode(fehler);
    log(`Strom abgebrochen (${code})`);
    steuerung.abort();
    res.destroy();
    return ABBRUCH(code, antwort.status, sse?.usage() ?? null);
  }

  let usage = null;
  if (sse) {
    sse.fuettere(dekodierer.decode());
    sse.schliesse();
    usage = sse.usage();
  } else if (istJson && !jsonVoll) {
    try {
      usage = JSON.parse(Buffer.concat(jsonTeile).toString('utf8'))?.usage ?? null;
    } catch {
      usage = null;
    }
  }
  return { status: antwort.status, usage, abbruch: false, fehlercode: null };
}
