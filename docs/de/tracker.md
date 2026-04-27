![Logo](../../admin/Life360_xl.svg)
### The Next Generation
[zurück zur Startseite](README.md)

# Tab: Fahrtenbuch

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
Die Kartenfarben und das Aussehen der Linien lassen sich individuell anpassen. Die Einstellungen findest du als beschreibbare Objekte unter `life360ng.<instanz>.tracker.config.color.*`:

- `pageBg`: Hintergrundfarbe der Karte
- `headerBg`: Hintergrundfarbe des Kartenkopfs
- `headerBorder`: Rahmenfarbe des Kartenkopfs
- `headerText`: Textfarbe im Kartenkopf
- `routeWeight`: Linienbreite der Route (Pixel)
- `routeOpacity`: Deckkraft der Route (0–1)

**Hinweis:** Änderungen an diesen Werten werden nach dem eingestelltem auf alle Karten angewendet.

### 4. Datepicker
Im Karten-HTML ist ein Datepicker integriert. Damit kannst du gezielt einen Tag auswählen, um die Route für diesen Tag anzuzeigen. Standardmäßig wird die aktuelle Route angezeigt. Der Datepicker ist besonders hilfreich, um Bewegungen an bestimmten Tagen nachzuvollziehen.

---
**Tipp:** Die Karten können direkt im Browser geöffnet oder in Visualisierungen (z.B. ioBroker VIS als iframe) eingebunden werden.

