Postream — Next.js + Firebase + Cloudinary (Gothic Red Feed)

Simple starter project: upload images/videos to Cloudinary (signed upload), store metadata in Firestore, Google sign-in (Firebase Auth), and per-post comments. Built with Next.js pages router and serverless signature endpoint pages/api/signature.js.

UI tema: dark / gothic red.
Repo contains a single-page feed (pages/index.js) with inline global CSS so you can run it instantly.

🔥 Fitur
- Login with Google (Firebase Auth)
- Signed upload to Cloudinary (server-side signature)
- Save post metadata to Firestore
- Add & view comments per post
- Dark “gothic red” UI
- Ready to deploy to Vercel

🧾 Prerequisites
- Node.js (v18+ recommended)
- npm atau yarn
- Firebase project
- Cloudinary account
- (Optional) Vercel account for deployment

📁 Project structure
```js
pages/
  index.js            # main app (UI + client logic)
  api/
    signature.js      # serverless endpoint that verifies Firebase ID token and returns Cloudinary signature
lib/
  firebaseClient.js   # init firebase client helper
package.json
.next/ (build)
