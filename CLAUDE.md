# Arbeitsanweisung: Kimi-Claude-Kette auf diesem PC einrichten

Dieses Repo ist der **Anthropic-Vermittler**: ein lokaler HTTP-Proxy auf `127.0.0.1:37790`, der
zwischen Kimi Code CLI und `api.anthropic.com` sitzt und nur den Claude-Verkehr sieht. Er setzt
die Cache-Haltezeit von Kimis Anfragen auf eine Stunde oder hält 5-min-Einträge per Ping warm,
glättet Tool-Schemas, die die Anthropic-API ablehnt, fängt Kimi-Eigenheiten ab, die die API mit
400 beantwortet (Denkbudget, Thinking-Bindung), und protokolliert die Kosten. Kimi- und
GLM-Modelle laufen unverändert direkt.

Du (Claude Code) richtest hier dieselbe Kette ein wie auf dem Ursprungs-PC. Folge den Schritten
der Reihe nach; bei einem Fehler anhalten und dem Menschen den Befund zeigen, nicht improvisieren.

- Betrieb und Konfiguration: [README.md](README.md)
- Warum es so gebaut ist (Messungen, Varianten, Entscheide): [2026-10-11 Bauplan Anthropic-Vermittler.md](2026-10-11%20Bauplan%20Anthropic-Vermittler.md)

## Ablage

Empfohlen ist `~/.kimi-code/tools/anthropic-vermittler` (unter Windows
`C:/Users/<name>/.kimi-code/tools/anthropic-vermittler`); dort liegt es auf dem Ursprungs-PC.
Jeder andere Ort geht auch: Die Hooks zeigen auf den tatsächlichen Klon-Pfad, und Protokoll,
PID- und Logdatei liegen neben `vermittler.json` im Klon. Nach einem Umzug des Klons
`node setup/setup.mjs rueckweg` am alten Ort und `einrichten` am neuen ausführen.

## Voraussetzungen

1. **Node.js ab 20.11** (`node --version`). Keine npm-Abhängigkeiten, kein `npm install` im Repo.
2. **Kimi Code CLI ab 2.1.1** (getestet mit 2.3.0): `npm install -g @moonshot-ai/kimi-code`, dann `kimi` einmal starten
   und beenden, damit `~/.kimi-code/config.toml` existiert.
3. **Anthropic-API-Key**, auf genau einem dieser Wege:
   - als Umgebungsvariable `ANTHROPIC_API_KEY` (Standard: das Setup trägt
     `api_key_env = "ANTHROPIC_API_KEY"` in den Provider ein), oder
   - vom Menschen selbst als `api_key = "…"` unter `[providers.anthropic]` in `config.toml`.

   **Frage den Menschen nach dem Key-Weg. Schreibe den Key nie selbst in eine Datei, gib ihn nie
   aus, protokolliere ihn nie, lies keine `api_key`-Zeile.** `setup.mjs pruefen` meldet nur, *ob*
   und *wo* ein Key konfiguriert ist.

## Schrittfolge

```
cd ~/.kimi-code/tools/anthropic-vermittler
npm test
node setup/setup.mjs pruefen
node setup/setup.mjs einrichten            # optional: --cu-win
kimi -p "Antworte nur mit OK." -m anthropic/claude-haiku-5-5
node vermittler.mjs status
```

1. **`npm test`** muss grün sein (alle Tests bestanden). Sonst anhalten.
2. **`pruefen`** zeigt Node, Node-Pfad, Kimi-Version, `config.toml` und je Einrichtungsschritt
   `vorhanden` oder `fehlt`. Es ändert nichts.
3. **`einrichten`** startet zuerst den Vermittler und bestätigt ihn über `status`; scheitert das,
   bleibt `config.toml` unverändert (Exit 1). Steht im Provider-Block schon eine fremde
   `base_url` (kein Loopback, etwa ein Proxy des Menschen), bricht es ab und nennt sie; ersetzt
   wird sie nur mit `--base-url-ersetzen`, und nur nach Rückfrage beim Menschen. Danach sichert es
   `config.toml` als `config.toml.bak-JJJJ-MM-TT-HHMM` (nur wenn sich etwas ändert; die Sicherung
   enthält einen eventuell eingetragenen Key, also nicht weitergeben) und ergänzt:
   - `[providers.anthropic]` mit `api_key_env`, falls der Block fehlt (ein vorhandener Block mit
     Key bleibt bis auf `base_url` bytegleich),
   - `base_url = "http://127.0.0.1:37790"` im Provider-Block,
   - die 17 Claude-Modellblöcke aus `setup/modelle.toml`, je Block nur wenn er fehlt,
   - die drei `[[hooks]]` (SessionStart, SessionEnd, SubagentStop) mit absolutem Node-Pfad und
     absolutem Klon-Pfad, `timeout = 5`. Eigene Hooks erkennt es am Skriptnamen
     (`hooks/session-start.mjs`, `hooks/session-ereignis.mjs`); veraltete Einträge (anderer
     Node-Pfad, anderer Klon-Ort, Duplikate, ein alter SessionHeartbeat-Hook) ersetzt es durch
     die drei aktuellen.

   Es meldet `default_model`, ändert es aber nicht. Schreibzugriffe auf `config.toml` und
   `installed.json` laufen atomar über eine Tempdatei. `--cu-win` schaltet das Plugin `kimi-cu-win` in `~/.kimi-code/plugins/installed.json`
   ein (mit Sicherung), falls es installiert ist. Ein zweiter Lauf ändert nichts.
