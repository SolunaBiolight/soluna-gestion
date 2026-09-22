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
import { getFirestore, FieldValue } from "firebase-admin/firestore";

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

// Fundadores de la plataforma: los únicos que pueden dar o quitar el flag de
// admin a otras cuentas. Comparar contra el uid del TOKEN es seguro.
const FOUNDERS = ["WJH3ArqDPQcNLha9lOinvkVi9uJ2"];
export function isFounder(uid) { return FOUNDERS.includes(String(uid || "")); }

// ── Modo "Ver como cliente" (Admin) ─────────────────────────────────
// El token de impersonación lleva el claim impersonatedBy (uid del admin).
// Desde 22/sep/2026 el admin PUEDE escribir en la cuenta del cliente (soporte
// real), salvo las acciones IRREVERSIBLES o que mueven plata del cliente:
// emitir etiquetas Andreani (debita saldo), facturar en ARCA (CAE definitivo),
// publicar campañas pagas y mandar mails a compradores. Esas siguen cerradas.
//
// La lista es por (endpoint, action) y se compara en minúsculas. Cualquier
// acción nueva que gaste plata del cliente o emita un comprobante fiscal TIENE
// que sumarse acá: el default es permitir.
const RO_BLOQUEADAS = {
  andreani:   ["emitir"],                                        // debita saldo real
  arca:       ["emit", "emit_nc", "emit_nc_batch", "emit_nd"],   // CAE irreversible
  meta:       ["publish"],                                       // campaña con presupuesto
  "google-ads": ["publish"],
  "tiktok-ads": ["publish"],
};
// Endpoint a partir de la URL: /api/andreani?x=1 → "andreani".
function _endpointOf(req) {
  try {
    const u = String(req.url || "").split("?")[0];
    const m = /\/api\/([a-z0-9_-]+)/i.exec(u);
    return m ? m[1].toLowerCase() : "";
  } catch (_) { return ""; }
}
function _actionOf(req) {
  try {
    const q = req.query && req.query.action;
    if (q) return String(q);
    const b = req.body;
    if (b && typeof b === "object" && b.action) return String(b.action);
  } catch (_) {}
  return "";
}
/** {ok:false,...} si el token es de impersonación y la acción es irreversible. */
export function readOnlyBlock(req, user) {
  if (!user || !user.impersonatedBy) return null;
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  const ep = _endpointOf(req);
  const action = _actionOf(req).toLowerCase();
  const lista = RO_BLOQUEADAS[ep];
  if (lista && lista.includes(action)) {
    return { ok: false, code: 403, error: "Estás viendo la cuenta como administrador. Esta acción mueve plata o emite un comprobante fiscal del cliente, así que solo puede hacerla el cliente desde su propia cuenta.", readOnly: true, impersonado: true };
  }
  return null;
}
/** true si este request viene de un admin metido en la cuenta de un cliente. */
export function esImpersonacion(user) { return !!(user && user.impersonatedBy); }

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
const _teamCache = new Map(); // uid -> {at, team:[], members:{}, isAdmin:bool}
async function _userMeta(uid) {
  const hit = _teamCache.get(uid);
  if (hit && Date.now() - hit.at < 60000) return hit;
  initApp();
  let team = [], members = {}, isAdmin = false, email = "", ownerUid = null, deleted = false;
  try {
    const snap = await getFirestore().collection("users").doc(uid).get();
    if (snap.exists) {
      const d = snap.data() || {};
      // Multi-tienda: ownerUid = perfil (login) dueño de esta tienda. Ausente =
      // la cuenta es dueña de sí misma (caso clásico). deleted = cuenta en
      // ventana de 30 días antes de la purga: nadie opera sobre ella.
      ownerUid = d.ownerUid ? String(d.ownerUid) : null;
      deleted = d.deleted === true;
      team = Array.isArray(d.teamUids) ? d.teamUids : [];
      // Miembros con permisos POR SECCIÓN: {uid:{email,nombre,secciones:{envios:true,...}}}
      members = (d.teamMembers && typeof d.teamMembers === "object") ? d.teamMembers : {};
      isAdmin = d.isAdmin === true;
      email = d.email || "";
    }
  } catch (_) {}
  const meta = { at: Date.now(), team, members, isAdmin, email, ownerUid, deleted };
  if (_teamCache.size > 500) _teamCache.clear();
  _teamCache.set(uid, meta);
  return meta;
}

/** Invalida el cache de un tenant (tras editar miembros/permisos). */
export function clearTeamCache(uid) { _teamCache.delete(uid); }

/**
 * Exige token válido Y que ese token pueda operar sobre `uid`.
 * Devuelve {ok:true, user} o {ok:false, code, error}.
 */
