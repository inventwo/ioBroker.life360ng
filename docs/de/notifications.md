![Logo](../../admin/Life360ng.svg)
### The Next Generation
[zurück zur Startseite](README.md)

# Tab: Benachrichtigungen

Im Tab **Benachrichtigungen** konfigurierst du Telegram-Nachrichten, die automatisch gesendet werden, wenn eine Life360-Person einen bekannten Ort betritt.

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

## Personentabelle

Diese Tabelle wird **automatisch mit Life360 synchronisiert** — Personen erscheinen hier, sobald sie aus der Life360-Cloud geladen wurden. Es ist keine manuelle Eingabe nötig.

| Spalte | Beschreibung |
|---|---|
| **Life360-Name** | Name der Person aus Life360 (schreibgeschützt, automatisch synchronisiert) |
| **Vorangestellter Text (Eigene Orte)** | Text, der dem Ortsnamen bei Benachrichtigungen zu eigenen Orten vorangestellt wird (z. B. `Nicole ist bei`) |
| **Vorangestellter Text (App-Orte)** | Text, der dem Ortsnamen bei Benachrichtigungen zu Life360-App-Orten vorangestellt wird |
| **Empfänger** | Kommaseparierte Liste von Anzeigenamen oder Chat-IDs aus der Empfängertabelle. Leer = an alle Empfänger senden |
| **Eigene Orte** | Benachrichtigung aktivieren, wenn diese Person einen eigenen Ort betritt (Meine Orte) |
| **App-Orte** | Benachrichtigung aktivieren, wenn diese Person einen Life360-App-Ort betritt |

### Empfänger-Filter

Die Spalte **Empfänger** ermöglicht es, festzulegen, welche Empfänger die Nachricht für eine bestimmte Person erhalten.

- **Leer:** Die Benachrichtigung wird an **alle** Empfänger in der Empfängertabelle gesendet.
- **Gefüllt:** Nur die aufgelisteten Empfänger erhalten die Nachricht.

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
