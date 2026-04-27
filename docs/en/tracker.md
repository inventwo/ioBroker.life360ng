![Logo](../../admin/Life360ng.svg)
### The Next Generation
[zurück zur Startseite](README.md)

# Tab: Logbook

## Using the Person Map and Family Map

The ioBroker life360ng adapter provides two map types for visualizing movement data:

### 1. Person Map
Each person with tracking enabled gets their own map. This map displays traveled routes as colored lines (GeoJSON-based) and current positions.

- **Activation:** Enable the desired person in the adapter under "Tracker" (`enabled`).
- **Own Map:** The `ownMap` option controls whether a separate map is created for this person.
- **Access:** The map URL can be found in the object tree at `life360ng.<instance>.tracker.<person>.url`.

### 2. Family Map
The family map shows the routes of all enabled persons together on one map.

- **Activation:** At least one person must have the `familyMap` option enabled in the tracker.
- **Access:** The URL for the family map is available at `life360ng.<instance>.tracker.<familyname>.url`.

### 3. Color Settings
You can customize the map colors and route appearance. The settings are available as writable objects under `life360ng.<instance>.tracker.config.color.*`:

- `pageBg`: Background color of the map
- `headerBg`: Background color of the map header
- `headerBorder`: Border color of the map header
- `headerText`: Text color in the map header
- `routeWeight`: Route line width (pixels)
- `routeOpacity`: Route opacity (0–1)

**Note:** Changes to these values ​​will be applied to all cards after the set interval.

### 4. Datepicker
The map HTML includes a datepicker. You can use it to select a specific day and display the route for that day. By default, the current route is shown. The datepicker is especially useful for reviewing movements on particular days.

---
**Tip:** Maps can be opened directly in your browser or integrated into visualizations (e.g., ioBroker VIS as an iframe).

