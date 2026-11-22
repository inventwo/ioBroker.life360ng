![Logo](../../admin/Life360ng.svg)
### The Next Generation
[zurück zur Startseite](README.md)

# Tab: Integration

Im Tab **Integration** steuerst du, welche Life360-Daten im Adapter verarbeitet und als ioBroker-Objekte angelegt werden.

**Funktionen:**

- **Kreise, Orte, Personen:** Du kannst einzeln festlegen, ob Life360-Kreise, -Orte und -Personen importiert und synchronisiert werden.
- **Standort-Tracking:** Aktiviere, ob die aktuellen Standorte der Personen laufend aktualisiert werden sollen.
- **Unbekannter Ort:** Definiere einen Namen für Orte, die von Life360 nicht erkannt werden (z. B. „Unbekannt“).

**Kreise und App-Orte aktualisieren:**
Unter **Kreise & App-Orte aktualisieren** legst du fest, wann Kreis- und Ortsdefinitionen aus der Life360-Cloud neu geladen werden:

- **Nur bei Instanz-Neustart** (Standard)
- **Alle X Stunden** (Stundenwert einstellbar)
- **Einmal täglich**

Die Standorte der Personen werden unabhängig davon bei jedem Abfrageintervall aktualisiert. Nach Änderungen in der Life360-App die Instanz neu starten (bei „Nur bei Instanz-Neustart“) oder die nächste automatische Aktualisierung abwarten.

**Hinweis:**
Diese Einstellungen helfen, die Adapter-Objekte und den Datenverkehr auf das Nötigste zu beschränken und die Übersicht zu behalten.
