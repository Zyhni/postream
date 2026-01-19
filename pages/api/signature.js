// pages/api/signature.js
import { v2 as cloudinary } from "cloudinary";
import admin from "firebase-admin";

// configure cloudinary (server side)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY || process.env.NEXT_PUBLIC_CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// init firebase-admin (supports FIREBASE_SERVICE_ACCOUNT JSON or GOOGLE_APPLICATION_CREDENTIALS file)
function initFirebaseAdmin() {
  if (admin.apps.length) return;

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    let svc = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (typeof svc === "string") {
      try {
        svc = JSON.parse(svc);
      } catch (e) {
        // if JSON.parse fails, throw so it's visible
        throw new Error("FIREBASE_SERVICE_ACCOUNT JSON parse error: " + e.message);
      }
    }
    if (svc.private_key && svc.private_key.indexOf("\\n") !== -1) {
      svc.private_key = svc.private_key.replace(/\\n/g, "\n");
    }
    admin.initializeApp({
      credential: admin.credential.cert(svc)
    });
    console.log("firebase-admin initialized from FIREBASE_SERVICE_ACCOUNT");
    return;
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp();
    console.log("firebase-admin initialized using GOOGLE_APPLICATION_CREDENTIALS");
    return;
  }

  throw new Error("No Firebase admin credentials found. Set FIREBASE_SERVICE_ACCOUNT (JSON) or GOOGLE_APPLICATION_CREDENTIALS.");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  if (!process.env.CLOUDINARY_API_SECRET) {
    console.error("Missing CLOUDINARY_API_SECRET");
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "");

  if (!idToken) {
    console.warn("No idToken provided");
    return res.status(401).json({ error: "No Firebase ID token provided in Authorization header" });
  }

  try {
    initFirebaseAdmin();

    // verify firebase id token
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log("Verified token for uid:", decoded.uid);

    const { folder } = req.body || {};
    const timestamp = Math.floor(Date.now() / 1000);
    const paramsToSign = { timestamp };
    if (folder) paramsToSign.folder = folder;

    const signature = cloudinary.utils.api_sign_request(paramsToSign, process.env.CLOUDINARY_API_SECRET);

    return res.status(200).json({
      ok: true,
      signature,
      timestamp,
      api_key: process.env.CLOUDINARY_API_KEY || process.env.NEXT_PUBLIC_CLOUDINARY_API_KEY,
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME || process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME
    });
  } catch (err) {
    console.error("Signature endpoint error:", err && err.message ? err.message : err);
    if (err && err.message && err.message.includes("No Firebase admin")) {
      return res.status(500).json({ error: err.message });
    }
    return res.status(401).json({ error: "Invalid token or server error", details: err.message || String(err) });
  }
}
