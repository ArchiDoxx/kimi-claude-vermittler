#!/usr/bin/env node
// Kimi-Hook fuer SessionStart: stellt sicher, dass der Vermittler laeuft.
// Laeuft er, Exit 0. Lauscht niemand, wird er losgeloest gestartet und bis 2 s auf den
// Port gewartet. Belegt ein fremder Dienst den Port, Meldung auf stderr, Exit 0.
// stdout bleibt leer, damit Kimi nichts in den Kontext uebernimmt.
import { ladeKonfig, standardKonfigPfad, stelleSicher } from '../vermittler.mjs';

const WARTEN_MS = 2000;

function konfigPfad(args) {
  const i = args.indexOf('--konfig');
  return i >= 0 && args[i + 1] ? args[i + 1] : standardKonfigPfad();
}

function meldung(text) {
  process.stderr.write(`[anthropic-vermittler] ${text}\n`);
}

async function main() {
  // stdin wird nicht gebraucht; es wird nur abgenommen, damit Kimi nicht blockiert.
  process.stdin.on('error', () => {});
  process.stdin.resume();
  const pfad = konfigPfad(process.argv.slice(2));
  const konfig = ladeKonfig(pfad);
  const { ergebnis } = await stelleSicher(konfig, { konfigPfad: pfad, wartenMs: WARTEN_MS, erneuernLosgeloest: true, melde: meldung });
  const texte = {
    fremd: `Port ${konfig.port} ist von einem fremden Dienst belegt; Claude-Anfragen werden scheitern.`,
    besetzt: `Port ${konfig.port} nimmt Verbindungen an, antwortet aber nicht.`,
    'spawn-fehler': 'Vermittler-Prozess liess sich nicht starten.',
    'stopp-fehler': 'Alte Vermittler-Version liess sich nicht beenden.',
    zeitueberschreitung: `Vermittler antwortet nach ${WARTEN_MS} ms noch nicht auf Port ${konfig.port}.`,
  };
  if (Object.hasOwn(texte, ergebnis)) meldung(texte[ergebnis]);
}

main()
  .catch((fehler) => meldung(`Start nicht moeglich (${fehler?.code ?? fehler?.name ?? 'unbekannt'}).`))
  .finally(() => process.exit(0));
