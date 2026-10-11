// Sitzungszustand fuer die Hook-Endpunkte. Stufe 1 fuehrt nur Zeitpunkte und aktive
// Schluessel; Stufe 2 (lib/ping.mjs) baut darauf auf. Keine Inhalte, keine Kopfzeilen.
//
// Zustand je Session (Session-Hash):
//   hauptSchluessel   Schluessel mit dem groessten Sockel (tools + system), bei Gleichstand
//                     der juengste; eine kleine Nebenanfrage (Titel, Zusammenfassung) vor dem
//                     Hauptagenten macht diesen so nicht zum Subagenten
//   schluessel        { [schluessel]: { startMs, ersteByteMs, sockelLaenge } }
//   letzterHeartbeatMs, letzteAktivitaetMs

const STANDARD_MAX_ALTER_MS = 2 * 60 * 60 * 1000;

function gueltig(session) {
  return typeof session === 'string' && session.length > 0;
}

function leer(ms) {
  return { hauptSchluessel: null, schluessel: {}, letzterHeartbeatMs: null, letzteAktivitaetMs: ms };
}

function friereKopie(z) {
  const schluessel = Object.fromEntries(Object.entries(z.schluessel).map(([k, v]) => [k, Object.freeze({ ...v })]));
  return Object.freeze({ ...z, schluessel: Object.freeze(schluessel) });
}

export function erzeugeSitzungen({ jetzt = Date.now, maxAlterMs = STANDARD_MAX_ALTER_MS } = {}) {
  const sitzungen = new Map();

  function aufraeumen(ms) {
    for (const [session, z] of sitzungen) {
      if (ms - z.letzteAktivitaetMs > maxAlterMs) sitzungen.delete(session);
    }
  }

  function aktualisiere(session, aenderung) {
    const ms = jetzt();
    aufraeumen(ms);
    const alt = sitzungen.get(session) ?? leer(ms);
    sitzungen.set(session, { ...aenderung(alt, ms), letzteAktivitaetMs: ms });
  }

  function anfrage(session, schluessel, sockelLaenge = 0) {
    if (!gueltig(session)) return;
    const laenge = Number.isFinite(sockelLaenge) ? sockelLaenge : 0;
    aktualisiere(session, (z, ms) => {
      const bisher = z.hauptSchluessel === null ? -1 : (z.schluessel[z.hauptSchluessel]?.sockelLaenge ?? -1);
      return {
        ...z,
        hauptSchluessel: laenge >= bisher ? schluessel : z.hauptSchluessel,
        schluessel: { ...z.schluessel, [schluessel]: { startMs: ms, ersteByteMs: null, sockelLaenge: laenge } },
      };
    });
  }

  function ersteByte(session, schluessel) {
    if (!gueltig(session) || !sitzungen.get(session)?.schluessel[schluessel]) return;
    aktualisiere(session, (z, ms) => ({
      ...z,
      schluessel: { ...z.schluessel, [schluessel]: { ...z.schluessel[schluessel], ersteByteMs: ms } },
    }));
  }

  // Nur fuer Sessions, die schon eine Anfrage gestellt haben; Heartbeats legen nichts an.
  function heartbeat(session) {
    if (!gueltig(session) || !sitzungen.has(session)) return false;
    aktualisiere(session, (z, ms) => ({ ...z, letzterHeartbeatMs: ms }));
    return true;
  }

  function sessionEnde(session) {
    return gueltig(session) ? sitzungen.delete(session) : false;
  }

  function subagentEnde(session) {
    const z = gueltig(session) ? sitzungen.get(session) : undefined;
    if (!z) return 0;
    const behalten = Object.entries(z.schluessel).filter(([k]) => k === z.hauptSchluessel);
    const entfernt = Object.keys(z.schluessel).length - behalten.length;
    sitzungen.set(session, { ...z, schluessel: Object.fromEntries(behalten) });
    return entfernt;
  }

  function zustand(session) {
    const z = sitzungen.get(session);
    return z ? friereKopie(z) : null;
  }

  return Object.freeze({ anfrage, ersteByte, heartbeat, sessionEnde, subagentEnde, zustand, anzahl: () => sitzungen.size });
}
