![Logo](../../admin/Life360ng.svg)
### The Next Generation
[zurück zur Startseite](README.md)

# Tab: Logbook


## Logbook and Map Features

The ioBroker life360ng adapter provides comprehensive logbook and map features for each tracked person:

- **Individual maps for each person:** For every person with tracking enabled, a dedicated map is available showing traveled routes (GeoJSON-based) and the current position.
- **Family map:** In addition, a family map displays the routes of all enabled persons together.
- **Color customization:** Map colors and appearance (e.g., background, line width, opacity) can be individually adjusted via Config.
- **Integrated datepicker:** The map HTML includes a calendar to select a specific day and display the route for that day.
- **Flexible integration:** Maps can be opened directly in the browser or embedded as an iframe in visualizations (e.g., ioBroker VIS).

All details on configuration and usage can be found below and in the adapter configuration.

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
- **Access:** The URL for the circle map is available at `life360ng.<instance>.tracker.circle.url`.

### 3. Color Settings
You can customize the map colors and route appearance. The settings are available at the adapter config:

- Background color of the map
- Background color of the map header
- Border color of the map header
- Route line width (pixels)
- Route opacity (0–1)
- End-marker opacity (0–1): controls the transparency of the position pin on the map
- Size of the end-marker (0-2): controls the size of the position pin on the map (0.5 = half, 1.0 = standard, 2.0 = double)

**Note:** Changes to these values ​​will be applied to all cards after the set query interval.

### 4. Datepicker
The map HTML includes a datepicker. You can use it to select a specific day and display the route for that day. By default, the current route is shown. The datepicker is especially useful for reviewing movements on particular days.

**Note:** The appearance may vary depending on the browser used.

---
**Tip:** Maps can be opened directly in your browser or integrated into visualizations (e.g., ioBroker VIS as an iframe).

> The generated HTML, CSS, and JS files are stored in the ioBroker file system. You can view or manage them under **Admin → Files → `life360ng.<instance>/tracker/`**.

---

## Explanations of the points and pins on the maps

| Type | Reason |
|---|:---|
|Dark points: | Starting point of the day|
|Light points: | Ending point of the day|
|Pin/Marker: | Current location|

---

## Data Management

Route data (`allTime.geojson`) grows over time. The adapter offers two ways to keep file sizes under control:

### Automatic Cleanup (Retention Period)

Under **General → Retention (days)** you can define how many days of route data should be kept. Older days are automatically removed on every adapter start and once per day. A value of `0` means unlimited retention.

### Manual Cleanup for Individual Persons

The **persons table** has a **"Clear rec."** column. Enable the checkbox for a person and save the configuration. That person's `allTime.geojson` is reduced to the last known position.

> ⚠️ Since the family map is built from the individual person data, clearing a person's recordings automatically updates the family map as well.
> The monthly GeoJSON files (`currentYear.MM`) are never affected.

