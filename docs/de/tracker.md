![Logo](../../admin/Life360ng.svg)
### The Next Generation
[zurück zur Startseite](README.md)

# Tab: Fahrtenbuch


## Fahrtenbuch- und Kartenfunktionen

Der ioBroker life360ng Adapter bietet umfassende Fahrtenbuch- und Kartenfunktionen für jede getrackte Person:

- **Individuelle Karten für jede Person:** Für jede Person mit aktiviertem Tracking steht eine eigene Karte zur Verfügung, die die gefahrenen Routen (GeoJSON-basiert) und die aktuelle Position anzeigt.
- **Familienkarte:** Zusätzlich gibt es eine Familienkarte, die die Routen aller aktivierten Personen gemeinsam darstellt.
- **Farbanpassung:** Farben und Aussehen der Karten (z.B. Hintergrund, Linienbreite, Deckkraft) können über die Config individuell angepasst werden.
- **Integrierter Datepicker:** Im Karten-HTML ist ein Kalender integriert, mit dem gezielt ein Tag ausgewählt werden kann, um die Route dieses Tages anzuzeigen.
- **Flexible Einbindung:** Die Karten können direkt im Browser geöffnet oder als iframe in Visualisierungen (z.B. ioBroker VIS) eingebunden werden.

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
- **Zugriff:** Die URL zur Familienkarte findest du unter `life360ng.<instanz>.tracker.<familienname>.url`.

### 3. Farbeinstellungen
Die Kartenfarben und das Aussehen der Linien lassen sich individuell anpassen. Die Einstellungen findest du in der Adapter Config:

- Hintergrundfarbe der Karte
- Hintergrundfarbe des Kartenkopfs
- Rahmenfarbe des Kartenkopfs
- Textfarbe im Kartenkopf
- Linienbreite der Route (Pixel)
- Deckkraft der Route (0–1)

**Hinweis:** Änderungen an diesen Werten werden nach dem eingestelltem auf alle Karten angewendet.

### 4. Datepicker
Im Karten-HTML ist ein Datepicker integriert. Damit kannst du gezielt einen Tag auswählen, um die Route für diesen Tag anzuzeigen. Standardmäßig wird die aktuelle Route angezeigt. Der Datepicker ist besonders hilfreich, um Bewegungen an bestimmten Tagen nachzuvollziehen.

---
**Tipp:** Die Karten können direkt im Browser geöffnet oder in Visualisierungen (z.B. ioBroker VIS als iframe) eingebunden werden.

---

## Datenverwaltung

Die Routendaten (`allTime.geojson`) wachsen mit der Zeit an. Der Adapter bietet zwei Wege, die Dateigrößen im Griff zu behalten:

### Automatische Bereinigung (Aufbewahrungsdauer)

Unter **Allgemein → Aufbewahrung (Tage)** kannst du festlegen, wie viele Tage Routendaten gespeichert bleiben sollen. Ältere Tage werden automatisch beim Adapterstart und einmal täglich entfernt. Der Wert `0` bedeutet unbegrenzte Aufbewahrung.

### Manuelle Bereinigung einzelner Personen

In der **Personen-Tabelle** gibt es die Spalte **„Aufz. leeren"**. Aktiviere den Haken bei einer Person und speichere die Konfiguration. Die `allTime.geojson` dieser Person wird auf den letzten bekannten Standpunkt reduziert.

> ⚠️ Da die Familienkarte aus den Personen-Daten aufgebaut wird, wirkt sich das Leeren einer Person automatisch auch auf die Familienkarte aus.
> Die monatlichen GeoJSON-Dateien (`currentYear.MM`) werden dabei nicht verändert.

