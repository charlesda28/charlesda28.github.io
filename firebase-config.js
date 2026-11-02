/*
  Firebase settings for shared sync.
  ------------------------------------------------------------------
  This file is public by design: anyone can see it on the website.
  That's fine. What protects the data is firestore.rules, which only
  lets the emails on the allowlist read or write.

  HOW TO FILL IT IN
  Firebase console > Project settings (gear) > Your apps > Web app >
  "SDK setup and configuration" > Config. Copy the values into the
  6 lines below, replacing each PASTE_... placeholder.

  While these still say PASTE_..., the app runs in local-only mode
  (data saves on this device only, exactly like before).
*/
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyADCmmRckwm2HKAeKQLVuSbIe3HTYigosg",
  authDomain: "spending-app-a58be.firebaseapp.com",
  projectId: "spending-app-a58be",
  storageBucket: "spending-app-a58be.firebasestorage.app",
  messagingSenderId: "526261857908",
  appId: "1:526261857908:web:df61042b83070a2e356b21"
};

/* The owner can add and remove people in the app. Must match OWNER_EMAIL in firestore.rules. */
window.TRACKER_OWNER = "charlesda28@gmail.com";

/* Everyone shares this one tracker. Leave as is. */
window.TRACKER_HOUSEHOLD = "main";
