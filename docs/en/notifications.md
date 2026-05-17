![Logo](../../admin/Life360ng.svg)
### The Next Generation
[back to start](README.md)

# Tab: Notifications

In the **Notifications** tab, you configure Telegram messages and Alexa announcements that are sent automatically when a Life360 person arrives at a known place.

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

## Alexa

Enable or disable Alexa announcements with the **Enable Alexa announcements** toggle.

> **Requirement:** The [ioBroker Alexa2 adapter](https://github.com/Apollon77/ioBroker.alexa2) must be installed and running.

---

## Alexa Devices Table

Define the Echo devices that should announce location changes.

| Column | Description |
|---|---|
| **Display name** | Optional label to identify this device (e.g. `Office Echo`) |
| **Speak state ID** | Full ioBroker state ID of the speak datapoint (e.g. `alexa2.0.Echo-Devices.G090LF11806218AC.Commands.speak`) |
| **Volume (0–100)** | Announcement volume. The Alexa adapter automatically restores the previous volume afterwards. |

**How to find the speak state ID:**  
Open the ioBroker object tree → `alexa2.0` → `Echo-Devices` → find your device folder → `Commands` → `speak`. Copy the full object ID.

> **Note:** When the volume is set, the Alexa2 adapter automatically restores the original volume after the announcement.

---

## People Table

This table is **automatically synced** from Life360 — persons appear here as soon as they are loaded from the Life360 cloud. No manual entry is needed.

| Column | Description |
|---|---|
| **Life360 name** | Person's name from Life360 (read-only, auto-synced) |
| **Prefix text (own places)** | Text prepended to the place name for own places notifications (e.g. `Nicole is at`) |
| **Prefix text (app places)** | Text prepended to the place name for Life360 app places notifications |
| **Recipients (Telegram only)** | Comma-separated list of display names or Chat IDs from the recipients table. Empty = send to all Telegram recipients. Alexa notifications are always sent to all configured devices. |
| **Own places** | Enable notifications when this person arrives at an own place (My Places) |
| **App places** | Enable notifications when this person arrives at a Life360 app place |
| **Unknown places** | Enable notifications when this person's location becomes unknown |
| **Message for unknown location** | Custom message text sent when the person's location is unknown |

### Recipient Filter (Telegram only)

The **Recipients** column applies to Telegram notifications only — it has no effect on Alexa announcements. It lets you restrict which Telegram recipients get the message for a specific person. Alexa announcements are always sent to all configured devices.

- **Empty:** The notification is sent to **all** recipients in the recipients table.
- **Filled:** Only the listed recipients receive the message.

---

## Place-Specific Notification Overrides

Below the people table you can configure place- and person-specific notification overrides. These let you replace the default message (`prefix text + place name`) with a custom text for a specific place, and optionally also send a message when a person **leaves** a place.

| Column | Description |
|---|---|
| **+ Place** | Place name — selected from a dropdown populated with own places (⚑) and Life360 app places (📍). Manual entry is also possible. |
| **Person** | Life360 person name — selected from a dropdown of known persons. |
| **Prioritize on notification** | When enabled, the default message (`prefix text + place name`) is suppressed. The custom arrival or leave text is used instead. |
| **Notify on arrival** | Send a notification when the person arrives at this place. |
| **Text on arrival** | Custom message text sent on arrival (e.g. `Nicole arrived home`). |
| **Notify on leave** | Send a notification when the person leaves this place. |
| **Text on leave** | Custom message text sent on leave (e.g. `Nicole left home`). |

### How it works

- **Exact person match** takes precedence over a wildcard entry (empty person field).
- If **Prioritize on notification** is enabled and a text is configured, the standard message is suppressed and the custom text is used.
- If **Prioritize on notification** is enabled but the text field is empty, the standard message is still sent.
- Leave notifications are purely override-driven — there is no default leave message.
- Both arrival and leave overrides apply to Telegram and Alexa.

### Example

| Place | Person | Prioritize | Notify arrival | Text on arrival | Notify leave | Text on leave |
|---|---|:---:|:---:|---|:---:|---|
| Home | Nicole Mustermann | ✅ | ✅ | Nicole arrived home | ✅ | Nicole left home |
| Home | *(empty)* | ✅ | ✅ | Someone arrived home | ☐ | |

In this example: when Nicole arrives at Home, the message `Nicole arrived home` is sent (standard message suppressed). When any other person arrives, `Someone arrived home` is sent.

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

---

## Test Notifications

Use the **Send test message** button (Telegram section) or the **Send test announcement** button (Alexa section) to verify your configuration without waiting for a real location change.

> **Important:** The test uses the configuration currently loaded by the running adapter. If you have made changes, **save and restart** the adapter first, then use the test button.

| Button | What it does |
|---|---|
| **Send test message** | Sends `[Life360ng] Test notification` to all configured Telegram recipients |
| **Send test announcement** | Announces `Life360ng test notification` on all configured Alexa devices |
