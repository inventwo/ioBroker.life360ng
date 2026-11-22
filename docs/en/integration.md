![Logo](../../admin/Life360ng.svg)
### The Next Generation
[zurück zur Startseite](README.md)

# Tab: Integration

In the **Integration** tab, you control which Life360 data is processed by the adapter and created as ioBroker objects.

**Features:**

- **Circles, Places, People:** You can individually select whether Life360 circles, places, and people are imported and synchronized.
- **Location Tracking:** Enable whether the current locations of people should be continuously updated.
- **Unknown Place:** Define a name for places that are not recognized by Life360 (e.g., "Unknown").

**Refresh circles & app places:**
Under **Refresh circles & app places** you choose when circle and place definitions are reloaded from the Life360 cloud:

- **Only on instance restart** (default)
- **Every X hours** (hours configurable)
- **Once a day**

Person locations still update on every poll interval regardless of this setting. After changes in the Life360 app, restart the instance (startup mode) or wait for the next automatic refresh.

**Note:**
These settings help you keep your adapter objects and data traffic to a minimum and maintain a clear overview.
