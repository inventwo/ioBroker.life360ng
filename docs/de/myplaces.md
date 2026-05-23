![Logo](../../admin/Life360ng.svg)
### The Next Generation
[zurück zur Startseite](README.md)

# Tab: Meine Orte

Im Tab **Meine Orte** kannst du eigene, private Orte definieren, die unabhängig von den Life360-Cloud-Orten funktionieren.

**Funktionen:**

- Lege beliebig viele Orte mit Name, Breiten- und Längengrad sowie Radius fest.
- Die Orte werden für die Anwesenheitserkennung und Automatisierungen im ioBroker genutzt.
- Orte aus Life360 und eigene Orte können parallel verwendet werden.

**Tabelle:**
- **Name:** Frei wählbarer Name für den Ort (z. B. „Zuhause“, „Arbeit“)
- **Breitengrad / Längengrad:** Koordinaten des Ortes (z. B. aus Google Maps kopieren)
- **Radius:** Umkreis in Metern, in dem eine Person als „anwesend“ gilt
- **Circle:** (optional) Zuordnung zu einem Life360-Kreis

**Hinweis:**
Eigene Orte sind nur lokal im ioBroker sichtbar und werden nicht an Life360 übertragen.

> **Life360-Orte nicht verfügbar?**
> Life360 hat den Zugriff auf Cloud-Orte über die API für bestimmte Accounts eingeschränkt — insbesondere EU-Accounts im Free-Tier. Wenn im Adapter-Log `All place sources returned 0 places` erscheint, liefert Life360 die Orte über keinen API-Endpunkt mehr aus.
> **Lösung:** Lege deine wichtigen Orte als **Meine Orte** in diesem Tab an. Sie funktionieren unabhängig von Life360 und bieten dieselbe Anwesenheitserkennung.
