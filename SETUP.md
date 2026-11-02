# Shared sync setup (about 10 minutes, free)

Firebase's free Spark plan is enough. It doesn't need a card. These steps work on iPhone Safari, but they're easier on the MacBook.

## 1. Create the project
1. Go to **console.firebase.google.com** and sign in with your Google account.
2. Tap **Create a project**, name it `spending`, and continue.
3. Turn **Google Analytics off**, then tap **Create project**.

## 2. Add a web app
1. On the project home, tap the **</>** (Web) icon.
2. Name it `Spending`. Leave Hosting unchecked, then tap **Register app**.
3. Copy the `firebaseConfig = { ... }` block it shows and send it back. It's 6 lines: apiKey, authDomain, projectId, storageBucket, messagingSenderId and appId.

## 3. Turn on sign-in
1. Go to **Build → Authentication → Get started**.
2. Pick **Email/Password**, switch on the first toggle (leave "Email link" off), and tap **Save**.
3. Open the **Settings** tab, then **Authorized domains → Add domain**. Enter `charlesda28.github.io` and tap **Add**.

## 4. Create the database
1. Go to **Build → Firestore Database → Create database**.
2. Pick a location near you (e.g. `nam5 (United States)`). Choose **Start in production mode**, then **Create**.
3. Open the **Rules** tab. Delete what's there, paste all of `firestore.rules`, and tap **Publish**.
   - The rules already name `charlesda28@gmail.com` as the owner. If you'll sign in with a different email, change it on the `owner()` line.

## 5. Add people
Once the config is in the app and it's live:
1. Open the site and tap **Create an account** with your owner email. Tap the link in the confirmation email, then tap **I tapped the link**.
2. Tap **Upload my current data to the shared tracker**. You only do this once.
3. Go to **Daily → Shared tracker**, type a person's email, and tap **Add**.
4. Send them the link. They create an account with that same email and confirm it, and they're in.

To remove someone, tap **Remove** next to their email.
