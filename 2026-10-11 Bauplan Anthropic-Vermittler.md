# Bauplan: Anthropic-Vermittler für Kimi Code CLI

| | |
|---|---|
| **Datum** | 2026-10-11 |
| **Fassung** | 2 (Review Deimon 2026-10-11 eingearbeitet: 12 Befunde, 4 Entscheide) |
| **Status** | **Gebaut und live bestanden** (2026-10-11): Stufe 1 (A, T2) und Stufe 2 (Ping). Zwei Reviews (Deimon), 122 Tests. Betrieb: `ttl1h` Standard, Fable 5.1 auf `ping` (§7) |
| **Autor** | Lucas Vöhringer |
| **Geltungsbereich** | Private Maschinen-Werkzeugkette (Kimi Code CLI auf `C:\Users\luceb`), kein OS-/Firmenrepo |

---

## 1. Ziel

Claude-Modelle in Kimi Code CLI sollen sich beim Prompt-Caching **wie in Claude Code** verhalten und dabei **möglichst wenig kosten**.

**Anforderungen des Auftraggebers:**

| # | Anforderung |
|---|---|
| A1 | Ähnlich wie Claude Code: Nach Arbeitspausen bis zu einer Stunde geht es ohne teures Neuschreiben des Caches weiter |
| A2 | Möglichst günstig |
| A3 | `kimi` wird wie gewohnt gestartet, nichts zum Mitdenken |
| A4 | Kimi- und GLM-Modelle bleiben unberührt |

---

## 2. Ausgangslage (belegt)

**Installation:** Kimi Code CLI **2.1.1** (`@moonshot-ai/kimi-code`, npm global). Gebündelter Code: `C:\Users\luceb\AppData\Roaming\npm\node_modules\@moonshot-ai\kimi-code\dist\main.mjs` (unten **M**). Er enthält `@anthropic-ai/sdk@0.95.2`.

**Am 2026-10-11 schon eingerichtet:**

- Plugin `kimi-cu-win` deaktiviert (`~/.kimi-code/plugins/installed.json`). Grund: Seine Tool-Schemas haben `oneOf` auf oberster Ebene, die Anthropic-API antwortet mit 400 `input_schema does not support oneOf, allOf, or anyOf at the top level`.
- `always_thinking` bei Opus 5.5, Sonnet 5.5, Fable 5.1 und Fable 5 ergänzt. Sonst sendet Kimi bei Thinking „aus" `{type:"disabled"}`, das ist auf Opus und Sonnet 5.5 ein 400.
- 44 ECC-Skills nach `~/.kimi-code/_geparkt/ecc-skills-2026-10-11/` verschoben.

**Wie Kimi heute cached** (statische Code-Analyse, Zeilen in M, Stand 2.1.1):

- Drei Breakpoints, alle `{type:"ephemeral"}` **ohne `ttl`**, also 5 Minuten: letztes Tool (M:192001), System-Block (M:192014), letzter Block der letzten Nachricht (M:191906–191912). Konstante `CACHE_CONTROL`, kein Konfig-Schalter.
- Tools sind nach Name sortiert, der System-Prompt wird einmal je Sitzung gerendert. Das Präfix bleibt innerhalb einer Sitzung stabil.
- `metadata.user_id` ist `sessionContext.sessionId` (M:192009, M:274178). **Subagenten tragen dieselbe Session-ID** (M:206801 ff.), ihre Anfragen liegen in `agents/agent-N/wire.jsonl`.
- Anfragen laufen immer mit `stream: true` (M:192019).
- **Thinking-Form für 5.5er-Profile:** `{type:"adaptive", display:"summarized"}` plus `output_config.effort` (M:191805–191810). Für 4.5er-Profile `{type:"enabled", budget_tokens}` (M:191814).
- Kimi nutzt bei Bedarf die Beta-API (`anthropic-beta`-Kopfzeile, M:192004); der Vermittler reicht die Kopfzeile unverändert durch.

**Gemessen (Rauchtests mit Haiku 5.5, Print-Modus):**

| Messung | Tokens je Anfrage |
|---|---|
| Grundlast vor dem Parken der Skills | 54.376 |
| Grundlast nach dem Parken | 49.323 |
| Lauf 2 (Nachweis, dass der Cache greift) | 33.440 aus dem Cache gelesen |

**Anbieter-Zuordnung (`~/.kimi-code/config.toml`):** Jedes Modell nennt seinen `provider`, jeder Provider hat eine eigene `base_url`.

- Claude: Provider `anthropic` (Z. 51 ff.)
- Kimi: `managed:kimi-code` und `managed:moonshot-ai`
- GLM: `zai-coding-plan`

Ein Vermittler hinter `[providers.anthropic].base_url` sieht deshalb **nur** Claude-Verkehr (A4). Das SDK hängt `/v1/messages` selbst an `base_url`.

**Hooks (Kimi-Doku `customization/hooks.html`, Code M:206689 ff.):**

- Jeder Hook erhält per stdin JSON mit `hook_event_name`, `session_id`, `session_title`, `client_type`, `cwd`. Feldnamen `snake_case`.
- `SessionStart` (Matcher `startup` | `resume`, Zusatzfelder `source`, `model`, `profile`) wird **awaited** (M:206754), Timeout je Hook 1–600 s, Standard 30 s.
- `SessionEnd` (Matcher `exit` | `archive`) wird awaited (M:206776).
- `SessionHeartbeat` feuert **alle 60 s** (`HEARTBEAT_INTERVAL_MS = 6e4`, M:206704), aber **nur, wenn ein Hook dafür registriert ist** (M:206750). Feld `uptime_ms`.
- `SubagentStart` (awaited) und `SubagentStop` (fire-and-forget), Matcher = Agentenname, Session-ID = Elternsitzung.
- Mehrere Regeln laufen parallel; identische `command`-Werte laufen nur einmal. Nur `event`, `matcher`, `command`, `timeout` sind erlaubt.
- mneme nutzt `SessionStart`, `SessionEnd`, `PreCompact`, `PostCompact` (`config.toml` Z. 318–332).

