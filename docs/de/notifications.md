![Logo](../../admin/Life360ng.svg)
### The Next Generation
[zurück zur Startseite](README.md)

# Tab: Benachrichtigungen

Im Tab **Benachrichtigungen** konfigurierst du Telegram-Nachrichten und Alexa-Ansagen, die automatisch gesendet werden, wenn eine Life360-Person einen bekannten Ort betritt.

---

## Telegram

Aktiviere oder deaktiviere Telegram-Benachrichtigungen mit dem Schalter **Telegram-Benachrichtigungen aktivieren**.

> **Voraussetzung:** Der [ioBroker Telegram-Adapter](https://github.com/iobroker-community-adapters/ioBroker.telegram) muss installiert und aktiv sein.

---

## Empfängertabelle

Lege hier alle Telegram-Empfänger fest, die Benachrichtigungen erhalten können.

| Spalte | Beschreibung |
|---|---|
| **Instanz** | Instanznummer des Telegram-Adapters (Standard: `0`) |
| **Anzeigename** | Optionale Bezeichnung, um diesen Empfänger in der Personentabelle zu referenzieren |
| **Chat-ID** | Telegram-Chat-ID des Empfängers |

**So findest du die Chat-ID:**  
Öffne den Telegram-Adapter in der ioBroker-Admin-Oberfläche → Tab **Nachrichten**. Nachdem der Nutzer eine Nachricht an deinen Telegram-Bot gesendet hat, erscheint seine Chat-ID in der Liste der authentifizierten Nutzer.

> **Hinweis:** Der Anzeigename ist optional und dient nur als lesbares Label für den Filter in der Personentabelle. Du kannst ihn leer lassen und stattdessen die Chat-ID direkt als Filterwert eintragen.

---

## Alexa

Aktiviere oder deaktiviere Alexa-Ansagen mit dem Schalter **Alexa-Ansagen aktivieren**.

> **Voraussetzung:** Der [ioBroker Alexa2-Adapter](https://github.com/Apollon77/ioBroker.alexa2) muss installiert und aktiv sein.

---

## Alexa-Gerätatabelle

Lege hier alle Echo-Geräte fest, die Standortänderungen ansagen sollen.

| Spalte | Beschreibung |
|---|---|
| **Anzeigename** | Optionale Bezeichnung für das Gerät (z. B. `Büro Echo`) |
| **Speak-State-ID** | Vollständige ioBroker-State-ID des Speak-Datenpunkts (z. B. `alexa2.0.Echo-Devices.G090LF11806218AC.Commands.speak`) |
| **Lautstärke (0–100)** | Ansage-Lautstärke. Der Alexa-Adapter stellt die vorherige Lautstärke danach automatisch wieder her. |

**So findest du die Speak-State-ID:**  
Öffne den ioBroker-Objektbaum → `alexa2.0` → `Echo-Devices` → suche deinen Geräteordner → `Commands` → `speak`. Kopiere die vollständige Objekt-ID.

> **Hinweis:** Bei gesetzter Lautstärke stellt der Alexa2-Adapter die ursprüngliche Lautstärke nach der Ansage automatisch wieder her.

---

## Personentabelle

Diese Tabelle wird **automatisch mit Life360 synchronisiert** — Personen erscheinen hier, sobald sie aus der Life360-Cloud geladen wurden. Es ist keine manuelle Eingabe nötig.

| Spalte | Beschreibung |
|---|---|
| **Life360-Name** | Name der Person aus Life360 (schreibgeschützt, automatisch synchronisiert) |
| **Vorangestellter Text (Eigene Orte)** | Text, der dem Ortsnamen bei Benachrichtigungen zu eigenen Orten vorangestellt wird (z. B. `Nicole ist bei`) |
| **Vorangestellter Text (App-Orte)** | Text, der dem Ortsnamen bei Benachrichtigungen zu Life360-App-Orten vorangestellt wird |
| **Empfänger (nur Telegram)** | Kommaseparierte Liste von Anzeigenamen oder Chat-IDs aus der Empfängertabelle. Leer = an alle Telegram-Empfänger senden. Alexa-Ansagen werden immer an alle konfigurierten Geräte gesendet. |
| **Eigene Orte** | Benachrichtigung aktivieren, wenn diese Person einen eigenen Ort betritt (Meine Orte) |
| **App-Orte** | Benachrichtigung aktivieren, wenn diese Person einen Life360-App-Ort betritt |
| **Unbekannte Orte** | Benachrichtigung aktivieren, wenn der Standort der Person unbekannt wird |
| **Meldung bei unbekanntem Ort** | Benutzerdefinierter Text, der gesendet wird, wenn der Standort der Person unbekannt ist |

### Empfänger-Filter (nur Telegram)

Die Spalte **Empfänger** gilt ausschließlich für Telegram-Benachrichtigungen – auf Alexa-Ansagen hat sie keinen Einfluss. Damit lässt sich festlegen, welche Telegram-Empfänger die Nachricht für eine bestimmte Person erhalten. Alexa-Ansagen werden immer an alle konfigurierten Geräte gesendet.

- **Leer:** Die Benachrichtigung wird an **alle** Empfänger in der Empfängertabelle gesendet.
- **Gefüllt:** Nur die aufgelisteten Empfänger erhalten die Nachricht.

---

## Orts-spezifische Nachrichten-Overrides

Unterhalb der Personentabelle kannst du orts- und personenspezifische Nachrichten-Overrides konfigurieren. Damit lässt sich die Standard-Nachricht (`Vorangestellter Text + Ortsname`) durch einen eigenen Text ersetzen und optional auch eine Nachricht senden, wenn eine Person einen Ort **verlässt**.

| Spalte | Beschreibung |
|---|---|
| **+ Ort** | Ortsname – aus einem Dropdown mit eigenen Orten (⚑) und Life360-App-Orten (📍) auswählbar. Manuelle Eingabe ist ebenfalls möglich. |
| **Person** | Life360-Name der Person – aus einem Dropdown der bekannten Personen auswählbar. Leer lassen = gilt für **alle Personen** an diesem Ort. |
| **Bei Meldung priorisieren** | Wenn aktiviert, wird die Standard-Nachricht (`Vorangestellter Text + Ortsname`) unterdrückt und stattdessen der eigene Ankunfts- oder Entfernen-Text verwendet. |
| **Ankunft melden** | Benachrichtigung senden, wenn die Person diesen Ort betritt. |
| **Text bei Ankunft** | Benutzerdefinierter Text bei Ankunft (z. B. `Nicole ist zuhause angekommen`). |
| **Entfernen melden** | Benachrichtigung senden, wenn die Person diesen Ort verlässt. |
| **Text bei Entfernen** | Benutzerdefinierter Text beim Verlassen (z. B. `Nicole hat das Haus verlassen`). |

### Funktionsweise

- **Exakter Personen-Match** hat Vorrang vor einem Eintrag ohne Person (Wildcard).
- Ist **Bei Meldung priorisieren** aktiv und ein Text konfiguriert, wird die Standard-Nachricht unterdrückt und der eigene Text verwendet.
- Ist **Bei Meldung priorisieren** aktiv, aber das Textfeld leer, wird trotzdem die Standard-Nachricht gesendet.
- Entfernen-Benachrichtigungen sind rein override-gesteuert – es gibt keine Standard-Entfernen-Nachricht.
- Ankunfts- und Entfernen-Overrides gelten für Telegram und Alexa.

### Beispiel

| Ort | Person | Priorisieren | Ankunft melden | Text bei Ankunft | Entfernen melden | Text bei Entfernen |
|---|---|:---:|:---:|---|:---:|---|
| Home | Nicole Mustermann | ✅ | ✅ | Nicole ist zuhause angekommen | ✅ | Nicole hat das Haus verlassen |
| Home | *(leer)* | ✅ | ✅ | Jemand ist zuhause angekommen | ☐ | |

In diesem Beispiel: Wenn Nicole zu Hause ankommt, wird `Nicole ist zuhause angekommen` gesendet (Standard-Meldung unterdrückt). Wenn eine andere Person ankommt, wird `Jemand ist zuhause angekommen` gesendet.

Als Filterwert kann entweder der **Anzeigename** oder die **Chat-ID** verwendet werden — beides wird akzeptiert und lässt sich beliebig kombinieren.

**Beispiele:**
- `Nicole` — nur an den Empfänger mit Anzeigename „Nicole" senden
- `123456789` — nur an den Empfänger mit Chat-ID 123456789 senden
- `Nicole, 987654321` — an Nicole und an den Empfänger mit Chat-ID 987654321 senden

### Nachrichten-Format

Die Benachrichtigungsnachricht wird folgendermaßen aufgebaut:

```
[Vorangestellter Text] [Ortsname]
```

Wenn der vorangestellte Text leer ist, wird nur der Ortsname gesendet.

**Beispiel:** Text = `Nicole ist bei`, Ort = `Zuhause` → Nachricht: `Nicole ist bei Zuhause`

> **Hinweis:** Benachrichtigungen werden nur gesendet, wenn eine Person einen **bekannten Ort** betritt (eigener Ort oder Life360-App-Ort). Ist der Ortsname unbekannt oder leer, wird keine Nachricht gesendet.

---

## Test-Benachrichtigungen

Mit dem Button **Testnachricht senden** (Telegram-Bereich) oder **Testansage senden** (Alexa-Bereich) kannst du deine Konfiguration prüfen, ohne auf eine echte Standortänderung zu warten.

> **Wichtig:** Der Test verwendet die Konfiguration, die der aktuell laufende Adapter geladen hat. Wenn du Änderungen vorgenommen hast, **speichere und starte** den Adapter zuerst neu, bevor du den Test-Button verwendest.

| Button | Was passiert |
|---|---|
| **Testnachricht senden** | Sendet `[Life360ng] Test notification` an alle konfigurierten Telegram-Empfänger |
| **Testansage senden** | Kündigt `Life360ng test notification` auf allen konfigurierten Alexa-Geräten an |
