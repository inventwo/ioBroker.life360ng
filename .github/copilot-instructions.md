# ioBroker Adapter-Entwicklung mit GitHub Copilot

Diese Datei enthält Anweisungen und Best Practices für GitHub Copilot bei der Entwicklung von ioBroker-Adaptern.

---

## 📑 Inhaltsverzeichnis

1. [Projektkontext](#projektkontext)
2. [Codequalität & Standards](#codequalität--standards)
   - [Code-Style-Richtlinien](#code-style-richtlinien)
   - [ESLint-Konfiguration](#eslint-konfiguration)
3. [Testing](#testing)
   - [Unit Tests](#unit-tests)
   - [Integrationstests](#integrationstests)
   - [API-Tests mit Zugangsdaten](#api-tests-mit-zugangsdaten)
4. [Entwicklungs-Best-Practices](#entwicklungs-best-practices)
   - [Abhängigkeiten verwalten](#abhängigkeiten-verwalten)
   - [HTTP-Client-Bibliotheken](#http-client-bibliotheken)
   - [Fehlerbehandlung](#fehlerbehandlung)
5. [Admin-UI-Konfiguration](#admin-ui-konfiguration)
   - [JSON-Config-Setup](#json-config-setup)
   - [Übersetzungsverwaltung](#übersetzungsverwaltung)
6. [Dokumentation](#dokumentation)
   - [README-Aktualisierungen](#readme-aktualisierungen)
   - [Changelog-Verwaltung](#changelog-verwaltung)
7. [CI/CD & GitHub Actions](#cicd--github-actions)
   - [Workflow-Konfiguration](#workflow-konfiguration)
   - [Test-Integration](#test-integration)
8. [Workflow-Regeln](#workflow-regeln)
9. [life360ng-Spezifische Muster](#life360ng-spezifische-coding-muster)

---

## Projektkontext

Du arbeitest an einem ioBroker-Adapter. ioBroker ist eine Integrationsplattform für das Internet der Dinge, die auf Smart-Home- und industrielle IoT-Lösungen ausgerichtet ist. Adapter sind Plugins, die ioBroker mit externen Systemen, Geräten oder Diensten verbinden.

Dieser Adapter verbindet ioBroker mit dem [Life360](https://www.life360.com)-Cloud-Dienst für Familien-Standortverfolgung und Geo-Präsenzerkennung. Er ist ein Community-Fork des ursprünglichen `ioBroker.life360`-Adapters, umbenannt in `life360ng` (next generation).

**Hauptmerkmale:**
- Nur Token-basierte Authentifizierung (kein Passwort-/Telefon-Login — Life360 hat dies für EU-Nutzer deaktiviert)
- Abfrage der Life360-REST-API in einem konfigurierbaren Intervall mit nativem Node.js `https`
- Unterstützt Life360-Circles, Mitglieder, Orte und Geo-Präsenzerkennung
- Unterstützt benutzerdefinierte private Orte (für die Life360-Cloud nicht sichtbar), die in der Adapter-Konfiguration definiert werden
- Leitet optional Standortdaten an den ioBroker-`places`-Adapter weiter
- Verwendet `jsonConfig` für die Admin-UI (kein kompiliertes React-Frontend)
- In reinem JavaScript geschrieben (kein TypeScript-Kompilierungsschritt)
- EU-Nutzer benötigen einen Bearer-Token, der manuell über die Browser-DevTools ermittelt wird
- Verbindungstyp: Cloud / Poll
- Hauptdateien: `main.js` (Adapter), `lib/life360CloudConnector.js` (API), `lib/life360DbConnector.js` (State-Verwaltung), `lib/iobHelpers.js` (Hilfsfunktionen)

---

## Codequalität & Standards

### Code-Style-Richtlinien

- JavaScript Best Practices befolgen
- Für asynchrone Operationen `async/await` verwenden
- In der `unload()`-Methode ordentlich aufräumen (Ressourcen freigeben)
- Semantische Versionierung für Adapter-Releases verwenden
- JSDoc-Kommentare für öffentliche Methoden einbinden

**Beispiel für Timer- und Ressourcen-Bereinigung:**
```javascript
private connectionTimer?: NodeJS.Timeout;

async onReady() {
  this.connectionTimer = setInterval(() => this.checkConnection(), 30000);
}

onUnload(callback) {
  try {
    if (this.connectionTimer) {
      clearInterval(this.connectionTimer);
      this.connectionTimer = undefined;
    }
    callback();
  } catch (e) {
    callback();
  }
}
```

### ESLint-Konfiguration

**KRITISCH:** ESLint-Validierung muss in der CI/CD-Pipeline ZUERST laufen, vor allen anderen Tests. Dieser „Lint-First"-Ansatz erkennt Code-Qualitätsprobleme früh.

#### Setup
```bash
npm install --save-dev eslint @iobroker/eslint-config
```

#### Konfiguration (.eslintrc.json)
```json
{
  "extends": "@iobroker/eslint-config",
  "rules": {
    // Projektspezifische Regelüberschreibungen hier einfügen
  }
}
```

#### Package.json-Skripte
```json
{
  "scripts": {
    "lint": "eslint --max-warnings 0 .",
    "lint:fix": "eslint . --fix"
  }
}
```

#### Best Practices
1. ✅ ESLint nach jeder Änderung ausführen — ALLE Warnungen beheben, nicht nur Fehler
2. ✅ `lint:fix` für automatisch behebbare Probleme verwenden
3. ✅ Regeln nicht ohne Dokumentation deaktivieren
4. ✅ Alle relevanten Dateien linten (Hauptcode, Tests, Build-Skripte)
5. ✅ `@iobroker/eslint-config` aktuell halten
6. ✅ **ESLint-Warnungen werden in CI als Fehler behandelt** (`--max-warnings 0`). Das `lint`-Skript enthält dieses Flag bereits — `npm run lint` lokal ausführen, um CI-Verhalten zu reproduzieren

#### Häufige Probleme
- **Ungenutzte Variablen**: Entfernen oder mit Unterstrich prefixen (`_variable`)
- **Fehlende Semikolons**: `npm run lint:fix` ausführen
- **Einrückung**: 4 Leerzeichen (ioBroker-Standard)
- **console.log**: Durch `adapter.log.debug()` ersetzen oder entfernen

---

## Testing

### Unit Tests

- Jest als primäres Test-Framework verwenden
- Tests für alle Adapter-Hauptfunktionen und Hilfsmethoden erstellen
- Fehlerbehandlungsszenarien und Grenzfälle testen
- Externe API-Aufrufe und Hardware-Abhängigkeiten mocken
- Für Adapter, die sich mit APIs/Geräten verbinden, die nicht über das Internet erreichbar sind, Beispieldatendateien bereitstellen

**Beispielstruktur:**
```javascript
describe('AdapterName', () => {
  let adapter;
  
  beforeEach(() => {
    // Test-Adapter-Instanz aufsetzen
  });
  
  test('should initialize correctly', () => {
    // Adapter-Initialisierung testen
  });
});
```

### Integrationstests

**KRITISCH:** Das offizielle `@iobroker/testing`-Framework verwenden. Dies ist der EINZIG korrekte Weg, ioBroker-Adapter zu testen.

**Offizielle Dokumentation:** https://github.com/ioBroker/testing

#### Framework-Struktur

**✅ Korrektes Muster:**
```javascript
const path = require('path');
const { tests } = require('@iobroker/testing');

tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Test adapter with specific configuration', (getHarness) => {
            let harness;

            before(() => {
                harness = getHarness();
            });

            it('should configure and start adapter', function () {
                return new Promise(async (resolve, reject) => {
                    try {
                        const obj = await new Promise((res, rej) => {
                            harness.objects.getObject('system.adapter.your-adapter.0', (err, o) => {
                                if (err) return rej(err);
                                res(o);
                            });
                        });
                        
                        if (!obj) return reject(new Error('Adapter object not found'));

                        Object.assign(obj.native, {
                            position: '52.520008,13.404954',
                            createHourly: true,
                        });

                        harness.objects.setObject(obj._id, obj);
                        
                        await harness.startAdapterAndWait();
                        await new Promise(resolve => setTimeout(resolve, 15000));

                        const stateIds = await harness.dbConnection.getStateIDs('your-adapter.0.*');
                        
                        if (stateIds.length > 0) {
                            console.log('✅ Adapter successfully created states');
                            await harness.stopAdapter();
                            resolve(true);
                        } else {
                            reject(new Error('Adapter did not create any states'));
                        }
                    } catch (error) {
                        reject(error);
                    }
                });
            }).timeout(40000);
        });
    }
});
```

#### Wichtige Regeln

1. ✅ `@iobroker/testing`-Framework verwenden
2. ✅ Konfiguration über `harness.objects.setObject()` vornehmen
3. ✅ Start über `harness.startAdapterAndWait()`
4. ✅ States über `harness.states.getState()` verifizieren
5. ✅ Ausreichende Timeouts für asynchrone Operationen einplanen
6. ❌ API-URLs NIEMALS direkt testen
7. ❌ Das Harness-System NIEMALS umgehen

#### Workflow-Abhängigkeiten

Integrationstests sollen NUR nach bestandenen Lint- und Adapter-Tests ausgeführt werden:

```yaml
integration-tests:
  needs: [check-and-lint, adapter-tests]
  runs-on: ubuntu-22.04
```

### API-Tests mit Zugangsdaten

Für Adapter, die sich mit externen APIs mit Authentifizierung verbinden:

#### Passwort-Verschlüsselung für Integrationstests

```javascript
async function encryptPassword(harness, password) {
    const systemConfig = await harness.objects.getObjectAsync("system.config");
    if (!systemConfig?.native?.secret) {
        throw new Error("Could not retrieve system secret for password encryption");
    }
    const secret = systemConfig.native.secret;
    let result = '';
    for (let i = 0; i < password.length; ++i) {
        result += String.fromCharCode(secret[i % secret.length].charCodeAt(0) ^ password.charCodeAt(i));
    }
    return result;
}
```

---

## Entwicklungs-Best-Practices

### Abhängigkeiten verwalten

- Immer `npm` für die Paketverwaltung verwenden
- `npm ci` für das Installieren bestehender Abhängigkeiten (respektiert package-lock.json)
- `npm install` nur beim Hinzufügen oder Aktualisieren von Abhängigkeiten
- Abhängigkeiten minimal und fokussiert halten
- Abhängigkeiten nur in separaten Pull Requests aktualisieren

**Beim Ändern von package.json:**
1. `npm install` ausführen, um package-lock.json zu synchronisieren
2. package.json und package-lock.json zusammen committen

**Best Practices:**
- Eingebaute Node.js-Module bevorzugen, wenn möglich
- `@iobroker/adapter-core` für Adapter-Basisfunktionalität verwenden
- Veraltete Pakete vermeiden
- Spezifische Versionsanforderungen dokumentieren

### HTTP-Client-Bibliotheken

- **Bevorzugt:** Natives `node:https`-Modul (wie bereits im Adapter implementiert)
- **Vermeiden:** `axios`, `request` oder andere HTTP-Bibliotheken

**Beispiel mit node:https:**
```javascript
const https = require('node:https');

function apiRequest(options) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 401) {
                    reject(new Error('Token expired'));
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}
```

**Weitere Empfehlungen:**
- **Logging:** Adapter-eingebautes Logging verwenden (`this.log.*`)
- **Scheduling:** Adapter-eingebaute Timer und Intervalle verwenden
- **Dateioperationen:** Node.js `fs/promises` verwenden
- **Konfiguration:** Adapter-Konfigurationssystem verwenden

### Fehlerbehandlung

- Fehler immer abfangen und angemessen protokollieren
- Adapter-Log-Level verwenden (error, warn, info, debug)
- Aussagekräftige, benutzerfreundliche Fehlermeldungen bereitstellen
- Netzwerkausfälle sauber behandeln
- Timer, Intervalle und Ressourcen immer in der `unload()`-Methode bereinigen

**Beispiel:**
```javascript
try {
  await this.connectToDevice();
} catch (error) {
  this.log.error(`Failed to connect to device: ${error.message}`);
  this.setState('info.connection', false, true);
}
```

---

## Admin-UI-Konfiguration

### JSON-Config-Setup

JSON-Config-Format für moderne ioBroker-Admin-Oberflächen verwenden.

**Beispielstruktur:**
```json
{
  "type": "panel",
  "items": {
    "host": {
      "type": "text",
      "label": "Host address",
      "help": "IP address or hostname of the device"
    }
  }
}
```

**Richtlinien:**
- ✅ Konsistente Namenskonventionen verwenden
- ✅ Sinnvolle Standardwerte bereitstellen
- ✅ Validierung für Pflichtfelder einbauen
- ✅ Tooltips für komplexe Optionen hinzufügen
- ✅ Übersetzungen mindestens für Englisch und Deutsch pflegen
- ✅ Benutzerfreundliche Labels schreiben, technischen Jargon vermeiden

### Übersetzungsverwaltung

**KRITISCH:** Übersetzungsdateien müssen mit `admin/jsonConfig.json` synchron bleiben. Verwaiste Keys oder fehlende Übersetzungen verursachen UI-Probleme.

#### Manuell zu pflegende Übersetzungen

**WICHTIG:** Nur `de.json` und `en.json` werden manuell gepflegt!

- `admin/i18n/de.json` — Deutsch **(manuell pflegen)**
- `admin/i18n/en.json` — Englisch **(manuell pflegen)**
- Alle anderen Sprachen (`es`, `fr`, `it`, `nl`, `pl`, `pt`, `ru`, `uk`, `zh-cn`) werden automatisch per `npm run translate` (translate-adapter) generiert und sollen **nicht** manuell bearbeitet werden
- `npm run translate` wird **vom Eigentümer manuell ausgeführt** — GitHub Copilot führt diesen Befehl nicht aus

#### Workflow bei Änderungen an admin/jsonConfig.json

GitHub Copilot erledigt:
1. Neue Keys in `admin/i18n/de.json` auf Deutsch hinzufügen
2. Neue Keys in `admin/i18n/en.json` auf Englisch hinzufügen
3. Verwaiste Keys aus `de.json` und `en.json` entfernen, wenn ein Key aus `jsonConfig.json` entfernt wird

Der Eigentümer führt anschließend manuell aus:
4. `npm run translate` — generiert alle anderen Sprachen automatisch
5. `npm run release` — veröffentlicht die neue Version

#### Wichtige Regeln
1. ✅ Keys müssen exakt mit denen in `jsonConfig.json` übereinstimmen
2. ✅ Keine verwaisten Keys in den manuell gepflegten Dateien
3. ✅ Nur `de.json` und `en.json` manuell bearbeiten
4. ✅ Alle anderen Sprachen per `npm run translate` generieren lassen (Eigentümer)
5. ✅ Keys alphabetisch sortiert

#### Übersetzungs-Checkliste

Vor dem Committen von Admin-UI- oder Übersetzungsänderungen (durch GitHub Copilot):
1. ✅ Neue Keys in `de.json` auf Deutsch eingetragen
2. ✅ Neue Keys in `en.json` auf Englisch eingetragen
3. ✅ Keine verwaisten Keys in `de.json` oder `en.json`
4. ✅ `npm run lint` bestanden
5. ✅ Admin-UI wird korrekt angezeigt

Anschließend vom Eigentümer:
6. `npm run translate` ausführen
7. `npm run release` ausführen

---

## Dokumentation

### README-Aktualisierungen

**PFLICHT:** Die `README.md` muss vollständig auf **Englisch** verfasst sein — das ist eine verbindliche ioBroker-Vorgabe. Kein Inhalt in `README.md` darf auf Deutsch oder einer anderen Sprache geschrieben werden. Deutschsprachige Inhalte gehören ausschließlich in `docs/de/`.

#### Pflichtabschnitte
1. **Installation** — Clear npm/ioBroker admin installation steps
2. **Configuration** — Detailed configuration options with examples
3. **Usage** — Practical examples and use cases
4. **Changelog** — Version history (use `### **WORK IN PROGRESS**` for ongoing changes)
5. **License** — License information (typically MIT for ioBroker adapters)
6. **Support** — Links to issues, discussions, community support

#### Dokumentationsstandards
- `README.md` ausschließlich auf Englisch schreiben (ioBroker-Pflicht)
- Klare, prägnante Sprache verwenden
- Code-Beispiele für die Konfiguration einbinden
- Screenshots für die Admin-Oberfläche hinzufügen, wenn sinnvoll
- Issues in Commits und PRs immer referenzieren (z. B. „fixes #xx")

#### Pflicht: Dokumentation bei neuen Features und Konfigurationsänderungen

**Bei jedem neuen Feature oder jeder Änderung an der Admin-Konfiguration MÜSSEN folgende Dateien aktualisiert werden:**

1. `docs/en/` — Englische Dokumentation anpassen
2. `docs/de/` — Deutsche Dokumentation anpassen
3. `README.md` — Hauptdokumentation aktualisieren

Ohne diese Aktualisierungen ist ein Feature nicht vollständig! Die Dokumentation muss den tatsächlichen Zustand der Konfigurationsoberfläche und Funktionalität widerspiegeln.

#### Pflicht: Changelog-Eintrag bei jeder Codeänderung

**Bei jedem Fix oder neuen Feature MUSS ein Eintrag unter `### **WORK IN PROGRESS**` in `README.md` hinzugefügt werden:**

- Format: `- (author) Klare, benutzerfreundliche Beschreibung der Änderung`
- **KEINE fettgedruckten Präfixe** wie `**FIXED**`, `**NEW**` usw. — nur einfacher Text
- Grund: Das `io-package.json`-News-Übersetzungsskript bricht bei Markdown-Fettschrift in Changelog-Einträgen
- Auf Auswirkung für den Benutzer fokussieren, nicht auf technische Details
- Changelog-Einträge grundsätzlich in englisch

**Beispiel:**
```markdown
### **WORK IN PROGRESS**

- (skvarel) Added optional map legend footer to tracker maps showing start, waypoint, current position markers and map size
- (skvarel) Switched HTML maps to bilingual - english and german
```

### Changelog-Verwaltung

Folgt dem [AlCalzone release-script](https://github.com/AlCalzone/release-script)-Standard.

#### Format-Anforderungen

```markdown
# Changelog

<!--
  Placeholder for the next version (at the beginning of the line):
  ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- (author) Neues Feature X hinzugefügt
- (author) Bug Y behoben (fixes #25)

### 1.0.2 (2026-04-11)
- (author) HTTP-Anfragen von veraltetem Paket migriert
- (author) Ungenutzte Abhängigkeiten entfernt
```

#### Workflow-Ablauf
- **Während der Entwicklung:** Alle Änderungen kommen unter `### **WORK IN PROGRESS**`
- **Bei jedem Fix oder Feature:** Changelog-Eintrag unter WORK IN PROGRESS hinzufügen — **immer, ohne Ausnahme**
- **Release-Prozess:** Das Release-Script wandelt den Platzhalter automatisch in die tatsächliche Version um
- Changelog-Einträge grundsätzlich in englisch

#### Format für Änderungseinträge
- Format: `- (author) Beschreibung ohne fettgedruckte Präfixe`
- **NIEMALS fettgedruckte Tags** wie `**FIXED**`, `**NEW**`, `**ENHANCED**` in Changelog-Einträgen verwenden
- Grund: `io-package.json`-News-Übersetzungsskript bricht bei Markdown-Fettschrift
- Auf Auswirkung für den Benutzer fokussieren, nicht auf technische Implementierung
- Issues referenzieren: „fixes #XX" oder „solves #XX"
- Changelog-Einträge grundsätzlich in englisch

---

## CI/CD & GitHub Actions

### Workflow-Konfiguration

#### GitHub Actions Best Practices

**Offizielle ioBroker-Test-Actions müssen verwendet werden:**
- `ioBroker/testing-action-check@v1` für Lint und Paketvalidierung
- `ioBroker/testing-action-adapter@v1` für Adapter-Tests
- `ioBroker/testing-action-deploy@v1` für automatisierte Releases mit Trusted Publishing (OIDC)

**Konfiguration:**
- **Node.js-Versionen:** Auf 22.x, 24.x testen
- **Plattform:** ubuntu-22.04 verwenden
- **Automatische Releases:** Auf npm bei Version-Tags deployen (erfordert NPM Trusted Publishing)

#### Kritisch: Lint-First-Validierungsworkflow

**ESLint-Checks immer VOR anderen Tests ausführen.** Vorteile:
- Erkennt Code-Qualitätsprobleme sofort
- Verhindert, dass CI-Ressourcen für Tests verschwendet werden, die wegen Lint-Fehlern scheitern würden
- Schnelleres Feedback für Entwickler

**Workflow-Abhängigkeitskonfiguration:**
```yaml
jobs:
  check-and-lint:
    # Führt ESLint und Paketvalidierung durch
    # Verwendet: ioBroker/testing-action-check@v1
    
  adapter-tests:
    needs: [check-and-lint]
    
  integration-tests:
    needs: [check-and-lint, adapter-tests]
```

**Wichtige Punkte:**
- Der `check-and-lint`-Job hat KEINE Abhängigkeiten — läuft als erstes
- ALLE anderen Test-Jobs MÜSSEN `check-and-lint` in ihrem `needs`-Array auflisten
- Wenn Linting fehlschlägt, laufen keine anderen Tests, was Zeit spart

### Test-Integration

#### Testing Best Practices
- Zugangsdaten-Tests getrennt von der Haupt-Test-Suite ausführen
- Zugangsdaten-Tests nicht als Pflicht für das Deployment machen
- Klare Fehlermeldungen für API-Probleme bereitstellen
- Angemessene Timeouts für externe Aufrufe verwenden (120+ Sekunden)

---

## Workflow-Regeln

Diese Regeln gelten absolut und dürfen nicht umgangen werden.

### ❌ Kein Commit und kein Push

**NIEMALS `git commit`, `git push` oder `git add` mit anschließendem Commit ausführen!**

Das Committen und Pushen von Änderungen übernimmt ausschließlich der Eigentümer manuell über das Release Script. GitHub Copilot darf:
- Dateien bearbeiten und erstellen ✅
- Lint- und Test-Befehle ausführen ✅
- Code-Änderungen vorschlagen und umsetzen ✅

GitHub Copilot darf **nicht**:
- `git commit` ausführen ❌
- `git push` ausführen ❌
- `git add` mit anschließendem Commit ausführen ❌
- Das Release-Script aufrufen ❌
- `npm run translate` ausführen ❌ (macht der Eigentümer manuell vor dem Release)

### ✅ Lint nach jeder Änderung

**Nach JEDER Codeänderung `npm run lint` ausführen und alle Warnungen sowie Fehler beheben.**

```bash
npm run lint
```

Wenn Fehler auftreten:
1. Automatisch behebbare Fehler mit `npm run lint:fix` korrigieren
2. Verbleibende Fehler manuell beheben
3. Erneut `npm run lint` ausführen, bis keine Fehler mehr angezeigt werden

**Lint-Fehler dürfen nicht ignoriert werden.** In CI gilt `--max-warnings 0`, d. h. auch Warnungen werden als Fehler behandelt.

### ✅ Changelog bei jeder Codeänderung

**Bei jedem Fix oder neuen Feature einen Eintrag unter `### **WORK IN PROGRESS**` in `README.md` anlegen.**

- Format: `- (skvarel) Beschreibung der Änderung`
- Keine fettgedruckten Präfixe (`**FIXED**` usw.)
- Benutzerfreundlich formulieren, auf Auswirkung fokussieren

### ✅ Dokumentation bei neuen Features und Konfigurationsänderungen

**Bei neuen Features oder Änderungen an der Admin-Konfiguration immer aktualisieren:**
- `docs/en/` — Englische Dokumentation
- `docs/de/` — Deutsche Dokumentation
- `README.md` — Hauptdokumentation

---

## life360ng-Spezifische Coding-Muster

### Modul-Architektur
- `lib/life360CloudConnector.js` — Gesamte Life360-API-Kommunikation; verwendet `setInterval` für Polling (mit `clearInterval`, nicht `clearTimeout` stoppen)
- `lib/life360DbConnector.js` — Erstellt und aktualisiert ioBroker-States/Objekte aus Life360-Daten
- `lib/iobHelpers.js` — Gemeinsame Hilfsfunktionen (Logging, State-Helfer)
- `main.js` — Adapter-Einstiegspunkt; verbindet die Connectoren über Callbacks

### API-Kommunikation
- Natives `node:https` für alle HTTP-Anfragen verwenden (kein axios, kein request-Paket)
- Life360-API-Basis-URL: `https://api.life360.com/v3/`
- Alle Anfragen benötigen den `Authorization: Bearer <token>`-Header
- HTTP-401-Antworten als Token-Ablauf behandeln — `info.connection` auf `false` setzen und eine Warnung loggen
- Fehlgeschlagene Anfragen nicht in einer engen Schleife wiederholen; auf das nächste Poll-Intervall verlassen

### Polling
- Polling wird durch `setInterval` in `life360CloudConnector.js` verwaltet
- Immer `clearInterval` (nicht `clearTimeout`) zum Stoppen des Pollings in `disablePolling()` verwenden
- Das Poll-Intervall ist in der Adapter-Konfiguration einstellbar (`pollInterval` in Sekunden)

### Benutzerdefinierte Orte (Custom Places)
- Benutzerdefinierte Orte werden in `admin/jsonConfig.json` als Tabelle im `_myplaces`-Tab definiert
- Präsenzprüfung für benutzerdefinierte Orte verwendet die Haversine-Formel gegen Lat/Lon der Person
- Benutzerdefinierte Orte haben Priorität gegenüber Life360-Cloud-Orten in `locationName`

### State-Benennung
- Personen-States: `life360ng.<instance>.people.<name>.<state>`
- Orts-States: `life360ng.<instance>.places.<name>.<state>`
- Verbindungs-State: `life360ng.<instance>.info.connection`

### jsonConfig Admin-UI
- Config-Datei: `admin/jsonConfig.json` (kein kompiliertes React)
- Bilder: In `admin/img/` gespeichert und als `img/<filename>` in `staticImage`-Elementen referenziert
- Übersetzungen: Nur `admin/i18n/de.json` und `admin/i18n/en.json` manuell pflegen; alle anderen Sprachen generiert der Eigentümer per `npm run translate` vor dem Release
