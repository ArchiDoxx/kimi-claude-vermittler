# Anthropic-Vermittler für Kimi Code CLI

Lokaler HTTP-Proxy auf `127.0.0.1:37790` zwischen Kimi Code CLI und `api.anthropic.com`.
Er sieht nur Claude-Verkehr (Provider `anthropic`); Kimi- und GLM-Modelle laufen direkt.

## Schnellstart auf einem neuen PC

Repo nach `~/.kimi-code/tools/anthropic-vermittler` klonen, Kimi einmal gestartet haben, dann:

```
npm test
node setup/setup.mjs pruefen
node setup/setup.mjs einrichten
```

Einzelheiten, Key-Regeln und Rückweg (`node setup/setup.mjs rueckweg`) stehen in
[CLAUDE.md](CLAUDE.md). Die Handanleitung unten bleibt gültig.

Stand: Stufe 1 und Stufe 2, Version 0.6.0 (angepasst an Kimi Code CLI 2.3.0).

- **T1 Haltezeit:** setzt `ttl: "1h"` auf Kimis `cache_control`-Marken (Modus `ttl1h`, Standard).
  Weitere Modi: `sockel1h` (nur Tools und System 1 h), `ping` (siehe unten), `aus`.
  Modus je Modell über `modeByModel` (Präfix-Treffer, längster gewinnt).
- **Ping-Planer (Modus `ping`, Stufe 2):** Kimis 5-min-Marken bleiben. Für jeden Schlüssel
  (Session plus Hash über Modell, System, Tools, Thinking, `output_config`, `tool_choice`) sendet der
  Vermittler alle `intervalSec` nach dem Start der letzten echten Anfrage den zuletzt gesendeten
  Body mit `max_tokens: 0` und `stream: false` und denselben Kopfzeilen. Voraussetzung: Die
  Antwort der echten Anfrage hat mit 2xx begonnen und ihr erstes Byte ist da. Ende nach
  `maxIdleMin`, bei `SessionEnd`, wenn der Kimi-Prozess der Session nicht mehr läuft, und nach
  dem ersten gescheiterten Ping. **Lebenszeichen (ab 0.5.0):** Kimi legt je laufender Session
  `~/.kimi-code/locks/sessions/<session-id>.lock` mit `pid` an; die Session-ID steht in jeder
  Anfrage als `metadata.user_id`. Der Vermittler prüft bei jedem Takt, ob dieser Prozess lebt.
  Ein Hook ist dafür nicht nötig. Ist das Lebenszeichen unbekannt (keine Lockdatei, anderes
  Format, anderer Rechner), gilt die alte Gnadenfrist: Ende, wenn länger als `heartbeatGraceSec`
  kein Heartbeat kam bzw., ohne je einen, seit dem Start der letzten echten Anfrage.
  `SubagentStop` verwirft die Nebenschlüssel (Hauptschlüssel ist der mit dem größten Sockel aus
  Tools und System). Pings ohne Session-ID gibt es nicht. Kein Ping bei `thinking.type: "enabled"`,
  `output_config.format` oder `tool_choice` `any`/`tool`. Jeder Ping steht als `art: "ping"`
  im Protokoll; `health` zeigt `pingSchluessel`.
- **T2 Schema-Glättung:** Tool-Schemas mit `oneOf`/`anyOf`/`allOf` auf oberster Ebene werden
  zu einem Objekt mit allen Feldern aller Zweige; die Bedingung steht in `description`.
- **T3 Denkbudget (ab 0.5.0):** Kimi 2.3.0 schickt für Budget-Modelle (Claude bis 4.5) bei
  `effort` `max`/`xhigh` `thinking: {type: "enabled"}` ohne `budget_tokens`; die API antwortet mit
  400. Der Vermittler ergänzt das Budget nach Kimis Staffel (low 1024, medium 4096, sonst 32000,
  höchstens `max_tokens` − 1) und entfernt `output_config.effort`. Reicht `max_tokens` nicht für
  1024, schaltet er Thinking ab.
