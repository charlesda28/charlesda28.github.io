# Spending Tracker web app

Static PWA (no build step, no backend, no bank connection). Files: index.html, styles.css, app.js, seed.js (starter data from build_tracker.py), manifest.webmanifest, sw.js, icons/.

- Data is saved in the browser on each device (localStorage + IndexedDB mirror). Nothing leaves the device.
- Move data between iPhone and Mac: Daily tab > Backup & sync > Export backup, then Import backup on the other device.
- Host: upload this folder (without previews/) to any static HTTPS host, e.g. drag it onto https://app.netlify.com/drop, or a GitHub Pages repo.
- Test date override: add ?today=2026-10-31 to the URL.