4. **Rauchtest**: Die Antwort muss `OK` enthalten. Scheitert er mit einem Verbindungsfehler, läuft
   der Vermittler nicht (`node vermittler.mjs start`); mit 401, fehlt oder stimmt der Key (Mensch
   fragen).
5. **Status** und die letzte Protokollzeile zeigen, ohne weitere Inhalte:

   ```
   node vermittler.mjs status
   node vermittler.mjs bericht --tage 1
   ```

   Erwartung für Haiku im Modus `ttl1h`: `cache_w1h > 0` in der Zeile `art: "anfrage"` von
   `protokoll.jsonl` (die Datei enthält keine Inhalte und keine Keys; die letzte Zeile darf
   gezeigt werden).

## Rückweg

```
node setup/setup.mjs rueckweg
```

Entfernt die `base_url`-Zeile (nur wenn sie auf Loopback zeigt) und alle eigenen Hooks (jeden Klon-Orts),
stoppt den Dienst und sichert `config.toml` vorher. Provider- und Modellblöcke bleiben, sie
schaden nicht. Danach spricht Kimi wieder direkt mit Anthropic (5 min Cache-Haltezeit).

## Rote Linien

- Keine Keys schreiben, lesen, ausgeben oder protokollieren (siehe oben).
- In `config.toml` nur das ändern, was `setup.mjs einrichten` ändert. Keine Handarbeit an fremden
  Abschnitten (Kimi-, GLM-, mneme-, Thinking-Blöcke).
- `default_model` nur auf ausdrückliche Anweisung des Menschen ändern.
- Port 37790 nicht für etwas anderes verwenden; belegt ihn ein fremder Dienst, melden.
- Keine Tests ändern, um sie grün zu bekommen.

## Bekannte Stolpersteine

- **Windows-Pfade:** In `config.toml` stehen Pfade als `C:/…` mit Vorwärtsschrägstrichen. Nie
  Git-Bash-Pfade wie `/c/Users/…` eintragen; Kimi startet die Hooks nicht über Git Bash.
  `setup.mjs` nimmt die Pfade aus `process.execPath` und dem Klon-Ordner und rechnet sie selbst um.
- **Hooks laufen nur, wenn sie registriert sind.** Ohne die drei Hooks startet der Vermittler
  nicht von selbst (dann `node vermittler.mjs start`). `pruefen` zeigt `Hooks vorhanden (3/3)`.
- **Kein `SessionHeartbeat`-Hook (Kimi 2.3.0):** Kimi lehnt das Ereignis beim Schreiben der
  `config.toml` ab; `kimi login`, Provider- und Modellwechsel scheitern dann mit `config.invalid`,
  während `kimi doctor` die Datei als gültig meldet. Meldet `pruefen` eine `Altlast`, `einrichten`
  ausführen (eigener Eintrag) oder den fremden Eintrag vom Menschen entfernen lassen. Das
  Lebenszeichen für den Modus `ping` liest der Vermittler selbst aus Kimis Session-Lockdatei.
- **Node-Update oder Umzug des Klons:** `node setup/setup.mjs einrichten` erneut ausführen; es
  ersetzt die alten Hook-Einträge selbst.
- **Claude bis 4.5 mit `effort` `max`:** Kimi 2.3.0 schickt dort kein Denkbudget (API-400
  „budget_tokens: Field required“); der Vermittler ergänzt es (T3, README). Direkt an Anthropic
  ohne Vermittler bleiben diese Modelle bei `effort = "max"` defekt.
- **`/secondary-model` oder andere Änderungen am Secondary-Pool in `config.toml`** ändern die
  Tool-Beschreibung laufender Sessions; die API lehnt danach deren alte Thinking-Blöcke mit 400 ab.
  Der Vermittler wiederholt dann einmal mit `drop_block` (T4, README). Ohne Vermittler sind diese
  Sessions verloren; Zurückstellen der Config rettet sie nicht verlässlich.
- **`kimi-cu-win`** kostet etwa 5.300 Tokens Grundlast je Anfrage. Nur mit `--cu-win` einschalten,
  wenn der Mensch es will.
- **Code-Update:** Nach einem `git pull` mit neuer Version erneuert der SessionStart-Hook den
  laufenden Dienst beim nächsten Kimi-Start selbst; sofort geht es mit `node vermittler.mjs restart`.
- **Opus 5.5, Sonnet 5.5, Fable 5 und Fable 5.1** brauchen `always_thinking` in ihrem
  Modellblock, sonst antwortet die API mit 400. `setup/modelle.toml` enthält das; vorhandene
  Blöcke gleichen Namens überschreibt das Setup nicht. Fehlt es dort, den Menschen fragen.
