# Spending

This is a pay-period spending tracker. It's a static PWA with no build step, so it runs on any static host, e.g. GitHub Pages.

- **Local mode** (the default): data saves on this device in localStorage and IndexedDB. You move it between devices with Export/Import backup.
- **Shared mode**: fill in `firebase-config.js` (see `SETUP.md`). Everyone on the allowlist signs in and sees the same data live, and it still works offline.

| File | What it does |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The app |
| `seed.js` | Empty starting shape. It holds no personal data. |
| `firebase-config.js` | Firebase web config. It's public by design; placeholders mean local mode. |
| `sync.js` | Firebase Auth and Firestore sync, loaded from Google's CDN only when configured |
| `firestore.rules` | Who can read and write: verified, allowlisted emails, with the owner managing the list |
| `sw.js` | Offline cache. Bump `CACHE` when you ship changes. |