- **T4 Thinking-Bindung (ab 0.6.0):** Die API bindet jeden signierten Thinking-Block an den
  Gesprächsanfang samt Tool-Liste. Kimi schreibt die Secondary-Modell-Liste in die Beschreibung der
  Tools `Agent` und `AgentSwarm` und aktualisiert sie in laufenden Sessions, sobald sich
  `config.toml` ändert (etwa per `/secondary-model`); danach antwortet die API jeder Anfrage dieser
  Sessions mit 400 („Invalid `signature` in `thinking` block … The `tools` list differs“). Der
  Vermittler hält genau diesen 400er zurück und wiederholt die Anfrage einmal mit
  `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` und dem Beta-Wert
  `thinking-binding-controls-2026-08-01` in `anthropic-beta`; die API verwirft dann die nicht mehr
  passenden alten Blöcke. Die Session wird gemerkt und bis `SessionEnd` gleich so gesendet.
  Andere Anfragen und andere Fehler gehen unverändert durch; ohne `thinking`-Objekt im Body gibt
  es keine Wiederholung.
- **Kostenprotokoll** `protokoll.jsonl` mit Gegenrechnung der Varianten `ttl1h`, `ping`,
  `sockel1h`, `heute`, ohne Inhalte, Prompts oder Schlüssel.
- **Hook-Endpunkte** unter `/_vermittler/` (`health`, `session-ende`, `heartbeat`,
  `subagent-ende`); sie führen den Sitzungszustand und steuern den Ping-Planer. `heartbeat`
  bleibt für alte Einrichtungen erreichbar, eingerichtet wird der Hook nicht mehr (siehe unten).

Bauplan: `2026-10-11 Bauplan Anthropic-Vermittler.md` in diesem Ordner.

## Voraussetzungen

Node.js ab 20.11 (wegen `import.meta.dirname`), keine npm-Abhängigkeiten, kein `npm install`.

## Einrichtung

1. Test laufen lassen:

   ```
   cd C:/Users/luceb/.kimi-code/tools/anthropic-vermittler
   node --test "test/*.test.mjs"
   ```

2. In `C:\Users\luceb\.kimi-code\config.toml` unter dem vorhandenen Block
   `[providers.anthropic]` diese Zeile ergänzen (die übrigen Zeilen des Blocks bleiben):

   ```toml
   base_url = "http://127.0.0.1:37790"
   ```

   Das SDK hängt `/v1/messages` selbst an.

3. Am Ende von `config.toml` die drei Hooks ergänzen. Der Node-Pfad ist auf dieser Maschine mit
   `node -e "console.log(process.execPath)"` belegt (`C:\Program Files\nodejs\node.exe`, 2026-10-11);
   auf einer anderen Maschine dort den eigenen Wert eintragen.

   ```toml
   [[hooks]]
   event = "SessionStart"
   command = "\"C:/Program Files/nodejs/node.exe\" \"C:/Users/luceb/.kimi-code/tools/anthropic-vermittler/hooks/session-start.mjs\""
   timeout = 5

   [[hooks]]
   event = "SessionEnd"
   command = "\"C:/Program Files/nodejs/node.exe\" \"C:/Users/luceb/.kimi-code/tools/anthropic-vermittler/hooks/session-ereignis.mjs\""
   timeout = 5

   [[hooks]]
   event = "SubagentStop"
   command = "\"C:/Program Files/nodejs/node.exe\" \"C:/Users/luceb/.kimi-code/tools/anthropic-vermittler/hooks/session-ereignis.mjs\""
   timeout = 5
   ```

   **Keinen `SessionHeartbeat`-Hook eintragen.** Kimi Code CLI 2.3.0 führt das Ereignis zwar aus,
   lehnt es aber beim Schreiben der `config.toml` ab (`config.invalid`): `kimi login`, Provider- und
   Modellwechsel scheitern dann. Ein vorhandener Eintrag des Vermittlers muss weg;
   `node setup/setup.mjs einrichten` entfernt ihn, `pruefen` meldet ihn als `Altlast`.

   Der Start-Hook startet den Vermittler bei Bedarf losgelöst und wartet bis 2 s auf den Port.
   Meldet ein laufender eigener Dienst eine andere Version als der Code auf der Platte, stößt der
   Hook ein losgelöstes `vermittler.mjs start` an, das den alten Dienst sauber beendet und neu
   startet, und kehrt sofort zurück (der Hook-Timeout von 5 s würde ein Warten abschneiden).
   Ein Kimi-Start nach einem Code-Update lädt so den neuen Stand; während der Erneuerung (bis etwa
   6 s, bei einem Altstand ohne Stopp-Endpunkt bis etwa 12 s) können Claude-Anfragen kurz scheitern.
   `node vermittler.mjs start` erneuert synchron (Ergebnis `erneuert`).
   Die Hooks schreiben nichts auf stdout und enden immer mit Exit 0.

4. `kimi` wie gewohnt starten. Prüfen: `node vermittler.mjs status`.

