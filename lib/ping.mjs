// Ping-Planer (Stufe 2, Bauplan 8.4). Haelt je Schluessel den Ping-Body (abgeleitet aus den
// tatsaechlich gesendeten Bytes der letzten echten Anfrage) und deren durchgereichte
// Kopfzeilen nur im RAM, hoechstens maxIdleMin lang. Uhr, Timer und Sendeweg sind
// injizierbar, damit Tests ohne Netz und ohne Warten laufen.
import { normalisiereUsage } from './protokoll.mjs';
import { istSichererPfad, zielUrl } from './weiterleitung.mjs';

const PING_TIMEOUT_MS = 60_000;

function parseObjekt(gesendet) {
  try {
    const json = JSON.parse(Buffer.isBuffer(gesendet) ? gesendet.toString('utf8') : String(gesendet));
    return json && typeof json === 'object' && !Array.isArray(json) ? json : null;
  } catch {
    return null;
  }
}

function alsPingBody(json) {
  return Buffer.from(JSON.stringify({ ...json, max_tokens: 0, stream: false }), 'utf8');
}

// Ping-Body: letzter Body mit max_tokens 0 und stream false, sonst unveraendert.
export function pingBody(gesendet) {
  const json = parseObjekt(gesendet);
  return json ? alsPingBody(json) : null;
}

// Grund, warum max_tokens 0 hier abgelehnt wuerde, oder null.
export function pingAusschluss(json) {
  if (json?.thinking?.type === 'enabled') return 'thinking-enabled';
  if (json?.output_config?.format !== undefined && json?.output_config?.format !== null) return 'output-format';
  const wahl = json?.tool_choice?.type;
  if (wahl === 'any' || wahl === 'tool') return 'tool-choice';
  return null;
}

function fehlercode(fehler) {
  return String(fehler?.cause?.code ?? fehler?.code ?? fehler?.name ?? 'unbekannt');
}

export async function standardSende({ ziel, body, kopfzeilen, signal }) {
  const zeitlimit = AbortSignal.timeout(PING_TIMEOUT_MS);
  const antwort = await fetch(ziel, {
    method: 'POST', headers: kopfzeilen, body, redirect: 'manual',
    signal: signal ? AbortSignal.any([signal, zeitlimit]) : zeitlimit,
  });
  const text = await antwort.text();
  let usage = null;
  try {
    usage = JSON.parse(text)?.usage ?? null;
  } catch {
    usage = null;
  }
  return { status: antwort.status, usage };
}

const STANDARD_TIMER = Object.freeze({
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
});

