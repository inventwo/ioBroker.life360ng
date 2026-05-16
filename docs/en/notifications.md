![Logo](../../admin/Life360ng.svg)
### The Next Generation
[back to start](README.md)

# Tab: Notifications

In the **Notifications** tab, you configure Telegram messages that are sent automatically when a Life360 person arrives at a known place.

---

## Telegram

Enable or disable Telegram notifications with the **Enable Telegram notifications** toggle.

> **Requirement:** The [ioBroker Telegram adapter](https://github.com/iobroker-community-adapters/ioBroker.telegram) must be installed and running.

---

## Recipients Table

Define all Telegram recipients who can receive notifications.

| Column | Description |
|---|---|
| **Instance** | Telegram adapter instance number (default: `0`) |
| **Display name** | Optional label to identify this recipient in the people filter |
| **Chat ID** | Telegram Chat ID of the recipient |

**How to find the Chat ID:**  
Open the Telegram adapter in ioBroker Admin → **Messages** tab. After the user has sent a message to your Telegram bot, their Chat ID appears in the list of authenticated users.

> **Note:** The display name is optional and only used as a convenient label for the filter in the people table. You can leave it empty and use the Chat ID directly as the filter value instead.

---

## People Table

This table is **automatically synced** from Life360 — persons appear here as soon as they are loaded from the Life360 cloud. No manual entry is needed.

| Column | Description |
|---|---|
| **Life360 name** | Person's name from Life360 (read-only, auto-synced) |
| **Prefix text (own places)** | Text prepended to the place name for own places notifications (e.g. `Nicole is at`) |
| **Prefix text (app places)** | Text prepended to the place name for Life360 app places notifications |
| **Recipients** | Comma-separated list of display names or Chat IDs from the recipients table. Empty = send to all recipients |
| **Own places** | Enable notifications when this person arrives at an own place (My Places) |
| **App places** | Enable notifications when this person arrives at a Life360 app place |

### Recipient Filter

The **Recipients** column lets you restrict which recipients get the message for a specific person.

- **Empty:** The notification is sent to **all** recipients in the recipients table.
- **Filled:** Only the listed recipients receive the message.

You can use either the **display name** or the **Chat ID** as the filter value — both are accepted, and you can mix them freely.

**Examples:**
- `Nicole` — send only to the recipient with display name "Nicole"
- `123456789` — send only to the recipient with Chat ID 123456789
- `Nicole, 987654321` — send to Nicole and to the recipient with Chat ID 987654321

### Notification Message

The notification message is built as follows:

```
[Prefix text] [Place name]
```

If the prefix text is empty, only the place name is sent.

**Example:** Prefix = `Nicole is at`, Place = `Home` → Message: `Nicole is at Home`

> **Note:** Notifications are only sent when a person arrives at a **known place** (own place or Life360 app place). If the location name is unknown or empty, no message is sent.