## Betrieb

Alle Befehle im Ordner des Vermittlers; optional `--konfig <pfad>` für eine andere Konfiguration.

| Befehl | Wirkung |
|---|---|
| `node vermittler.mjs start` | startet losgelöst, falls nicht schon aktiv |
| `node vermittler.mjs stop` | beendet den Dienst sauber über `POST /_vermittler/stop` mit seiner PID im Body (5 s Gnadenfrist; neue Anfragen bekommen in der Zeit 503 `overloaded_error`). „gestoppt“ heißt Prozess weg: Ist der Port zu, wartet `stop` bis 8 s auf das Prozessende. Erst danach, oder wenn der Dienst nach 6 s noch antwortet, `process.kill`, und nur wenn die PID aus `health` mit `vermittler.pid` übereinstimmt. Vor jedem Kill prüft `stop`, dass hinter der PID ein Node-Prozess steht (`tasklist` bzw. `ps`) und es nicht der eigene Aufruf ist; sonst wird nichts beendet und `vermittler.pid` als veraltet entfernt (`pid-fremd`, „PID-Datei veraltet, nichts beendet“). Eine hängende Instanz (nimmt an, antwortet nicht) bekommt erst 5 s Zeit, wieder zu antworten, und wird dann regulär gestoppt; schweigt sie weiter, wird sie nur mit passender `vermittler.pid` beendet (`besetzt-getoetet`). Bei einem alten Stand ohne Stopp-Endpunkt nennt `stop` den Handgriff |
| `node vermittler.mjs restart` | nach Änderung an Konfiguration oder Code (geschieht beim nächsten Kimi-Start auch von selbst, siehe unten) |
| `node vermittler.mjs status` | zeigt `health`, Port, Upstream, Protokollpfad; `health.konto` nennt Organisation und Workspace, in denen die letzte Antwort verbucht wurde (siehe „Kosten in der Claude Console“) |
| `node vermittler.mjs bericht [--tage 7]` | Kosten je Modell und Modus, Gegenrechnung, Ersparnis gegen `ttl1h`, Warnungen. Abgebrochene Pings zählen mit (ohne Kosten, `status: null`) |

Befehl und Flags werden vor dem Laden der Konfiguration geprüft: Ein Flag ohne Wert, ein
unbekanntes Argument oder ein `--tage`-Wert, der keine endliche Zahl über 0 ist, ergibt Exit 2.

Konfiguration `vermittler.json`:

| Feld | Bedeutung |
|---|---|
| `port` | Port auf `127.0.0.1`, 1–65535 (Standard 37790) |
| `upstream` | Ziel, Standard `https://api.anthropic.com`; `http:` nur für Loopback-Hosts |
| `mode` | `ttl1h` \| `sockel1h` \| `ping` \| `aus` |
| `modeByModel` | Modus je Modell-ID-Präfix |
| `ping` | ganze Zahlen: `intervalSec` 30–285 (der Ping kann bis zu einem Takt von 5 s später kommen und muss trotzdem vor Ablauf des 5-min-Eintrags liegen), `maxIdleMin` 1–1440, `heartbeatGraceSec` 30–3600 (Gnadenfrist des Ping-Planers, nur wenn das Lebenszeichen der Kimi-Session unbekannt ist). In der Gegenrechnung gezählt werden Pings bei k·`intervalSec` strikt vor der nächsten Anfrage, höchstens bis `maxIdleMin` |
| `logPath` | Protokolldatei; relativ zur Konfigdatei (Standard `./protokoll.jsonl`), `~` wird aufgelöst |
| `preise` | Listenpreise je Million Tokens: `input`, `w5m`, `w1h`, `read`, `output` (Zahlen ab 0), je Modell-ID-Präfix (längster gewinnt). Ausgeliefert für alle Modelle aus `setup/modelle.toml` (Stand Anthropic-Preisliste 2026-10-23; Haiku 5.5 mit dem Preis bis 100.000 Tokens) |
| `kimiHome` | optional, Kimi-Verzeichnis für das Lebenszeichen (Lockdateien); Standard `KIMI_CODE_HOME`, sonst `~/.kimi-code`. `health` zeigt den verwendeten Wert |

Unbekannte Schlüssel auf oberster Ebene erzeugen eine Warnung auf stderr, brechen aber nicht ab.
`upstream` darf nur Schema, Host und Port enthalten. Eine UTF-8-BOM vor dem JSON wird vertragen;
bei kaputtem JSON nennt die Meldung nur die Position.

