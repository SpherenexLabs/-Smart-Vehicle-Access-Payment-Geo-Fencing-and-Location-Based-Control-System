# ks5580 — React Battery Management Dashboard

A responsive React application recreated from the supplied dashboard image. The interface displays **Battery Management Dashboard** and **SPHERENEX**; quotation references and project numbers are not displayed anywhere in the application or exported report.

## Open immediately

Open **Offline_Dashboard.html** in Chrome, Edge or Firefox. It contains the complete compiled React application, styles and icons. The interface opens directly from disk, while live readings and commands require internet access to Firebase Realtime Database.

## Run the editable React project

Install Node.js **22.12 or newer**, extract the ZIP, then open a terminal inside the `ks5580` folder:

```bash
npm install
npm run dev
```

Open the URL printed by Vite, normally `http://localhost:5173`.

```bash
npm run build
npm run preview
```

The `dist` directory also contains the production build. Serve it over HTTP; do not open `dist/index.html` directly from the file system. The standalone `Offline_Dashboard.html` is the file intended for direct opening.

## Included screens and behavior

- **Overview:** fourteen Firebase-backed battery cards, voltage-derived SOC/SOD and battery status, battery gauge, automatic relay protection, voltage trends, protection, vehicle/OLED preview and performance reports.
- **Cell Monitoring:** all fourteen readings, an explicit highest-battery marker, high/low/no-voltage conditions, cell voltage difference, individual history dialogs and suggested maintenance actions.
- **Relay Control:** automatic voltage-to-relay control for Relay1–Relay14, live relay status, hysteresis thresholds and a time-stamped activity log.
- **Protection:** overvoltage, undervoltage, short-circuit and cutoff status; per-battery 30-minute trend predictions and maintenance suggestions. Marking an alert reviewed does not clear an active condition.
- **Vehicle Testing:** manual Forward/Backward/Left/Right/Stop commands plus named auto-route recording, duration capture, test-before-save, Firebase save/update/delete, and route playback.
- **Reports:** Firebase-backed voltage/health history, history filtering, all-battery condition predictions, suggested actions and direct download of a four-page PDF report.
- **Responsive layout:** sidebar drawer on phones, accessible switches and buttons, keyboard-friendly cell dialogs and reduced-motion support.

SOC is estimated by converting each available battery voltage independently against the hardware's 4.2 V full-scale value, clamping each result to 0–100%, and then averaging those percentages. This makes readings around 3.35 V display about 80% and prevents one low or disconnected battery from collapsing the estimate for the other thirteen. Battery status is `OK` only when all fourteen readings are present from 3.00 V through 3.80 V; it is `Attention` for a low/high reading, `Fault` for any 0 V reading, and `Unknown` when readings are missing. Temperature is intentionally not monitored. Predictions are local voltage-trend extrapolations and are advisory rather than a substitute for BMS protection or qualified inspection.

## Firebase connection and paths

The supplied Firebase web configuration is in `src/lib/firebaseRtdb.js`. The dashboard listens to `BMS_5580` through the Realtime Database REST event stream and uses these paths:

```text
BMS_5580/Voltage/V1 ... V14
BMS_5580/Relay/Relay1 ... Relay14
BMS_5580/Current
BMS_5580/ChargingVoltage
BMS_5580/SOC_Status
BMS_5580/SOD_Status
BMS_5580/History/{minuteBucket}
BMS_5580/Vehicle/Direction
BMS_5580/Vehicle/Routes/{routeId}
```

Direction values are `F`, `B`, `L`, `R`, and `S`. The dashboard stores one historical voltage/health snapshot per minute using a deterministic minute key, so multiple dashboard updates in the same minute replace that minute's record instead of creating duplicates. The client loads the latest 5,000 valid history records; configure server-side retention if longer-term database growth must be limited.

The relay board uses active-low logic: `1` means OFF and `0` means ON. `V1` controls `Relay1`, through `V14` controlling `Relay14`. A reading of exactly 0 V always writes `1` to its matching relay, including while automatic low-voltage control is paused. With automation enabled, protection also writes `1` below 3.00 V and writes `0` after recovery to 3.10 V or higher. Between the two thresholds it preserves the current relay state. This logic runs in the browser only while the dashboard is open; safety-critical cutoff must also be enforced by the BMS/firmware.

The Firebase web API key identifies the project but does not authorize database access. Configure Firebase Realtime Database Rules (and Authentication for production) so the intended users can read telemetry and write only the required Relay, History, Direction, and Routes paths. Do not use unrestricted public write rules in production.

The quoted pack specification is shown as supplied. The application does not infer the series/parallel connection of the fourteen physical cells or derive pack voltage by summing them.

## Project files

```text
ks5580/
  Offline_Dashboard.html
  index.html
  package.json
  package-lock.json
  vite.config.js
  .env.example
  public/battery.svg
  src/
    main.jsx
    App.jsx
    styles.css
    components/{Icon,Chart,Robot}.jsx
    lib/{model,useBattery,exportPdf}.js
  tests/model.test.js
  dist/
```

The PDF exporter is implemented locally and does not depend on a remote service or a browser print dialog. All charts and illustrations are editable SVG/React components rather than flattened screenshots.

## Checks

```bash
npm test
npm run build
```

The included tests cover Firebase key ordering, stream patches, relay hysteresis, route-step validation, telemetry validation, history bounds and PDF structure. The production and standalone builds are generated by `npm run build`.