---

## 3. Fakten der Anthropic-API (Live-Doku, abgerufen 2026-10-11, zweimal gegengelesen)

Quelle: https://platform.claude.com/docs/en/build-with-claude/prompt-caching

| Thema | Fakt |
|---|---|
| Haltezeit | Standard 5 Minuten, optional `"ttl": "1h"`. **Mehr als 1 Stunde gibt es nicht.** Kein Beta-Header nötig |
| Preise Schreiben | 5 min: **1,25×** Eingabepreis. 1 h: **2×** |
| Preise Lesen | 0,1× Standard. **Opus 5.5 und Sonnet 5.5: 0,05×** ($0,20 bzw. **$0,10**). **Fable 5.1: 0,025×** ($0,25). Haiku 5.5: 0,1× |
| Auffrischung | „The cache is refreshed for no additional cost each time the cached content is used." Jedes Lesen setzt die Uhr zurück, gezahlt wird nur der Lesepreis |
| Uhr | „The lifetime is measured from the **start** of the request that writes or reads the cache entry, not from the end of its response." Eine Generierung von 4 Minuten lässt bei 5 min etwa 1 Minute für den Folgezug |
| Mischen | Längere Haltezeiten müssen vor kürzeren stehen. **„1-h-Marke vorn, 5-min-Schwanz hinten" ist ausdrücklich erlaubt.** Höchstens 4 Breakpoints |
| `max_tokens: 0` | Füllt bzw. liest den Cache und liefert keine Ausgabe (`content: []`, `stop_reason: "max_tokens"`, volles `usage`). **Abgelehnt** mit `stream: true`, `thinking.type: "enabled"`, `output_config.format`, `tool_choice` any/tool und in Batches. **`thinking.type: "adaptive"` ist zulässig** (Doku-Beispiel nutzt es) |
| Cache-Schlüssel | `stream` und `max_tokens` gehören nicht dazu („streaming is a transport option, not part of the cached prefix"). Thinking-Konfiguration, `output_config.effort`, Tools und `tool_choice` gehören dazu |
| Auswertung | `usage.cache_creation.ephemeral_5m_input_tokens` und `ephemeral_1h_input_tokens`; `cache_read_input_tokens` |
| Lesbarkeit | Ein Eintrag ist lesbar, sobald die schreibende Antwort **zu streamen beginnt** |
| Doku-Empfehlung Fable 5.1 | Für Pausen von 5 bis 60 min ist ein Keep-alive mit `max_tokens: 0` auf 5-min-Einträgen **meist billiger** als 1 h, weil Lesen 0,025× kostet |

**Bezugsgröße:** Claude Code selbst schreibt in dieser Maschine **ausschließlich 1-h-Einträge**. Belegt am Sitzungsprotokoll vom 2026-10-11: 578.176 Schreib-Tokens, alle `ephemeral_1h`.

---

## 4. Warum überhaupt ein Vermittler

Kimi schreibt die `cache_control`-Marken fest ins Programm, ohne `ttl`. Eine Haltezeit über 5 Minuten geht deshalb **nur** auf drei Wegen:

| Weg | Bewertung |
|---|---|
| (a) Lokaler Vermittler auf `127.0.0.1`, auf den `base_url` zeigt | übersteht Kimi-Updates, **gewählt** |
| (b) Patch in `main.mjs` | drei Zeilen, wird aber bei jedem Kimi-Update überschrieben, verworfen |
| (c) Feature-Wunsch an Moonshot (`cache_ttl`) | unabhängig davon sinnvoll, löst das Problem aber nicht jetzt |

**Nebennutzen des Vermittlers:** Er kann die `oneOf`-Schemas für Anthropic glätten. Dann kann `kimi-cu-win` wieder für alle Modelle aktiviert werden.

---

## 5. Drei Varianten

| | **A: 1 h überall** | **B: 5 min plus Ping** | **C: 1 h Sockel, 5 min Schwanz** |
|---|---|---|---|
| Prinzip | `ttl: "1h"` auf alle drei Marken. Wie Claude Code | Kimis 5-min-Marken bleiben. In Pausen liest der Vermittler den Cache alle ~4 min, höchstens 60 min lang | `ttl: "1h"` nur auf Tool- und System-Marke (Sockel ~49k), die Nachrichten-Marke bleibt 5 min. Von der Doku ausdrücklich erlaubt |
| Ping nötig | nein | ja | nein |
| Kosten normaler Zug | Schreiben 2× auf jeden neuen Token | Schreiben 1,25× (wie heute) | Sockel einmal 2×, Zuwachs 1,25× |
| Kosten einer Pause von 5 bis 60 min | ein Lesezugriff | ein Lesezugriff je ~4 min | Gesprächsteil wird neu geschrieben (1,25×), Sockel wird gelesen |
| Komplexität | gering | höher: Zeitgeber je Schlüssel, letzter Body und Kopfzeilen im RAM, Ping ohne Streaming, Totmannschalter | gering |
| Risiko | gering | mittel | gering |
| Grenzfälle | keine | 4.5er-Modelle (`thinking.type: "enabled"`) können nicht pingen, dort bleibt es bei 5 min | keine |

---

## 6. Kostenmodell (Schätzung, Listenpreise Opus 5.5)

Preise je Million Tokens: Eingabe $4, Schreiben 5 min $5, Schreiben 1 h $8, Lesen $0,20.

**Beispielstunde:** 30 Anfragen, Grundlast 49.000, je Anfrage 3.000 neue Tokens (Kontext wächst von 49.000 auf 139.000), zwei Pausen zu je 10 min bei etwa 80.000 bzw. 110.000 Kontext. Das Lesen aus dem Cache (~$0,56) ist in allen Varianten gleich und fehlt in der Tabelle.

| Strategie | mit 2 Pausen | ohne Pause |
|---|---|---|
| Heute (5 min, ohne Vermittler) | $1,65 (davon $0,95 Neuschreiben nach den Pausen) | $0,70 |
| Variante A (1 h überall) | $1,11 | $1,11 |
| Variante B (5 min plus Ping) | ~$0,78 | $0,70 |
| Variante C (1 h Sockel, 5 min Schwanz) | ~$1,30 | ~$0,84 |

**Einordnung:**

- Bei kurzen und mittleren Pausen ist B am billigsten.
- Viele Pausen nahe 60 min lassen die Pings auf das Niveau von A steigen (~2 Cent je Ping bei 100.000 Kontext).
- C liegt je nach Pausenmuster zwischen A und B. Sie kostet nichts im Bau und wird nur mitgerechnet.
- Bei Sonnet 5.5 ist Schreiben halb so teuer, Lesen kostet $0,10. B gewinnt dort deutlicher.
- Bei Fable 5.1 kostet Lesen 0,025×. Die Doku empfiehlt dort den Keep-alive, also B.
- Bei Haiku 5.5 sind die Beträge vernachlässigbar.
- **Alle Werte sind eine Modellrechnung, nicht gemessen.**

---

## 7. Empfehlung: in zwei Stufen, Modus je Modell

1. **Stufe 1: Variante A** als Standard, dazu Schema-Glättung, Kostenprotokoll mit Gegenrechnung für B und C, Hook-Endpunkte (Session-Ende, Heartbeat, Subagent-Ende). Das Protokoll rechnet aus den echten Zeitabständen jeder Sitzung mit, was B und C gekostet hätten.
2. **Stufe 2: Variante B** als wählbarer Modus. Scharf geschaltet je Modell, sobald das Protokoll nach einer Woche eine Ersparnis von mindestens 20 % gegenüber A zeigt. Für Fable 5.1 darf B nach der Doku-Empfehlung sofort gesetzt werden, sobald Stufe 2 gebaut und live geprüft ist. **Gesetzt am 2026-10-11** (`modeByModel.claude-fable-5-1 = "ping"`) nach bestandener Live-Probe. Entscheid für Opus 5.5 und Sonnet 5.5 nach einer Woche `node vermittler.mjs bericht --tage 7`.

**Begründung:** A erfüllt A1 bis A4 sofort, ist einfach zu prüfen und hat ein kleines Fehlerbild. B spart nur je nach Pausenmuster, und das ist unbekannt. Die Entscheidung soll auf Messdaten beruhen, nicht auf einer Modellrechnung. Der Modus ist **je Modell** wählbar, weil die Lesepreise je Modell um den Faktor 4 auseinanderliegen.

---

## 8. Architektur

### 8.1 Bausteine

```
Kimi (provider anthropic)
  --HTTP-->  Vermittler 127.0.0.1:<port>
  --HTTPS--> api.anthropic.com
Kimi-Hooks (SessionStart, SessionEnd, SessionHeartbeat, SubagentStop)
  --HTTP-->  Vermittler /_vermittler/*
```

- **Sprache:** Node.js (ist durch Kimi installiert), **ohne Abhängigkeiten** (`node:http`, `fetch`, `node:test`). ES-Module.
- **Ablage:** `~/.kimi-code/tools/anthropic-vermittler/`
  - `vermittler.mjs` (Server, Einstieg; Unterbefehle `start`, `stop`, `restart`, `status`, `bericht [--tage N]`, intern `serve`; überall optional `--konfig <pfad>`)
  - `lib/dienst.mjs` (Dienststeuerung: prüfen, losgelöst starten, sauber stoppen, PID- und Logdatei) und `lib/kennung.mjs` (`VERSION`, `DIENST`); seit 0.4.0 ausgelagert, damit `vermittler.mjs` unter 800 Zeilen bleibt
  - `lib/transform.mjs` (T1, T2, reine Funktionen)
  - `lib/weiterleitung.mjs` (Proxy-Mechanik, SSE)
  - `lib/protokoll.mjs` (JSONL, Kosten, Gegenrechnung)
  - `lib/sitzungen.mjs` (Sitzungszustand für die Hook-Endpunkte; Stufe 2 baut darauf auf)
  - `lib/ping.mjs` (Stufe 2)
  - `hooks/session-start.mjs`, `hooks/session-ereignis.mjs` (Kimi-Hooks)
  - `test/*.test.mjs`, `test/fake-upstream.mjs`
  - `vermittler.json` (Konfiguration), `README.md` (Einrichtung, Rückweg)
- **Konfiguration `vermittler.json`:**

```json
{
  "port": 37790,
  "upstream": "https://api.anthropic.com",
  "mode": "ttl1h",
  "modeByModel": { "claude-fable-5-1": "ttl1h" },
  "ping": { "intervalSec": 240, "maxIdleMin": 60, "heartbeatGraceSec": 180 },
  "logPath": "~/.kimi-code/tools/anthropic-vermittler/protokoll.jsonl",
  "preise": { "claude-opus-5-5": { "input": 4, "w5m": 5, "w1h": 8, "read": 0.2, "output": 20 } }
}
```

`mode` ist `"ttl1h" | "ping" | "sockel1h" | "aus"`. `modeByModel` überstimmt je Modell-ID (Präfix-Treffer). `preise` trägt die Listenpreise je Modell; unbekannte Modelle werden protokolliert, aber ohne Kosten. Grenzen seit 0.4.0: `intervalSec` 30–285 (Tick-Verzug bis 5 s muss unter der 5-min-Haltezeit bleiben), `maxIdleMin` 1–1440, `heartbeatGraceSec` 30–3600, alles ganzzahlig; `logPath` relativ zur Konfigdatei; `health` trägt `konfigHash`, eine geänderte Konfig erneuert den Dienst beim nächsten Kimi-Start.

### 8.2 Ablauf je Anfrage an `POST /v1/messages`

1. Kimi schickt `POST /v1/messages` an den Vermittler.
2. Der Vermittler liest den JSON-Body. Lässt er sich nicht parsen, geht er **bytegleich** durch (Schritt 4 ohne Transformation).
3. Transformationen (reine Funktionen, `lib/transform.mjs`):
   - **T1, Haltezeit** (Modus `ttl1h`): Jedes `cache_control` mit `type: "ephemeral"` **ohne** `ttl` bekommt `ttl: "1h"`. Ein vorhandenes `ttl` bleibt unverändert, damit ein künftiges Kimi-Update, das selbst eine Haltezeit setzt, nicht überschrieben wird. Alle Marken haben dieselbe Haltezeit, die Reihenfolge-Regel ist erfüllt. Modus `sockel1h`: nur Marken in `tools` und `system` bekommen `ttl: "1h"`, Marken in `messages` bleiben. Modus `ping` und `aus`: keine Änderung.
   - **T2, Schema-Glättung:** Bei jedem Tool, dessen `input_schema` auf oberster Ebene `oneOf`, `anyOf` oder `allOf` hat:
     1. Die `properties` aller Zweige und der obersten Ebene werden zu **einer** `properties`-Menge vereinigt (erster Treffer je Schlüssel gewinnt, Beschreibungen bleiben).
     2. `required` der Zweige entfällt; ein `required` der obersten Ebene bleibt.
     3. `additionalProperties`, `type` und `description` der obersten Ebene bleiben; fehlt `type`, wird `"object"` gesetzt.
     4. Der Schlüssel `oneOf`/`anyOf`/`allOf` wird entfernt.
     5. An `description` wird ein Satz angehängt, der die Bedingung trägt. `oneOf`: „Genau eine dieser Feldgruppen angeben: (pid) | (app) | (window_id)". `anyOf`: „Mindestens eine …". `allOf`: „Alle Felder der Gruppen angeben …". Je Zweig die `required`-Felder, sonst die `properties`-Schlüssel.
     6. Verschachtelte `oneOf` tiefer als die oberste Ebene bleiben unangetastet (die API erlaubt sie).
     Die Validierung bleibt beim MCP-Server. **Ein geglättetes Schema darf nie weniger Parameter zeigen als die Vereinigung seiner Zweige.**
4. Weiterleitung an `upstream` (`lib/weiterleitung.mjs`), **Proxy-Pflichten:**
   - Durchgereicht: `x-api-key`, `authorization`, `anthropic-version`, `anthropic-beta`, `content-type`, `accept`, `user-agent`, `x-stainless-*`.
   - Nicht durchgereicht: `host`, `connection`, `content-length`, `transfer-encoding`, `keep-alive`, `proxy-*`, `accept-encoding` (der Vermittler setzt `accept-encoding: identity`, damit nichts entpackt werden muss).
   - Der veränderte Body wird neu serialisiert, `content-length` neu gesetzt.
   - Pfad und Query 1:1 übernommen.
5. Die Antwort wird **unverändert gestreamt** durchgereicht (SSE). Status und Kopfzeilen 1:1, außer `content-encoding`, `content-length`, `transfer-encoding`, `connection` (Node setzt sie selbst; `fetch` entpackt gzip, eine mitgeschickte `content-encoding` würde den Strom beim Client zerstören). Parallel liest der Vermittler `message_start.usage` und `message_delta.usage` für das Protokoll mit; bei `stream: false` den Body.
6. Andere Pfade (`/v1/messages/count_tokens`, `/v1/models` …) laufen als reiner Durchgang, ohne T1 und T2, mit denselben Kopfzeilen-Regeln.
7. Fehler des Upstreams (4xx, 5xx) gehen 1:1 durch. Ein Verbindungsfehler zum Upstream wird als `502` mit JSON im Anthropic-Fehlerformat beantwortet (`{"type":"error","error":{"type":"api_error","message":"…"}}`), **ohne** Kopfzeilen oder Body-Inhalte zu zitieren.

### 8.3 Hook-Endpunkte (Stufe 1, für Stufe 2 vorbereitet)

Alle unter `/_vermittler/`, nur `127.0.0.1`, JSON-Body mit `session_id`:

| Endpunkt | Aufrufer | Wirkung |
|---|---|---|
| `GET /_vermittler/health` | Start-Hook, `status` | `{ok, dienst: "anthropic-vermittler", version, pid, mode, uptimeSec}`; am Feld `dienst` erkennt der Hook den eigenen Dienst gegenüber einem fremden |
| `POST /_vermittler/session-ende` | Hook `SessionEnd` | Zustand der Session verwerfen, Pings stoppen |
| `POST /_vermittler/heartbeat` | Hook `SessionHeartbeat` | Lebenszeichen setzen |
| `POST /_vermittler/subagent-ende` | Hook `SubagentStop` | Nebenschlüssel der Session verwerfen (alle außer dem zuletzt aktiven Haupt-Schlüssel) |

`hooks/session-ereignis.mjs` liest stdin, wählt den Endpunkt nach `hook_event_name` und ruft ihn mit 2 s Timeout. Fehler werden geschluckt (Hook darf Kimi nie bremsen), Exit 0.

### 8.4 Nur Modus `ping` (Stufe 2): Ping-Planer (`lib/ping.mjs`)

- **Schlüssel:** `metadata.user_id` (Session-ID) **plus** SHA-256 über `model`, `system`, `tools`, `thinking`, `output_config`. Subagenten derselben Sitzung haben andere Tools oder Systemprompts und werden so getrennt geführt.
- **Zustand je Schlüssel:** Startzeit der letzten Anfrage, Zeitpunkt des ersten Antwort-Bytes, Body und die durchgereichten Kopfzeilen (nur im RAM), Zeitpunkt des letzten Heartbeats der Session.
- **Ping-Regel:** Fällig, wenn seit dem **Start** der letzten Anfrage `intervalSec` vergangen sind **und** deren erstes Antwort-Byte angekommen ist. Ob die Anfrage noch läuft, spielt keine Rolle: Der Cache-Eintrag ist ab dem ersten Byte lesbar, und eine lange Generierung lässt ihn sonst sterben. Ein Ping sendet den letzten Body mit `max_tokens: 0` und `stream: false`, alles andere bytegleich, mit denselben Kopfzeilen. Wiederholung alle `intervalSec`, höchstens `maxIdleMin` nach der letzten echten Anfrage.
- **Kein Ping**, wenn der Body `thinking.type: "enabled"`, `output_config.format` oder `tool_choice` `any`/`tool` enthält, oder nach einem Fehler des Pings (Protokolleintrag, Ende für diesen Schlüssel).
- **Totmannschalter:** Hat die Session je einen Heartbeat gesendet und liegt der letzte länger als `heartbeatGraceSec` (180 s bei 60-s-Takt) zurück, enden die Pings. Hat die Session nie einen Heartbeat gesendet (Hook nicht eingerichtet), gilt allein `maxIdleMin`.
- **Stopp:** `session-ende` verwirft alle Schlüssel der Session, `subagent-ende` die Nebenschlüssel.
- **Key-Haltung:** Für Pings hält der Vermittler `x-api-key` bzw. `authorization` der letzten Anfrage im RAM, höchstens `maxIdleMin` lang. Siehe §9.

### 8.5 Start und Ende

- **Autostart:** Hook `SessionStart` (`hooks/session-start.mjs`) fragt `GET /_vermittler/health`. Antwortet der eigene Dienst, Exit 0. Antwortet niemand, startet er `vermittler.mjs start` losgelöst (`detached: true`, `stdio: "ignore"`, `windowsHide: true`, `unref()`) und **wartet bis 2 s auf den Port**, bevor er zurückkehrt. Antwortet ein fremder Dienst auf dem Port, meldet er es auf stderr und Exit 0 (Kimi läuft weiter, Claude-Anfragen scheitern sichtbar). Mehrfacher Aufruf ist unschädlich. Das SDK wiederholt Verbindungsfehler zweimal mit Backoff, das deckt einen späten Start im Print-Modus zusätzlich ab.
- **Umschalten der Konfiguration:** `[providers.anthropic] base_url = "http://127.0.0.1:37790"` und vier `[[hooks]]`-Einträge (`SessionStart`, `SessionEnd`, `SessionHeartbeat`, `SubagentStop`) mit `timeout = 5`.
- **Neustart nach Konfig- oder Code-Änderung:** `node vermittler.mjs restart` (findet den laufenden Dienst über `health.pid`, beendet ihn, startet neu).
- **Ausfall:** Läuft der Vermittler nicht, scheitern **nur** Claude-Modelle mit einem Verbindungsfehler. Kimi und GLM sind nicht betroffen.

### 8.6 Protokoll (`lib/protokoll.mjs`)

Eine JSONL-Zeile je Anfrage (auch je Ping, mit `art: "ping"`):

- `ts` (ISO 8601), `session` (SHA-256 der Session-ID, 12 Zeichen), `schluessel` (Hash, 12 Zeichen), `modell`, `modus`, `art` (`anfrage` | `ping` | `durchgang`), `status`
- `input`, `cache_read`, `cache_w5m`, `cache_w1h`, `output`
- `sekundenSeitLetzter` (Startabstand zur vorigen Anfrage desselben Schlüssels)
- `kosten` nach Listenpreis für den tatsächlichen Modus
- `gegenrechnung`: `{ttl1h, ping, sockel1h, heute}` in Dollar, aus denselben Token-Zahlen und dem echten Zeitabstand hergeleitet. Regel: Wäre der Abstand > 5 min und ≤ 60 min, hätte „heute" das gesamte Präfix neu geschrieben, „ping" `floor((abstand − 1)/intervalSec)` Lesezugriffe zusätzlich bezahlt (Pings fallen bei k·intervalSec strikt vor der nächsten Anfrage an), „sockel1h" den Nachrichtenteil neu geschrieben. Der Sockelanteil wird über den Zeichenanteil von Tools+System am Gesamt-JSON geschätzt.
- **Warnungen** (Feld `warnung`): Anzahl Marken ≠ 3 · `cache_w5m + cache_w1h` ≥ 90 % des Gesamtkontexts bei einer Folgeanfrage (Präfix gebrochen) · `user_id`-Wechsel innerhalb von 10 min bei gleichem System-Hash (Session-ID instabil, Frage 3).

Inhalte, Prompts und Schlüssel werden nie protokolliert. `node vermittler.mjs bericht [--tage 7]` summiert je Modell und Modus: echte Kosten, Gegenrechnung aller Varianten, Ersparnis in Prozent, Anzahl Warnungen.

---

## 9. Sicherheit

- Der Vermittler lauscht **nur** auf `127.0.0.1`.
- Der API-Key wird durchgereicht, nie protokolliert, nie in Fehlermeldungen zitiert. **Modus `ping` hält Key und letzten Body je Schlüssel im RAM**, höchstens `maxIdleMin` lang, danach werden sie verworfen. Ein Speicherabbild des Prozesses enthielte sie; das ist dieselbe Lage wie bei Kimi selbst.
- Anfrage-Inhalte werden nie auf die Platte geschrieben.
- Keine Fremdabhängigkeiten, also kein Lieferketten-Risiko über npm (vgl. Härtung `ignore-scripts`).
- Fehlerhafte JSON-Bodies gehen unverändert durch. Der Vermittler korrigiert nichts, was er nicht versteht.
- Die `/_vermittler/`-Endpunkte sind unauthentifiziert, aber nur lokal erreichbar und können nur Zustand verwerfen oder Lebenszeichen setzen.
- Anfragen mit `Origin`-Kopfzeile werden mit 403 abgewiesen (Browser, DNS-Rebinding). Das SDK in Kimi sendet keine (Live-Lauf 2026-10-11).

---

## 10. Testplan

**Unit-Tests (`node --test "test/*.test.mjs"`, Node 24 nimmt kein Verzeichnis als Argument; vor dem Code, TDD):**

- T1: setzt `ttl` nur bei `ephemeral` ohne `ttl`, lässt vorhandenes `ttl` stehen, erfüllt die Reihenfolge-Regel; Modus `sockel1h` lässt Marken in `messages` unberührt; Modus `ping`/`aus` ändert nichts. T1 ist rein (verändert die Eingabe nicht).
- T2: glättet nur oberste Ebene; **`properties` enthält nach der Glättung jeden Schlüssel jedes Zweigs** (Prüffall: Schema ohne eigene `properties`, nur `oneOf`-Zweige); verschachtelte `oneOf` bleiben; `description` trägt den Satz; `allOf`/`anyOf`-Varianten; Schema ohne `oneOf` bleibt bytegleich.
- Protokoll: Gegenrechnung für die vier Fälle (Abstand < 5 min, 5–60 min, > 60 min, erste Anfrage); Warnungen; kein Key im Eintrag.
- Ping (Stufe 2): Ping-Body hat `max_tokens: 0`, `stream: false`, sonst bytegleich; Fälligkeit nach Startzeit, auch bei laufender Anfrage; kein Ping bei `thinking.type: "enabled"`; Stopp nach `maxIdleMin`, bei `session-ende`, bei ausbleibendem Heartbeat; Subagenten-Schlüssel getrennt.

**Integration (gegen `test/fake-upstream.mjs`, ein `node:http`-Server, der aufgezeichnete SSE-Antworten liefert, gzip-komprimiert senden kann und Kopfzeilen sowie Body zurückspiegelt):**

- SSE wird bytegleich durchgereicht, auch bei gzip-Antwort des Upstreams.
- Fehlerstatus 4xx und 5xx gehen 1:1 durch; Upstream nicht erreichbar ergibt 502 im Anthropic-Format.
- Kopfzeilen: `x-api-key`, `authorization`, `anthropic-beta` kommen an; `host`, `content-length` des Clients kommen nicht an; `content-length` stimmt zum neuen Body.
- `count_tokens` geht ohne T1/T2 durch.
- Hook-Endpunkte: `health`, `session-ende`, `heartbeat`, `subagent-ende`.
- **Adversariale Probe:** Testschlüssel `sk-ant-TESTSCHLUESSEL-…` einschleusen, danach Protokoll, stdout, stderr und alle Fehlerantworten durchsuchen. Treffer = Testfehler.
- Nicht parsbarer Body geht bytegleich durch.

**Live (Haiku 5.5, kostet Bruchteile eines Cents; erst nach grünem Unit- und Integrationslauf):**

- A: `ephemeral_1h_input_tokens > 0`. Zweiter Lauf nach **mehr als 6 min** Pause: `cache_read > 0`.
  **Bestanden 2026-10-11:** Lauf 1 (19:26:42 UTC) `cache_w1h` 49.286; Lauf 2 (19:33:28, Abstand 6 min 46 s) `cache_read` 49.286, `cache_w1h` 0, Kosten $0,0005 statt $0,0062. Der Start-Hook fuhr den Dienst selbst hoch; Kimi sendet keine `Origin`-Kopfzeile; die Kopfzeilen-Allowlist reicht.
- T2: `kimi-cu-win` aktivieren, Claude-Anfrage ohne 400.
  **Bestanden 2026-10-11:** Lauf 3 (19:34:10) mit acht `oneOf`-Schemas im Wire, Status 200. Nebenbefund: cu-win kostet rund 5.300 Tokens Grundlast je Anfrage (49.286 → 54.631).
- Stufe 2: Pause von 10 min mit Pings, danach `cache_read > 0`. `SessionEnd` beendet die Pings nachweislich (Protokoll).
  **Bestanden 2026-10-11 (Nebeninstanz Port 37791, Modus `ping`, Intervall 120 s, curl mit Kimi-ähnlichem Body, Haiku 5.5):** Anfrage 1 (19:37:23) `cache_w5m` 6.616; Pings 19:39:29, 19:41:29, 19:43:29, je `cache_read` 6.616, Status 200, je $0,00007; Anfrage 2 (19:43:49, Abstand 6 min 26 s) `cache_read` 6.616, nichts neu geschrieben. `session-ende` verwarf den Schlüssel (`pingSchluessel` 0). Drift je Ping etwa 6 s (Takt 5 s plus Laufzeit), bei 240 s Intervall unkritisch.

**Bekannte Grenze der Gegenrechnung:** Der Zeitabstand wird je Schlüssel (Session + Präfix-Hash) geführt. Zwei getrennte Sitzungen mit gleichem Sockel teilen den echten Cache, die Gegenrechnung sieht aber für jede nur „erste Anfrage". Innerhalb einer Sitzung, dem Normalfall, ist sie exakt; über Sitzungsgrenzen unterschätzt sie den Vorteil des Vermittlers.

**Abdeckungsmeldung** nach der Projektregel: Für jeden Bericht Schreibpfade, Fehlerpfade, Policy-Grenzen und Edge Cases einzeln als geprüft oder nicht geprüft ausweisen.

---

## 11. Entschiedene und offene Fragen

| # | Frage | Stand |
|---|---|---|
| 1 | A vor B? | **Entschieden:** ja, Stufung bleibt; Modus je Modell |
| 2 | Hook-Payload mit Session-ID? | **Geklärt:** ja, `session_id` per stdin bei jedem Event |
| 3 | `metadata.user_id` stabil? | Session-ID belegt (M:274178) und **live bestätigt 2026-10-11**: `sha12(user_id)` im Protokoll ist identisch mit `sha12("session_<uuid>")` des Sitzungsordners, also dieselbe Kennung, die die Hooks als `session_id` erhalten. Nach `--resume` **nicht belegt**; Protokoll warnt bei Wechsel |
| 4 | T2-Treffsicherheit | Nach der Vereinigungsregel trägt das Schema alle Parameter und die Bedingung im Text; MCP validiert. Restrisiko gering, im Live-Test prüfen |
| 5 | Ping bei Langläufern | **Entschieden:** Ping richtet sich nach der Startzeit, auch während laufender Anfrage |
| 6 | Kimi-Updates erkennen | Warnung bei ≠ 3 Marken und bei gebrochenem Präfix |
| 7 | Port | 37790 (mneme: 37778); `health` unterscheidet eigenen von fremdem Dienst |
| 8 | API-Guthaben für Pings? | Annahme ja, **ungeprüft**; nach dem ersten Live-Lauf in der Console gegenlesen |
| 9 | Totmannschalter | **Entschieden:** Heartbeat-Hook, 180 s Gnadenfrist |
| 10 | Variante C | **Entschieden:** nur Gegenrechnung, kein Standardmodus |

---

## 12. Rückweg

- In `config.toml` die Zeile `base_url` unter `[providers.anthropic]` entfernen.
- Die vier `[[hooks]]`-Einträge des Vermittlers entfernen.
- `node vermittler.mjs stop`, dann den Ordner `~/.kimi-code/tools/anthropic-vermittler/` löschen.
- Kimi läuft danach wieder direkt mit 5 min Haltezeit.

---

## 13. Quellen

- Anthropic Prompt-Caching, Live-Doku (abgerufen 2026-10-11, zweimal): https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Anthropic API-Guthaben für Max und Team: https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers
- Kimi Code CLI Doku: `configuration/providers.html`, `customization/hooks.html`, `config-files.html`, `customization/plugins.html`
- Kimi-Quellcode 2.1.1 (`main.mjs`): Zeilenangaben oben. Code-Analysen vom 2026-10-11 (zwei externe, eine Deimon).
- Messwerte: `~/.kimi-code/sessions/wd_*/…/agents/main/wire.jsonl` (`usage.record`, `token_counting.measured`) und das Claude-Code-Sitzungsprotokoll `735d249b-….jsonl`.
- Review Deimon 2026-10-11 (Fassung 1 → 2): Preisfehler Sonnet 5.5, T2-Vereinigungsregel, Key-Haltung in B, Proxy-Pflichten, Ping nach Startzeit, Heartbeat, Start-Rennen, Variante C, Modus je Modell.

---

## 14. Externes Review (Kimi, adversarial, nur lesend, 2026-10-11)

Nach Bau und zwei Deimon-Reviews aus derselben Sitzung ein unabhängiges Zweitmodell, in zwei Hälften (Proxy-Mechanik; Logik). **Kein Blocker.**

**Umgesetzt (Iteration 3):** Request-Target darf den Upstream-Host nicht überschreiben (nur einfacher `/`-Pfad, URL per Verkettung) · `schreibe` hängt nicht mehr nach Client-Abbruch · Beobachter-Fehler schließen den Upstream-Body · Host-Prüfung gegen DNS-Rebinding · `POST /_vermittler/stop` für sauberen Stopp unter Windows, `cliStop` nutzt ihn vor `process.kill`, PID-Validierung · Konfig: Port 1–65535, `intervalSec < 300`, `http:` nur Loopback · Versionsprüfung beim Start (alter Dienst wird nach Code-Update ersetzt) · Timeouts beim `health`-Check nicht als „fremd" · stdin-Fallback 5 s · `Object.hasOwn` · Client-Abbruch nicht als 502 · `anthropic-`-Präfix und weitere Hop-by-hop-Sperren · Spawn-Fehler sichtbar · **Hauptagent nach größtem Sockel statt erster Anfrage** · **Totmann auch ohne je gesehenen Heartbeat** (Referenz: Start der letzten Anfrage) · `laeuft` wird immer zurückgesetzt · kein Ping-Zustand ohne Session, `ersteByte` mit Startzeit-Abgleich · In-flight-Pings abbrechbar · `tool_choice` im Schlüssel, Zustände nach 2 h bereinigt · `normalisiereUsage`-Rückfall.

**Verworfen, weil im echten Code schon gelöst oder Artefakt der gekürzten Vorlage:** fehlender Standard-Fehlermelder, Ping-Body gleich transformierter Body, Kopfzeilen-Allowlist für Pings, `usage`-Normalisierung im Aufrufer.

**Bewusst offen:** asynchrone Log-Warteschlange und Rotation (Einträge sind ~400 Byte, Platte unkritisch) · `performance.now()` statt Wanduhr (Uhrsprünge sind auf dieser Maschine kein Betriebsfall) · HMAC für den System-Hash (12 Hex-Zeichen eines unsalzenen SHA-256 sind ein Fingerabdruck, kein Geheimnis) · Konfliktzählung gleichnamiger Properties in T2 (bei `kimi-cu-win` nicht beobachtet).

**Runde 2 (nach Iteration 3, Version 0.2.0), wieder kein Blocker. Umgesetzt in Iteration 5 (Version 0.3.0):** Stop-Endpunkt nur mit eigener PID im Body (zwei gleichzeitige Start-Hooks beim Versionswechsel) · PID-Datei `vermittler.pid`, `process.kill` nur bei Übereinstimmung, `ESRCH` gilt als gestoppt · Signalweg über dieselbe Gnadenfrist · **Konfig-Fingerabdruck im Health**, abweichende Konfig erneuert den Dienst beim nächsten Kimi-Start wie eine neue Version · strenge Typ- und Bereichsprüfung der Konfig (Zahlen, Intervall 30–299, Upstream nur Origin, unbekannte Schlüssel gewarnt) · 413 vor dem Trennen · `protokoll.ende` in `finally` · UTF-8-BOM toleriert · Konfig-Syntaxfehler ohne Quelltext-Zitat · stderr des losgelösten Dienstes in `vermittler.log` · Body-Grenze 32 MB, 64 Verbindungen · Planer nur für `/v1/messages` · Totmann-Referenz ist das Jüngere aus Heartbeat und Anfragestart · alter Ping wird bei Neuanmeldung abgebrochen · eigener Abbruch schreibt keine Protokollzeile · `writeHead`-Fehler ergibt 502 statt Wurf · CRLF-Konfigdateien idempotent gepatcht · Klonort frei.

**Verworfen, weil durch die Aufrufer-Verdrahtung ausgeschlossen:** „Planer bei 4xx scharf" (Anmeldung nur bei 2xx-Kopf), „count_tokens ersetzt Ping-Zustand" (nur `POST /v1/messages` meldet an; Schutzgitter trotzdem ergänzt), „`status` gibt nichts aus", „`modeByModel['constructor']`" (Präfix-Suche über `Object.keys`, kein Lookup).

**Bewusst offen (Runde 2):** Token für die `/_vermittler/`-Endpunkte (nur Loopback, kann nur Zustand verwerfen oder stoppen) · Pending-Zustand bis zum ersten Byte der Folgeanfrage · Lazy-Parse des Ping-Bodys (Bodies hier ~500 KB) · Kommentare direkt vor einem Tabellenkopf beim Hook-Entfernen · lauter Fehler ohne Heartbeat-Hook (dokumentiert als Pflicht, `pruefen` zeigt 4/4).

**Runde 3 (nach Iteration 5, Version 0.3.0; drei Scheiben: Server, Dienststeuerung, Planer+Setup), kein Blocker. Umgesetzt in Iteration 6 (Version 0.4.0):** Warnung für unbekannte Schlüssel auch in `ping` und `preise` · 503 während des Stopps · Heartbeat nur für bekannte Sitzungen · 256 Verbindungen · `ende` im `finally` abgesichert · Konfig vor dem Einfrieren geklont · Punkt-Segmente im Pfad abgewiesen · **„gestoppt" erst, wenn der Prozess weg ist** (Poll mit `kill(pid, 0)`), hängende eigene Instanz über die PID-Datei beendbar · PID-Datei auf jedem Ausgang entfernt, atomar geschrieben · Transportfehler beim Health-Check nicht als „fremd" · Logkürzung korrekt (Lesemenge, Zeilengrenze, atomar) · Stopp-Antwort geprüft, Hinweis für alte Stände · `start` druckt aus dem bestätigten Health · CLI-Argumente streng · **Intervall-Obergrenze 285 s** (Tick-Verzug) · abgebrochene Pings protokolliert (`fehler: "abgebrochen"`), `stoppe` räumt auf · Setup: tolerante Tabellenköpfe (Kommentar, Einrückung, bare Alias), eigene Hooks am Skriptnamen erkannt und ersetzt, fremde `base_url` nie überschrieben, erst Dienst dann Konfig, atomare Schreibvorgänge, Hinweis auf Key-Kopie in der Sicherung.

**Verworfen (im echten Code schon gelöst oder Fehldeutung):** Ping-Kopfzeilen ungefiltert (sie kommen aus `anfrageKopfzeilen`), `standardSende` ohne try/catch (hat es), `redirect` (ist `manual`), `pingSchluessel` sei ein Geheimnis (ist eine Anzahl), `logPath` doppelt (Kostenprotokoll und stderr-Log sind zwei Dateien), Request-Target `//host` (wird abgewiesen), `ersteByte` ohne 2xx-Gatter (Planer meldet nur bei 2xx an).

**Bewusst offen (Runde 3, Bedrohungsmodell Einzelplatz):** Ein lokaler Prozess desselben Benutzerkontos, der den Port besetzt und `health` nachahmt, könnte Claude-Verkehr an sich ziehen oder über eine veraltete PID-Datei einen fremden Prozess töten lassen; ein solcher Prozess kann auf dieser Maschine ohnehin alles, was der Benutzer kann. Deshalb keine HMAC-Authentifizierung des Health-Endpunkts und keine Prozess-Identitätsprüfung über Startzeit · Speichergrenzen (32 MB × 256) für einen Einzelplatz-Proxy ausreichend · `subagent-ende` verwirft alle Nebenschlüssel, weil der Hook keinen Schlüssel liefert (laufende Subagenten halten ihren Cache durch eigene Anfragen) · Rückweg lässt Provider- und Modellblöcke stehen · kein vollständiges TOML-Unescaping · Ping-Kette einer Sitzung, die während einer laufenden Anfrage endet, läuft höchstens 180 s weiter (Totmann).

**Abbruchregel (2026-10-11):** Nach Iteration 6 eine letzte Kimi-Prüfung nur der geänderten Stellen. Ohne Blocker und ohne belegten Major gilt der Stand als befundfrei; weitere Minors werden hier geführt, nicht iteriert.
