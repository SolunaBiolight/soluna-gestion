// api/google-drive-callback.js
// Callback OAuth de Google Drive — mismo patrón que google-ads-callback.js.
// Flujo por REDIRECCIÓN de página completa (sin popup): el popup de GIS
// (initTokenClient) devolvía popup_closed sin entregar el token aunque todo
// estuviera bien configurado. Google redirige acá con code+state → canjeamos por
// access+refresh token → guardamos en users/{uid}.googleDrive → volvemos a Config.
//
// Scope: drive.file (NO restringido → sin cartel "app no verificada"). Con
// drive.file la app solo ve los archivos que el usuario ELIGE en el Google
// Picker (que muestra todo su Drive). Por eso el Picker debe llamarse con
// setAppId(<número de proyecto>) — ver _showDrivePicker en App.jsx.
//
// Config necesaria (una vez):
//   Vercel env  GOOGLE_DRIVE_CLIENT_SECRET  (secreto del cliente OAuth web del
//               proyecto Growith-Gestion; el client_id ya está en VITE_GOOGLE_CLIENT_ID)
//   Google Cloud → Clientes → cliente web → URIs de redirección autorizados:
//               https://www.growithapp.com/api/google-drive-callback

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createHmac, timingSafeEqual } from "crypto";

export const APP_URL = "https://www.growithapp.com";
export const DRIVE_REDIRECT_URI = `${APP_URL}/api/google-drive-callback`;
export const DRIVE_SCOPES = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email";

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
    }),
  });
  return getFirestore();
}

// Credenciales del cliente OAuth. El client_id es el mismo que usa el frontend
// (VITE_GOOGLE_CLIENT_ID); el secreto es solo de servidor.
export function driveEnv() {
  return {
    // trim(): una variable pegada con salto de línea al final mandaba
    // "client_id=...apps.googleusercontent.com%0A" → Google: 401 invalid_client.
    clientId: String(process.env.GOOGLE_DRIVE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.GOOGLE_DRIVE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || "").trim(),
  };
}

export function signDriveState(uid) {
  return createHmac("sha256", driveEnv().clientSecret).update(String(uid)).digest("hex").slice(0, 32);
}

function verifyState(state) {
  const [uid, sig] = String(state || "").split(".");
  if (!uid || !sig) return null;
  const expected = signDriveState(uid);
  try {
    if (sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return uid;
  } catch (_) {}
  return null;
}

/**
 * Devuelve un access_token válido de Drive para el usuario (renueva con el
 * refresh_token si venció). null si no conectó Drive.
 */
export async function getValidDriveToken(db, uid) {
  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  const g = snap.data()?.googleDrive;
  if (!g?.refresh_token) return null;
  if (g.access_token && g.expires_at && Date.now() < Number(g.expires_at) - 60000) {
    return { accessToken: g.access_token, email: g.email || null };
  }
  const { clientId, clientSecret } = driveEnv();
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: g.refresh_token, grant_type: "refresh_token" }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) {
    console.error("[gdrive refresh]", j);
    throw new Error("Google no renovó el acceso a Drive — desvinculá y volvé a conectar Google Drive");
  }
  const expires_at = Date.now() + Number(j.expires_in || 3600) * 1000;
  await ref.set({ googleDrive: { ...g, access_token: j.access_token, expires_at } }, { merge: true });
  return { accessToken: j.access_token, email: g.email || null };
}

export default async function handler(req, res) {
  const { code, state, error } = req.query || {};
  if (error) return res.redirect(`${APP_URL}/?gdrive=cancelled#/config`);
  if (!code || !state) return res.redirect(`${APP_URL}/?gdrive=bad_request#/config`);

  const uid = verifyState(state);
  if (!uid) return res.redirect(`${APP_URL}/?gdrive=bad_state#/config`);

  const { clientId, clientSecret } = driveEnv();
  try {
    // 1) code → tokens (el refresh_token es lo que persiste)
    const tr = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code: String(code), grant_type: "authorization_code", redirect_uri: DRIVE_REDIRECT_URI }),
    });
    const tj = await tr.json();
    if (!tr.ok || !tj.access_token) {
      console.error("gdrive token exchange:", tj);
      return res.redirect(`${APP_URL}/?gdrive=token_failed#/config`);
    }

    // 2) Email de la cuenta (para mostrar "Conectado · mail@…")
    let email = null;
    try {
      const ur = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${tj.access_token}` } });
      if (ur.ok) email = (await ur.json()).email || null;
    } catch (_) {}

    // 3) Guardar. Si Google no mandó refresh_token (ya había consentido antes sin
    //    prompt=consent), conservamos el que teníamos.
    const db = initAdmin();
    const ref = db.collection("users").doc(uid);
    const prev = (await ref.get()).data()?.googleDrive || {};
    const refresh_token = tj.refresh_token || prev.refresh_token || null;
    if (!refresh_token) return res.redirect(`${APP_URL}/?gdrive=no_refresh#/config`);
    await ref.set({
      googleDrive: {
        connected: true,
        email,
        refresh_token,
        access_token: tj.access_token,
        expires_at: Date.now() + Number(tj.expires_in || 3600) * 1000,
        scope: tj.scope || DRIVE_SCOPES,
        connectedAt: new Date().toISOString(),
      },
    }, { merge: true });

    return res.redirect(`${APP_URL}/?gdrive=ok#/config`);
  } catch (e) {
    console.error("gdrive callback:", e);
    return res.redirect(`${APP_URL}/?gdrive=error#/config`);
  }
}
