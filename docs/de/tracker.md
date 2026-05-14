![Logo](../../admin/Life360ng.svg)
### The Next Generation
[zurück zur Startseite](README.md)

# Tab: Fahrtenbuch


## Fahrtenbuch- und Kartenfunktionen

Der ioBroker life360ng Adapter bietet umfassende Fahrtenbuch- und Kartenfunktionen für jede getrackte Person:

- **Individuelle Karten für jede Person:** Für jede Person mit aktiviertem Tracking steht eine eigene Karte zur Verfügung, die die gefahrenen Routen (GeoJSON-basiert) und die aktuelle Position anzeigt.
- **Familienkarte:** Zusätzlich gibt es eine Familienkarte, die die Routen aller aktivierten Personen gemeinsam darstellt.
- **Integrierter Datepicker:** Im Karten-HTML ist ein Kalender integriert, mit dem gezielt ein Tag ausgewählt werden kann, um die Route dieses Tages anzuzeigen.
- **Flexible Einbindung:** Die Karten können direkt im Browser geöffnet oder als iframe in Visualisierungen (z.B. ioBroker VIS) eingebunden werden.
- **Kartenaussehen:** Farben, Routenstil, Ortsmarkierungen und Layout werden im Tab [Kartendarstellung](../de/mapdisplay.md) konfiguriert.

Alle Details zur Konfiguration und Nutzung findest du weiter unten und in der Adapter-Konfiguration.

## Nutzung der Personenkarte und Familienkarte

Der ioBroker life360ng Adapter bietet zwei Kartentypen zur Visualisierung von Bewegungsdaten:

### 1. Personenkarte
Jede Person, für die das Tracking aktiviert ist, erhält eine eigene Karte. Diese zeigt die gefahrenen Routen als farbige Linien (GeoJSON-basiert) und aktuelle Positionen an.

- **Aktivierung:** Im Adapter unter „Tracker“ die gewünschte Person aktivieren (`enabled`).
- **Eigene Karte:** Die Option `ownMap` steuert, ob für diese Person eine eigene Karte erzeugt wird.
- **Zugriff:** Die Karten-URL findest du im Objektbaum unter `life360ng.<instanz>.tracker.<person>.url`.

### 2. Familienkarte
Die Familienkarte zeigt die Routen aller aktivierten Personen gemeinsam auf einer Karte.

- **Aktivierung:** Im Tracker muss bei mindestens einer Person die Option `familyMap` aktiviert sein.
- **Zugriff:** Die URL zur Kreiskarte findest du unter `life360ng.<instanz>.tracker.circle.url`.

> Alle Einstellungen zum Kartenaussehen (Farben, Routenstil, Ortsmarkierungen, Layout) befinden sich im Tab **[Kartendarstellung](../de/mapdisplay.md)**.

### 3. Datepicker
Im Karten-HTML ist ein Datepicker integriert. Damit kannst du gezielt einen Tag auswählen, um die Route für diesen Tag anzuzeigen. Standardmäßig wird die aktuelle Route angezeigt. Der Datepicker ist besonders hilfreich, um Bewegungen an bestimmten Tagen nachzuvollziehen.

**Hinweis:** Die Optik kann ja nach verwendeten Browser variieren.

#### Standardanzeige (Zeitraum)

Unter **Allgemein → Standardanzeige (Tage)** kannst du festlegen, wie viele Tage beim Öffnen der Karte standardmäßig angezeigt werden.

| Wert | Effekt |
|---|---|
| 1 (Standard) | Nur die Route des aktuellen Tages |
| 2 | Heute und gestern |
| N | Heute und die N−1 vorherigen Tage |

Beim Öffnen der Karte wird das Startdatum immer auf den konfigurierten Wert zurückgesetzt (heute minus N−1 Tage). Eine manuelle Änderung des Datepickers gilt nur für die aktuelle Sitzung.

---

### 4. Hamburger-Menü (☰)

