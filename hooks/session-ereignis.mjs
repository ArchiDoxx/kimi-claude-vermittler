#!/usr/bin/env node
// Kimi-Hook fuer SessionEnd und SubagentStop. SessionHeartbeat wird weiter angenommen (alte
// Einrichtungen), aber nicht mehr eingerichtet: Kimi 2.3.0 lehnt das Ereignis in config.toml ab.
// Liest das Hook-JSON von stdin und meldet das Ereignis an den Vermittler.
// Bremst Kimi nie: 2 s Timeout, alle Fehler werden geschluckt, Exit immer 0, stdout bleibt leer.
import { ladeKonfig, standardKonfigPfad } from '../vermittler.mjs';

const ENDPUNKT = Object.freeze({
  SessionEnd: 'session-ende',
  SessionHeartbeat: 'heartbeat',
  SubagentStop: 'subagent-ende',
});

const STDIN_GRENZE = 1024 * 1024;
const STDIN_WARTEN_MS = 5000;
const ANFRAGE_TIMEOUT_MS = 2000;

function leseStdin() {
  return new Promise((resolve) => {
    const teile = [];
    let groesse = 0;
    const fertig = () => resolve(Buffer.concat(teile).toString('utf8'));
    const uhr = setTimeout(fertig, STDIN_WARTEN_MS);
    process.stdin.on('data', (t) => {
      groesse += t.length;
      if (groesse <= STDIN_GRENZE) teile.push(t);
    });
    process.stdin.on('end', () => { clearTimeout(uhr); fertig(); });
    process.stdin.on('error', () => { clearTimeout(uhr); fertig(); });
  });
}

function konfigPfad(args) {
  const i = args.indexOf('--konfig');
  return i >= 0 && args[i + 1] ? args[i + 1] : standardKonfigPfad();
}

async function main() {
  const text = await leseStdin();
  let daten;
  try {
    daten = JSON.parse(text);
  } catch {
    process.stderr.write('[anthropic-vermittler] Hook-Eingabe ist kein gueltiges JSON; Ereignis ignoriert.\n');
    return;
  }
  const name = daten?.hook_event_name;
  const endpunkt = typeof name === 'string' && Object.hasOwn(ENDPUNKT, name) ? ENDPUNKT[name] : undefined;
  const sessionId = daten?.session_id;
  if (!endpunkt || typeof sessionId !== 'string' || sessionId.length === 0) return;
  const konfig = ladeKonfig(konfigPfad(process.argv.slice(2)));
  await fetch(`http://127.0.0.1:${konfig.port}/_vermittler/${endpunkt}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
    signal: AbortSignal.timeout(ANFRAGE_TIMEOUT_MS),
  }).then((r) => r.arrayBuffer());
}

main().catch(() => {}).finally(() => process.exit(0));
