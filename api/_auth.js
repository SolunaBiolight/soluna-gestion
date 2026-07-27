// api/_auth.js — identidad y autorización para los endpoints.
// (El prefijo "_" hace que Vercel NO lo exponga como endpoint.)
//
// Modelo multi-tenant: cada cuenta es un tenant identificado por su uid. NO
// alcanza con exigir un token válido — hay que exigir que el token pertenezca
// a la cuenta cuyos datos se piden, o a alguien habilitado en esa cuenta.
// Sin este binding, cualquier cliente logueado podía leer/escribir los datos
// de cualquier otro pasando otro uid por query (y el uid no es secreto: varios
// endpoints lo devuelven).
//
// Acceso de equipo: users/{uid}.teamUids = [uid, ...] habilita a otras cuentas
// de Firebase a operar sobre ese tenant (para que el equipo del dueño entre
// con su propio login). Los colaboradores externos NO usan esto: van por
// token de portal, que ya tiene su propio alcance.
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

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

// Cache de membresías por instancia caliente (60s) — evita una lectura de
// Firestore por request en los endpoints que se llaman muchas veces seguidas.
const _teamCache = new Map(); // uid -> {at, team:[], isAdmin:bool}
async function _userMeta(uid) {
  const hit = _teamCache.get(uid);
  if (hit && Date.now() - hit.at < 60000) return hit;
  initApp();
  let team = [], isAdmin = false, email = "";
  try {
    const snap = await getFirestore().collection("users").doc(uid).get();
    if (snap.exists) {
      const d = snap.data() || {};
      team = Array.isArray(d.teamUids) ? d.teamUids : [];
      isAdmin = d.isAdmin === true;
      email = d.email || "";
    }
  } catch (_) {}
  const meta = { at: Date.now(), team, isAdmin, email };
  if (_teamCache.size > 500) _teamCache.clear();
  _teamCache.set(uid, meta);
  return meta;
}

/**
 * Exige token válido Y que ese token pueda operar sobre `uid`.
 * Devuelve {ok:true, user} o {ok:false, code, error}.
 */
export async function requireUid(req, uid) {
  const user = await verifyAuth(req);
  if (!user) return { ok: false, code: 401, error: "Sesión inválida. Recargá la página e iniciá sesión de nuevo." };
  const target = String(uid || "").trim();
  if (!target) return { ok: false, code: 400, error: "uid requerido" };
  if (user.uid === target) return { ok: true, user };
  // ¿el solicitante está habilitado como equipo en la cuenta destino?
  const meta = await _userMeta(target);
  if (meta.team.includes(user.uid)) return { ok: true, user, viaTeam: true };
  // Los admins de la plataforma pueden operar sobre cualquier cuenta (soporte).
  const self = await _userMeta(user.uid);
  if (self.isAdmin) return { ok: true, user, viaAdmin: true };
  console.warn(`[auth] ${user.uid} intentó operar sobre ${target}`);
  return { ok: false, code: 403, error: "No tenés acceso a esta cuenta." };
}

/** Helper que ya responde el error. `if (!(await guardUid(req,res,uid))) return;` */
export async function guardUid(req, res, uid) {
  const r = await requireUid(req, uid);
  if (r.ok) return r;
  res.status(r.code).json({ error: r.error });
  return null;
}

/**
 * Exige que quien llama sea administrador de la plataforma. La identidad sale
 * del TOKEN, nunca de un uid mandado por el cliente.
 */
export async function requireAdmin(req) {
  const user = await verifyAuth(req);
  if (!user) return { ok: false, code: 401, error: "Sesión inválida." };
  const meta = await _userMeta(user.uid);
  const envAdmins = String(process.env.ADMIN_UIDS || "").split(",").map(s => s.trim()).filter(Boolean);
  // Fundadores de la plataforma. Comparar contra el uid del TOKEN es seguro
  // (no se puede falsificar); el agujero anterior era comparar contra un uid
  // que el cliente mandaba en el body.
  const FOUNDERS = ["WJH3ArqDPQcNLha9lOinvkVi9uJ2"];
  if (meta.isAdmin || envAdmins.includes(user.uid) || FOUNDERS.includes(user.uid)) return { ok: true, user };
  console.warn(`[auth] ${user.uid} intentó una acción de admin`);
  return { ok: false, code: 403, error: "Acción reservada a administradores." };
}

/** Autenticación de crons: Vercel manda el CRON_SECRET como Bearer. */
export function isCronRequest(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // sin secreto configurado, ningún request pasa como cron
  const h = String(req.headers.authorization || req.headers.Authorization || "");
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const token = m ? m[1] : (req.query?.secret || "");
  return token === secret;
}

/** `if (!guardCron(req,res)) return;` */
export function guardCron(req, res) {
  if (isCronRequest(req)) return true;
  res.status(401).json({ error: "No autorizado" });
  return false;
}