Über das ☰-Symbol oben rechts öffnet sich ein Einstellungsmenü. Die Einstellungen werden pro Karte im Browser-Speicher (sessionStorage) gespeichert und bleiben bis zum Schließen des Tabs erhalten.

| Option | Beschreibung |
|---|---|
| **Route** | Zeigt die gefahrene Route als farbige Linie auf der Karte an. Bei aktivierter Route wird zusätzlich ein Zeitraum-Picker eingeblendet. |
| **Orte** | Zeigt die Life360-Orte als Fähnchen auf der Karte an. |
| **Orte-Radius** | Zeigt den konfigurierten Radius-Kreis um jeden Life360-Ort an. |
| **Eigene Orte** | Zeigt die selbst definierten Orte (Meine Orte) als Fähnchen auf der Karte an. |
| **Eigene Orte-Radius** | Zeigt den Radius-Kreis um jeden eigenen Ort an. |
| **Tageshervorhebung** | Aktiviert die interaktive Tageshervorhebung (siehe unten). |
| **Footer** | Blendet die Legende unterhalb der Karte ein oder aus. |
| **Kartengröße** | Zeigt die aktuelle Kartengröße in der Kopfzeile an. |
| **↻ Neu laden** | Lädt die Karte komplett neu. |

#### Tageshervorhebung

Wenn **Tageshervorhebung** aktiviert ist, können Routen auf der Karte interaktiv hervorgehoben werden:

- **Hover (Maus über eine Linie):** Die Route des Tages wird temporär hervorgehoben – die Linie wird dicker und deckt andere Tage ab. Beim Wegnehmen der Maus wird der normale Zustand wiederhergestellt. Ein Tooltip zeigt das Datum der Route an.
- **Klick auf eine Linie:** Die Hervorhebung wird fixiert. Die Route bleibt aktiv und ein Popup erscheint mit dem Datum (Personenkarte) bzw. Name und Datum (Familienkarte). Ein weiterer Klick auf dieselbe Linie oder ein Klick auf die freie Kartenfläche hebt die Fixierung wieder auf.
- **Klick auf einen Punkt:** Öffnet das Popup dieses Punktes (Start- oder Endpunkt des Tages), ohne die Tageshervorhebung auszulösen.

> **Hinweis:** Sobald eine Route per Klick fixiert ist, wird der Hover-Tooltip auf Linien unterdrückt – die fixierte Ansicht bleibt ungestört.


> Die generierten HTML-, CSS- und JS-Dateien werden im ioBroker-Dateisystem gespeichert und können unter **Admin → Dateien → `life360ng.<instanz>/tracker/`** eingesehen oder verwaltet werden.

---

## Erklärungen zu dem Punkten und Pins auf den Karten

| Art | Grund |
|---|:---|
|Dunkle Punkte: | Startpunkt des Tages|
|Helle Punkte: | Endpunkt des Tages|
|Pin/Marker: | Aktueller Standort|

---

## Datenverwaltung

Die Routendaten (`allTime.geojson`) wachsen mit der Zeit an. Der Adapter bietet zwei Wege, die Dateigrößen im Griff zu behalten:

### Automatische Bereinigung (Aufbewahrungsdauer)

Unter **Allgemein → Aufbewahrung (Tage)** kannst du festlegen, wie viele Tage Routendaten gespeichert bleiben sollen. Ältere Tage werden automatisch beim Adapterstart und einmal täglich entfernt. Der Wert `0` bedeutet unbegrenzte Aufbewahrung.

### Manuelle Bereinigung einzelner Personen

In der **Personen-Tabelle** gibt es die Spalte **„Aufz. leeren"**. Aktiviere den Haken bei einer Person und speichere die Konfiguration. Die `allTime.geojson` dieser Person wird auf den letzten bekannten Standpunkt reduziert.

> ⚠️ Da die Familienkarte aus den Personen-Daten aufgebaut wird, wirkt sich das Leeren einer Person automatisch auch auf die Familienkarte aus.
> Die monatlichen GeoJSON-Dateien (`currentYear.MM`) werden dabei nicht verändert.

