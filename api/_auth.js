// api/_auth.js — verificación de identidad Firebase para endpoints con PII.
// (El prefijo "_" hace que Vercel NO lo exponga como endpoint.)
//
// Contexto: los endpoints aceptaban `uid` plano por query string con CORS *:
// cualquiera que conociera un uid podía leer nombres/DNI/teléfonos/direcciones
// de los clientes y hasta marcar pedidos como enviados. Ahora los endpoints
// sensibles exigen un ID token válido de Firebase (Authorization: Bearer).
//
// Nota deliberada: se verifica que el token sea VÁLIDO (usuario autenticado de
// la app), no que token.uid === query.uid — el equipo (Thiago y colaboradoras)
// opera sobre los datos de la cuenta principal desde sus propios logins, y el
// modelo de organizaciones vive en el frontend. Esto cierra el agujero real
// (acceso anónimo desde internet) sin romper el trabajo multi-usuario.
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

function initApp() {
  if (getApps().length > 0) return;
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
    }),
  });
}

// Devuelve el token decodificado o null (token ausente/inválido/vencido).
export async function verifyAuth(req) {
  try {
    const h = req.headers.authorization || req.headers.Authorization || "";
    const m = /^Bearer\s+(.+)$/i.exec(String(h));
    if (!m) return null;
    initApp();
    return await getAuth().verifyIdToken(m[1]);
  } catch (_) { return null; }
}