// lebenszeichen(sessionId) -> true | false | null (lib/lebenszeichen.mjs); ohne Angabe immer null.
export function erzeugePingPlaner({
  konfig, sitzungen, protokoll, jetzt = Date.now, sende = standardSende, timer = STANDARD_TIMER, log = () => {},
  lebenszeichen = () => null,
}) {
  const intervallMs = konfig.ping.intervalSec * 1000;
  const maxIdleMs = konfig.ping.maxIdleMin * 60 * 1000;
  const graceMs = (konfig.ping.heartbeatGraceSec ?? 180) * 1000;
  const zustaende = new Map(); // schluessel -> eingefrorener Zustand
  const laufende = new Map(); // schluessel -> { generation, steuerung } des laufenden Pings
  let generation = 0;
  let handle = null;

  // Verwerfen loescht Body und Kopfzeilen und bricht einen laufenden Ping ab.
  function verwerfe(schluessel) {
    brichLaufendenAb(schluessel);
    return zustaende.delete(schluessel);
  }

  // Meldet eine echte Anfrage, deren Antwort erfolgreich begonnen hat. Liefert true, wenn
  // der Schluessel jetzt gepingt wird; sonst wird ein vorhandener Zustand verworfen.
  // Der Ausschluss wird aus dem tatsaechlich gesendeten Body bestimmt; ein mitgegebenes
  // json wird ignoriert. Ohne Session und mit unsicherem Pfad gibt es keinen Ping.
  // Schutzgitter unabhaengig vom Aufrufer: scharf nur fuer POST-Ziele auf /v1/messages.
  function istMessagesPfad(pfad) {
    return istSichererPfad(pfad) && pfad.split('?')[0] === '/v1/messages';
  }

  function brichLaufendenAb(schluessel) {
    const lauf = laufende.get(schluessel);
    if (lauf) {
      laufende.delete(schluessel);
      lauf.steuerung.abort();
    }
  }

  function anfrage({ session, schluessel, modell, modus, pfad, body, kopfzeilen, startMs }) {
    const json = modus === 'ping' && session && istMessagesPfad(pfad) ? parseObjekt(body) : null;
    const ping = json && !pingAusschluss(json) ? alsPingBody(json) : null;
    if (!ping) {
      verwerfe(schluessel);
      return false;
    }
    // Ein noch laufender Ping des alten Zustands ist ueberholt.
    brichLaufendenAb(schluessel);
    generation += 1;
    const kimiSession = typeof json.metadata?.user_id === 'string' ? json.metadata.user_id : null;
    zustaende.set(schluessel, Object.freeze({
      generation, session, kimiSession, schluessel, modell, pfad, body: ping, kopfzeilen,
      startMs, ersteByteMs: null, naechsterPingMs: startMs + intervallMs, laeuft: false,
    }));
    return true;
  }

  // Nur fuer die Anfrage, die den Zustand gesetzt hat (gleicher startMs).
  function ersteByte(schluessel, startMs) {
    const z = zustaende.get(schluessel);
    if (z && z.ersteByteMs === null && z.startMs === startMs) zustaende.set(schluessel, Object.freeze({ ...z, ersteByteMs: jetzt() }));
  }

  function sessionEnde(session) {
    const weg = [...zustaende.values()].filter((z) => z.session === session).map((z) => z.schluessel);
    weg.forEach(verwerfe);
    return weg.length;
  }

  function subagentEnde(session, hauptSchluessel) {
    const weg = [...zustaende.values()]
      .filter((z) => z.session === session && z.schluessel !== hauptSchluessel)
      .map((z) => z.schluessel);
    weg.forEach(verwerfe);
    return weg.length;
  }

  // Zuerst das Lebenszeichen des Kimi-Prozesses (Lockdatei mit PID): laeuft er, lebt die
  // Session; ist er weg, ist sie tot. Nur wenn das unbekannt ist (null), gilt die Gnadenfrist:
  // Referenz ist der letzte Heartbeat, ohne je einen Heartbeat der Start der letzten echten
  // Anfrage. Eine juengere echte Anfrage beweist ebenfalls Leben.
  function totmann(z, ms) {
    let lebt = null;
    try {
      lebt = lebenszeichen(z.kimiSession);
    } catch {
      lebt = null;
    }
    if (lebt === true) return false;
    if (lebt === false) return true;
    const hb = sitzungen.zustand(z.session)?.letzterHeartbeatMs ?? 0;
    return ms - Math.max(hb, z.startMs) > graceMs;
  }

  // Ergebnis eines Pings verbuchen. Ein inzwischen neu gemeldeter Zustand (andere
  // Generation) bleibt unberuehrt.
  function verbuche(z, ergebnis) {
    const ok = ergebnis.status >= 200 && ergebnis.status < 300;
    if (laufende.get(z.schluessel)?.generation === z.generation) laufende.delete(z.schluessel);
    try {
      protokoll.ping({
        session: z.session, schluessel: z.schluessel, modell: z.modell, status: ergebnis.status,
        usage: normalisiereUsage(ergebnis.usage), startMs: z.startMs,
        ...(ergebnis.fehler ? { fehler: ergebnis.fehler } : {}),
      });
    } catch (fehler) {
      log(`Ping-Protokoll nicht schreibbar (${fehler?.code ?? fehler?.name ?? 'unbekannt'})`);
    }
    const aktuell = zustaende.get(z.schluessel);
    if (!aktuell || aktuell.generation !== z.generation) return;
    if (!ok) {
      log(`Ping fehlgeschlagen (${ergebnis.fehler ?? ergebnis.status}), Pings fuer diesen Schluessel beendet`);
      verwerfe(z.schluessel);
      return;
    }
    zustaende.set(z.schluessel, Object.freeze({ ...aktuell, laeuft: false }));
  }

  async function sendePing(z, ms) {
    zustaende.set(z.schluessel, Object.freeze({ ...z, laeuft: true, naechsterPingMs: ms + intervallMs }));
    const steuerung = new AbortController();
    laufende.set(z.schluessel, { generation: z.generation, steuerung });
    let ergebnis;
    try {
      const ziel = zielUrl(konfig.upstream, z.pfad);
      const antwort = await sende({ ziel, body: z.body, kopfzeilen: z.kopfzeilen, signal: steuerung.signal });
      ergebnis = { status: antwort.status, usage: antwort.usage ?? null };
    } catch (fehler) {
      ergebnis = { status: 0, usage: null, fehler: fehlercode(fehler) };
    }
    // Von uns abgebrochen (verworfen oder durch eine neue Anfrage ueberholt): keine Zeile.
    // Von uns abgebrochen (verworfen, ueberholt oder gestoppt): Der Anbieter hat den Ping meist
    // schon berechnet, also protokollieren (status null, kosten null), den Zustand aber nicht anfassen.
    if (steuerung.signal.aborted) {
      if (laufende.get(z.schluessel)?.steuerung === steuerung) laufende.delete(z.schluessel);
      try {
        protokoll.ping({
          session: z.session, schluessel: z.schluessel, modell: z.modell, status: null,
          usage: normalisiereUsage(null), startMs: z.startMs, fehler: 'abgebrochen',
        });
      } catch (fehler) {
        log(`Ping-Protokoll nicht schreibbar (${fehler?.code ?? fehler?.name ?? 'unbekannt'})`);
      }
      return;
    }
    verbuche(z, ergebnis);
  }

  // Ein Durchlauf: faellige Pings senden, abgelaufene Schluessel verwerfen.
  async function pruefe() {
    const ms = jetzt();
    const laeufe = [];
    for (const z of [...zustaende.values()]) {
      if (z.naechsterPingMs - z.startMs > maxIdleMs || ms - z.startMs > maxIdleMs + intervallMs) {
        verwerfe(z.schluessel);
      } else if (totmann(z, ms)) {
        log('Kimi-Session beendet oder Lebenszeichen ausgeblieben, Pings fuer die Session beendet');
        verwerfe(z.schluessel);
      } else if (!z.laeuft && z.ersteByteMs !== null && ms >= z.naechsterPingMs) {
        laeufe.push(sendePing(z, ms));
      }
    }
    await Promise.all(laeufe);
  }

  function starte() {
    if (handle || !timer) return;
    const takt = Math.max(200, Math.min(5000, intervallMs / 4));
    handle = timer.setInterval(() => {
      pruefe().catch(() => log('Ping-Durchlauf fehlgeschlagen'));
    }, takt);
    handle?.unref?.();
  }

  // Haelt den Takt an, bricht laufende Pings ab und verwirft alle Zustaende samt Bodys und Keys.
  function stoppe() {
    if (handle && timer) timer.clearInterval(handle);
    handle = null;
    [...zustaende.keys()].forEach(verwerfe);
    [...laufende.keys()].forEach(brichLaufendenAb);
  }

  function zustand(schluessel) {
    const z = zustaende.get(schluessel);
    if (!z) return null;
    return Object.freeze({
      session: z.session, startMs: z.startMs, ersteByteMs: z.ersteByteMs, naechsterPingMs: z.naechsterPingMs,
      laeuft: z.laeuft, hatBody: Buffer.isBuffer(z.body),
    });
  }

  return Object.freeze({
    anfrage, ersteByte, sessionEnde, subagentEnde, verwerfe, pruefe, starte, stoppe, zustand,
    anzahl: () => zustaende.size,
  });
}