export async function requireUid(req, uid, seccion) {
  const user = await verifyAuth(req);
  if (!user) return { ok: false, code: 401, error: "Sesión inválida. Recargá la página e iniciá sesión de nuevo." };
  const ro = readOnlyBlock(req, user);
  if (ro) return ro;
  const target = String(uid || "").trim();
  if (!target) return { ok: false, code: 400, error: "uid requerido" };
  const meta = await _userMeta(target);
  // Cuenta en ventana de borrado: nadie opera sobre ella (ni su ex dueño).
  if (meta.deleted) return { ok: false, code: 403, error: "Esta cuenta está eliminada." };
  if (user.uid === target) {
    // Tienda MOVIDA a otro perfil: el login original ya no es dueño de su
    // propio doc — no puede operar sobre la tienda aunque el id coincida.
    if (meta.ownerUid && meta.ownerUid !== user.uid) return { ok: false, code: 403, error: "Esta tienda fue movida a otro perfil. Este usuario ya no tiene acceso." };
    if (user.impersonatedBy) logImpersonacion(req, user, target);
    return { ok: true, user };
  }
  // Perfil DUEÑO de esta tienda (multi-tienda): acceso total, como el dueño clásico.
  if (meta.ownerUid && meta.ownerUid === user.uid) { if (user.impersonatedBy) logImpersonacion(req, user, target); return { ok: true, user, viaOwner: true }; }
  // ¿el solicitante está habilitado como equipo en la cuenta destino?
  const member = meta.members ? meta.members[user.uid] : null;
  if (member) {
    // Miembro con permisos por sección: si el endpoint declara sección, se
    // exige que esté habilitada. Sin sección declarada, alcanza la membresía.
    if (seccion && !(member.secciones && member.secciones[seccion] === true)) {
      return { ok: false, code: 403, error: "Tu cuenta no tiene acceso a esta sección. Pedile al dueño que te la habilite desde Equipo." };
    }
    if (user.impersonatedBy) logImpersonacion(req, user, target);
    return { ok: true, user, viaTeam: true, member };
  }
  if (meta.team.includes(user.uid)) { if (user.impersonatedBy) logImpersonacion(req, user, target); return { ok: true, user, viaTeam: true }; } // legacy: acceso total
  // Los admins de la plataforma pueden operar sobre cualquier cuenta (soporte).
  const self = await _userMeta(user.uid);
  if (self.isAdmin) { if (user.impersonatedBy) logImpersonacion(req, user, target); return { ok: true, user, viaAdmin: true }; }
  console.warn(`[auth] ${user.uid} intentó operar sobre ${target}`);
  return { ok: false, code: 403, error: "No tenés acceso a esta cuenta." };
}

/** Helper que ya responde el error. `if (!(await guardUid(req,res,uid,seccion))) return;` */
export async function guardUid(req, res, uid, seccion) {
  const r = await requireUid(req, uid, seccion);
  if (r.ok) return r;
  res.status(r.code).json({ error: r.error });
  return null;
}

// Auditoría de "Ver como cliente": cada ESCRITURA que un admin hace dentro de
// la cuenta de un cliente queda en admin_log. Es best-effort y nunca bloquea ni
// demora el request (no se awaitéa): si el log falla, la acción igual pasa.
function logImpersonacion(req, user, targetUid) {
  try {
    const method = String(req.method || "GET").toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
    const ep = _endpointOf(req);
    const action = _actionOf(req);
    initApp();
    getFirestore().collection("admin_log").add({
      adminUid: String(user.impersonatedBy || ""),
      action: "impersonacion_escritura",
      targetUid: String(targetUid || ""),
      targetEmail: null,
      detalle: `${ep || "?"}:${action || method}`.slice(0, 300),
      data: { endpoint: ep || null, accion: action || null, metodo: method },
      at: FieldValue.serverTimestamp(),
    }).catch(() => {});
  } catch (_) {}
}

/**
 * Exige que quien llama sea administrador de la plataforma. La identidad sale
 * del TOKEN, nunca de un uid mandado por el cliente.
 */
export async function requireAdmin(req) {
  const user = await verifyAuth(req);
  if (!user) return { ok: false, code: 401, error: "Sesión inválida." };
  if (user.impersonatedBy) return { ok: false, code: 403, error: "Modo solo lectura: salí de la vista de cliente para usar el panel de administración." };
  const meta = await _userMeta(user.uid);
  const envAdmins = String(process.env.ADMIN_UIDS || "").split(",").map(s => s.trim()).filter(Boolean);
  // Fundadores de la plataforma. Comparar contra el uid del TOKEN es seguro
  // (no se puede falsificar); el agujero anterior era comparar contra un uid
  // que el cliente mandaba en el body.
  if (meta.isAdmin || envAdmins.includes(user.uid) || FOUNDERS.includes(user.uid)) return { ok: true, user, founder: FOUNDERS.includes(user.uid) };
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
  if (!isCronRequest(req)) {
    res.status(401).json({ error: "No autorizado" });
    return false;
  }
  // Heartbeat: cada cron registra su última corrida en system/crons.{nombre}
  // (fecha, ok/error, duración y un resumen del JSON de respuesta). Se
  // engancha en res.json así ningún cron tiene que acordarse de hacerlo.
  try {
    if (!res.__ghBeat) {
      res.__ghBeat = true;
      const name = cronName(req);
      const t0 = Date.now();
      const origJson = res.json.bind(res);
      res.json = (body) => {
        cronBeat(name, res.statusCode || 200, body, Date.now() - t0).catch(() => {});
        return origJson(body);
      };
    }
  } catch (_) {}
  return true;
}
function cronName(req) {
  try {
    const u = new URL(String(req.url || "/"), "http://x");
    const path = u.pathname.replace(/^\/api\//, "").replace(/\.js$/, "").replace(/[^a-zA-Z0-9_-]/g, "_");
    const action = u.searchParams.get("action");
    return action ? `${path}_${action}` : path;
  } catch (_) { return "desconocido"; }
}
async function cronBeat(name, status, body, ms) {
  try {
    initApp();
    let resumen = "";
    try { resumen = typeof body === "string" ? body : JSON.stringify(body); } catch (_) { resumen = ""; }
    const ok = status < 400 && !(body && typeof body === "object" && body.error);
    await getFirestore().collection("system").doc("crons").set({
      [name]: { at: new Date(), ok, status, ms, resumen: String(resumen || "").slice(0, 400) },
    }, { merge: true });
  } catch (e) { console.warn("[cronBeat]", name, e.message); }
}