Dateien neben `vermittler.json` (alle in `.gitignore`):

| Datei | Inhalt |
|---|---|
| `protokoll.jsonl` | Kostenprotokoll, eine Zeile je Anfrage oder Ping |
| `vermittler.pid` | `{pid, port, version, gestartet}` des laufenden Dienstes; `serve` schreibt sie nach dem Start und löscht sie beim sauberen Ende. `stop` tötet nur, wenn sie zur PID aus `health` passt |
| `vermittler.log` | stderr des losgelöst gestarteten Dienstes (angehängt; vor jedem Start auf das letzte 1 MB gekürzt) |

**Automatische Erneuerung:** `health` meldet `version` und `konfigHash`, einen Fingerabdruck der
normalisierten Konfiguration. Weicht eines von beidem vom Stand auf der Platte ab, erneuert der
SessionStart-Hook den Dienst beim nächsten Kimi-Start von selbst; `node vermittler.mjs start` tut
es sofort. Eine Änderung an `vermittler.json` braucht deshalb keinen Handgriff.

Warnungen im Protokoll (Feld `warnung`):

- `marken:N` – Kimi setzt nicht mehr genau drei Cache-Marken (Kimi-Update?).
- `praefix-gebrochen` – Folgeanfrage innerhalb der Haltezeit schreibt mindestens 90 % neu.
- `session-wechsel` – bei gleichem System-Prompt taucht eine neue `metadata.user_id` auf, in den
  letzten 10 min war genau eine andere Session aktiv, und diese schweigt seit mindestens 60 s
  (Hinweis auf eine instabile Session-ID, etwa nach `--resume`). Zwei parallel arbeitende Sitzungen
  im selben Ordner lösen die Warnung nicht aus; eine zweite Sitzung, die startet, während die erste
  seit 60 s ruht, kann sie einmalig auslösen.

Server-Meldungen gehen nur auf stderr und enthalten keine Inhalte. Läuft der Dienst losgelöst,
landen sie in `vermittler.log`; zur Fehlersuche lässt sich `node vermittler.mjs serve` auch im
Vordergrund starten (Strg+C stoppt sauber, ein zweites Strg+C sofort).

## Kosten in der Claude Console

Die Console verbucht Nutzung und Kosten je Organisation und Workspace des API-Keys, den Kimi
mitschickt. Zeigt sie für Kimis Anfragen nichts (kein Cache, keine Kosten), ist meist eine
andere Organisation oder ein anderer Workspace ausgewählt. `node vermittler.mjs status` zeigt
unter `konto` die IDs aus Anthropics Antwortkopfzeilen (`anthropic-organization-id`,
`anthropic-workspace-id`); in der Console diese Organisation wählen und im Nutzungsbericht nach
diesem Workspace bzw. dem API-Key filtern. Unabhängig davon rechnet
`node vermittler.mjs bericht` die Kosten lokal aus den `usage`-Feldern der Antworten.

## Rückweg

1. In `config.toml` die Zeile `base_url` unter `[providers.anthropic]` entfernen.
2. Die `[[hooks]]`-Einträge des Vermittlers entfernen (drei, bei alten Einrichtungen vier).
3. `node vermittler.mjs stop`, dann den Ordner `~/.kimi-code/tools/anthropic-vermittler/` löschen.

Kimi läuft danach wieder direkt mit 5 min Haltezeit.

## Sicherheit

- Lauscht nur auf `127.0.0.1`; Anfragen mit `Origin`-Kopfzeile (Browser) werden mit 403 abgewiesen,
  ebenso jede Anfrage, deren `Host` nicht `127.0.0.1:<port>`, `localhost:<port>` oder `[::1]:<port>`
  ist (DNS-Rebinding).
- Ein Request-Target, das nicht mit genau einem `/` beginnt (`//host/…`, `/\host`, absolute URL),
  ergibt 400; die Ziel-URL entsteht durch Verkettung mit `upstream`, nie durch Auflösung.
- Der API-Schlüssel wird durchgereicht, nie protokolliert und nie in Fehlermeldungen zitiert.
- Anfrage-Inhalte werden nie auf die Platte geschrieben.
- Modus `ping` hält je Schlüssel den letzten Body und die durchgereichten Kopfzeilen samt API-Schlüssel
  im RAM, höchstens `maxIdleMin` lang; Session-Ende, Totmannschalter, Ping-Fehler und Ablauf verwerfen sie.
- Nicht parsbare Bodies gehen bytegleich durch.
