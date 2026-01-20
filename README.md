# Postream — Next.js + Firebase + Cloudinary

Simple starter project: upload images/videos to Cloudinary (signed upload), store metadata in Firestore, Google sign-in (Firebase Auth), and per-post comments. Built with Next.js pages router and serverless signature.

---

### 🔥 Fitur
- Login with Google (Firebase Auth)
- Signed upload to Cloudinary (server-side signature)
- Save post metadata to Firestore
- Add & view comments per post

---

### 🧾 Prerequisites
- Node.js (v18+ recommended)
- npm atau yarn
- Firebase project
- Cloudinary account

---

### 📁 Project structure
```js
pages/
  index.js
  api/
    signature.js
lib/
  firebaseClient.js
package.json
.next/ (build)
```

---

### ⚙️ Environment variables (.env.local)
```js
# Cloudinary (server-side secret)
CLOUDINARY_API_SECRET=

# Cloudinary (client)
NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME=
NEXT_PUBLIC_CLOUDINARY_API_KEY=

# Firebase client config (public)
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=

FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",...}
```

---

### 🚀 Local setup & run
1. Install deps
```js
npm install
```
2. Create .env.local as shown above.
3. Start dev server
```js
npm run dev
```

---

### ☁️ Cloudinary setup
1. Create account at Cloudinary.
2. In Dashboard copy cloud_name, api_key, api_secret.
3. We use signed uploads: pages/api/signature.js generates signatures server-side using CLOUDINARY_API_SECRET. Do not expose the secret to the browser.
4. Optionally configure upload presets in Cloudinary for formats, folder rules, transformations.

---

### 🔐 Firebase setup
1. Create Firebase project and enable Authentication → Sign-in method → Google.
2. Enable Firestore (start in test mode for dev).
3. Generate service account (Project settings → Service accounts → Generate new private key). Use that JSON for FIREBASE_SERVICE_ACCOUNT or point GOOGLE_APPLICATION_CREDENTIALS to the JSON file.
4. Set Firestore rules (for development):
```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /uploads/{postId} {
      allow read: if true;
      allow create: if request.auth != null && request.resource.data.ownerUid == request.auth.uid;
      allow update, delete: if request.auth != null && resource.data.ownerUid == request.auth.uid;

      match /comments/{commentId} {
        allow read: if true;
        allow create: if request.auth != null;
      }
    }
  }
}
```

---

### 📄 License
MIT — use/modify as you like. Please remove API keys & secrets before publishing the repo.
