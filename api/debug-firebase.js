import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const results = {
    env: {
      FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID ? "✓ existe" : "✗ FALTA",
      FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL ? "✓ existe" : "✗ FALTA",
      FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY ? 
        `✓ existe (${process.env.FIREBASE_PRIVATE_KEY.length} chars, empieza con: ${process.env.FIREBASE_PRIVATE_KEY.slice(0,30)}...)` : 
        "✗ FALTA",
    },
    firebaseInit: null,
    firestoreRead: null,
    error: null,
  };

  try {
    // Intentar inicializar Firebase
    if (getApps().length === 0) {
      const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, "");
      initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey,
        }),
      });
    }
    results.firebaseInit = "✓ OK";

    // Intentar leer de Firestore
    const db = getFirestore();
    const snap = await db.collection("users").limit(1).get();
    results.firestoreRead = `✓ OK (${snap.size} docs)`;

  } catch(e) {
    results.error = e.message;
  }

  res.status(200).json(results);
}
