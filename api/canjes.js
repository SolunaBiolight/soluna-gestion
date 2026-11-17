// api/canjes.js — Link del canje para el influencer (12/nov/2026, pedido de Lautaro).
//
// Cada canje tiene un link público #/canje/<portalToken> (el token lo genera el dueño desde Canjes y queda
// en canjes/{id}.portalToken). Ahí el influencer ve lo acordado, el plazo, la ficha de info de la marca
// (una para todos) y su guion (uno fijo de la lista de la cuenta o el personalizado de la tarea del
// guionista), y pega el link de cada pieza a medida que la sube. Nunca ve datos de otros canjes ni plata.
//
// Archivos (ficha y guiones fijos): colección server-only canjes_archivos/{id} {uid, tipo, nombre, mime,
// data(base64 ≤ 900.000), at}. La lista de guiones vive en users/{uid}.canjesGuiones [{id, nombre, texto,
// archivoId}] y la ficha en users/{uid}.canjesFicha {id, nombre} (las escribe este endpoint).
//
// Acciones del dueño (sesión, sección canjes): archivo_subir, archivo_ver, archivo_quitar, guion_guardar.
// Acciones públicas (por token, 40 por minuto por IP): portal, portal_archivo, portal_link,
// portal_subida_iniciar, portal_subida_fin.
//
// Material del influencer directo al Drive de la marca (17/nov/2026, pedido de Lautaro: "que no dependan
// de que yo les responda para subir el contenido"): desde su link sube los CRUDOS (obligatorio) y, si
// quiere, el EDITADO de cada pieza. El servidor arma la carpeta del influencer adentro de la carpeta madre
// de Canjes (users/{uid}.canjesDriveParent) o usa la del canje, con dos subcarpetas "Crudos" y "Editados",
// y abre una subida reanudable de Drive con el token del dueño; el navegador del influencer sube el
// archivo DIRECTO a Google (videos pesados sin pasar por Vercel) y al terminar `portal_subida_fin`
// verifica el archivo en Drive y lo registra en canjes/{id}.material [{id, piezaId, tipo, nombre, size,
// mime, driveId, link, at}]. La pieza pasa a "entregada" con el primer archivo, como con un link.
// Pendientes de subida en la colección server-only canjes_subidas/{sid} (se borran al terminar).

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { randomBytes } from "crypto";
import { requireUid } from "./_auth.js";
import { getValidDriveToken } from "./google-drive-callback.js";

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
  })});
  return getFirestore();
}

const MAX_B64 = 900000;
const PLAZO = 12;
const CERRADO = new Set(["Cerrado", "Finalizado", "Contenido entregado", "Cancelado"]);
const _rate = new Map();
function limitado(ip) {
  const ahora = Date.now(); const k = String(ip || "?");
  const l = (_rate.get(k) || []).filter(t => ahora - t < 60000); l.push(ahora); _rate.set(k, l);
  if (_rate.size > 5000) _rate.clear();
  return l.length > 40;
}
const ms = v => { const t = v?.toMillis ? v.toMillis() : v?._seconds ? v._seconds * 1000 : Date.parse(v || ""); return isFinite(t) ? t : null; };
const diaAR = t => new Date(t - 3 * 3600000).toISOString().slice(0, 10);

// Mismo cálculo que el front (ghPiezasDe / ghContenidoDePiezas / ghCanjeVence).
export function piezasDe(c) {
  if (Array.isArray(c?.piezas) && c.piezas.length) return c.piezas;
  const out = []; let k = 0;
  for (const x of c?.contenido || []) {
    const ac = Math.max(0, Number(x.acordados) || 0), en = Math.max(0, Number(x.entregados) || 0);
    for (let i = 0; i < ac; i++) out.push({ id: "m" + (k++), tipo: x.tipo || "", estado: i < en ? "entregada" : "pendiente", fechaLimite: "", link: "", nota: "" });
  }
  return out;
}
export function contenidoDePiezas(piezas) {
  const m = new Map();
  for (const p of piezas || []) { const k = p.tipo || "Otro"; const e = m.get(k) || { tipo: k, acordados: 0, entregados: 0 }; e.acordados++; if (p.estado && p.estado !== "pendiente") e.entregados++; m.set(k, e); }
  return [...m.values()];
}
export function venceDe(c) {
  if (c?.contenidoVence) return c.contenidoVence;
  const pz = (c?.piezas || []).filter(p => (p.estado || "pendiente") === "pendiente" && p.fechaLimite).map(p => p.fechaLimite).sort()[0];
  if (pz) return pz;
  const t = ms(c?.trackEntregadoAt); return t ? diaAR(t + PLAZO * 86400000) : "";
}
// Lo que el influencer carga: un link por pieza. Marca la pieza como entregada, recalcula los contadores
// y, si ya no falta nada, cierra el canje. Puro (tests en scripts/canjes_flujo_test.cjs).
export function aplicarLinkPieza(c, piezaId, link, ahoraIso) {
  const piezas = piezasDe(c).map(p => ({ ...p }));
  const p = piezas.find(x => String(x.id) === String(piezaId));
  if (!p) return null;
  // Un link que cargó la marca no lo puede borrar el influencer (solo reemplazarlo por otro).
  if (!link && p.link && !p.porInfluencer) return { bloqueado: true };
  p.link = link;
  if (link && (p.estado || "pendiente") === "pendiente") { p.estado = "entregada"; p.entregadaAt = ahoraIso; p.porInfluencer = true; }
  if (!link && p.porInfluencer && p.estado === "entregada") { p.estado = "pendiente"; delete p.entregadaAt; delete p.porInfluencer; }
  const upd = { piezas, contenido: contenidoDePiezas(piezas) };
  const todo = piezas.length > 0 && piezas.every(x => (x.estado || "pendiente") !== "pendiente");
  if (todo && !CERRADO.has(c.estado || "")) { upd.estado = "Cerrado"; upd.contenidoCompletoAt = ahoraIso; upd.finalizadoPor = "influencer"; }
  // Lo cerró el influencer y después borró un link: vuelve a "Contenido pendiente".
  if (!todo && c.estado === "Cerrado" && c.finalizadoPor === "influencer") { upd.estado = "Contenido pendiente"; upd.contenidoCompletoAt = null; upd.finalizadoPor = null; }
  return upd;
}
export const puedeCargar = c => !!(c?.trackEntregadoAt || String(c?.tracking || "").trim() || c?.estado === "Contenido pendiente" || (c?.estado === "Cerrado" && c?.finalizadoPor === "influencer"));
// Igual que aplicarLinkPieza pero por material subido (sin tocar el link). Pura.
export function aplicarMaterialPieza(c, piezaId, ahoraIso) {
  const piezas = piezasDe(c).map(p => ({ ...p }));
  const p = piezas.find(x => String(x.id) === String(piezaId));
  if (!p) return null;
  p.materialAt = ahoraIso;
  if ((p.estado || "pendiente") === "pendiente") { p.estado = "entregada"; p.entregadaAt = ahoraIso; p.porInfluencer = true; }
  const upd = { piezas, contenido: contenidoDePiezas(piezas) };
  const todo = piezas.length > 0 && piezas.every(x => (x.estado || "pendiente") !== "pendiente");
  if (todo && !CERRADO.has(c.estado || "")) { upd.estado = "Cerrado"; upd.contenidoCompletoAt = ahoraIso; upd.finalizadoPor = "influencer"; }
  return upd;
}
const folderIdDe = l => { const m = String(l || "").match(/\/folders\/([A-Za-z0-9_-]{10,})/) || String(l || "").match(/[?&]id=([A-Za-z0-9_-]{10,})/); return m ? m[1] : ""; };
const nomDrive = s => String(s || "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
const subidaDisponible = (u, c) => !!(u?.googleDrive?.refresh_token && (u?.canjesDriveParent?.id || c?.driveSubidas?.carpetaId || folderIdDe(c?.driveFolder)));
async function carpetaHija(H, parentId, nombre) {
  const q = encodeURIComponent(`'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and name='${nombre.replace(/'/g, "\\'")}' and trashed=false`);
  const ex = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,webViewLink)&supportsAllDrives=true&includeItemsFromAllDrives=true`, { headers: H, signal: AbortSignal.timeout(15000) });
  const exJ = await ex.json().catch(() => ({}));
  if (exJ.files?.[0]) return exJ.files[0];
  const r = await fetch("https://www.googleapis.com/drive/v3/files?fields=id,webViewLink&supportsAllDrives=true", { method: "POST", headers: H, body: JSON.stringify({ name: nombre, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`Drive no creó la carpeta "${nombre}" (HTTP ${r.status})`); e.status = r.status; throw e; }
  return j;
}
// Carpeta del influencer + Crudos / Editados, guardadas en el canje para no buscarlas cada vez.
async function carpetasCanje(db, dref, c, u, H) {
  const ds = c.driveSubidas || {};
  if (ds.carpetaId && ds.crudos && ds.editados) return ds;
  let carpetaId = ds.carpetaId || folderIdDe(c.driveFolder), carpetaLink = ds.carpetaLink || (carpetaId ? String(c.driveFolder || "") : "");
  if (!carpetaId) {
    if (!u.canjesDriveParent?.id) throw Object.assign(new Error("sin_carpeta"), { status: 409 });
    const usr = String(c.usuario || "").replace(/^@/, "").trim();
    const f = await carpetaHija(H, u.canjesDriveParent.id, nomDrive(`${c.influencer || "Influencer"}${usr ? " @" + usr : ""}`).slice(0, 120));
    carpetaId = f.id; carpetaLink = f.webViewLink || `https://drive.google.com/drive/folders/${f.id}`;
  }
  const cr = await carpetaHija(H, carpetaId, "Crudos"), ed = await carpetaHija(H, carpetaId, "Editados");
  const out = { carpetaId, carpetaLink: carpetaLink || `https://drive.google.com/drive/folders/${carpetaId}`, crudos: cr.id, editados: ed.id };
  await dref.update({ driveSubidas: out });
  return out;
}
const ORIGENES = ["https://www.growithapp.com", "https://growithapp.com", "https://soluna-gestion.vercel.app"];
const MAX_SUBIDA = 10 * 1024 * 1024 * 1024; // 10 GB por archivo
const linkOk = l => { const s = String(l || "").trim(); if (!s) return ""; const u = /^https?:\/\//i.test(s) ? s : "https://" + s; try { const x = new URL(u); return /^https?:$/.test(x.protocol) && x.hostname.includes(".") ? u.slice(0, 500) : null; } catch (_) { return null; } };

async function canjePorToken(db, t) {
  const tok = String(t || "").trim();
  if (!/^[a-f0-9]{16,64}$/i.test(tok)) return null;
  const s = await db.collection("canjes").where("portalToken", "==", tok).limit(1).get();
  return s.empty ? null : s.docs[0];
}

export default async function handler(req, res) {
  { const o = String(req.headers.origin || ""); if (["https://www.growithapp.com", "https://growithapp.com", "https://soluna-gestion.vercel.app"].includes(o) || /^http:\/\/localhost:\d+$/.test(o)) res.setHeader("Access-Control-Allow-Origin", o); }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  const body = req.method === "GET" ? (req.query || {}) : (typeof req.body === "object" && req.body ? req.body : {});
  const action = String(req.query?.action || body.action || "");
  try {
    const db = initAdmin();

    // ── Públicas (por token del canje) ──
    if (action.startsWith("portal")) {
      const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress;
      if (limitado(ip)) return res.status(429).json({ error: "Demasiados pedidos. Esperá un minuto." });
      const d = await canjePorToken(db, body.t);
      if (!d) return res.status(404).json({ error: "Este link no existe o ya no está activo. Pedile el link nuevo a la marca." });
      const c = d.data(); const uid = c.ownerId;
      const u = (await db.collection("users").doc(String(uid)).get()).data() || {};
      const guiones = Array.isArray(u.canjesGuiones) ? u.canjesGuiones : [];
      const guion = c.guionId ? guiones.find(g => g.id === c.guionId) || null : null;
      const ficha = u.canjesFicha?.id ? u.canjesFicha : null;

      if (action === "portal") {
        let guionLink = "";
        if (!guion && c.guionTareaId) {
          try { const t = (await db.collection("tareas").doc(String(c.guionTareaId)).get()).data(); if (t && t.uid === uid) { const dl = (t.deliverables || []).filter(x => x.link); guionLink = dl.length ? String(dl[dl.length - 1].link) : ""; } } catch (_) {}
        }
        const piezas = piezasDe(c).map(p => ({ id: p.id, tipo: p.tipo || "Contenido", estado: p.estado || "pendiente", link: p.link || "" }));
        return res.json({
          tienda: String(u.businessName || u.storeName || u.nombreTienda || (u.stores || [])[0]?.storeName || (u.stores || [])[0]?.name || "").trim() || "la marca",
          nombre: String(c.influencer || "").split(" ")[0] || "",
          usuario: c.usuario || "",
          productos: (c.productosCanje || []).map(x => ({ nombre: x.nombre, cantidad: x.cantidad || 1 })),
          estado: c.estado || "", entregado: !!c.trackEntregadoAt, tracking: c.tracking ? String(c.tracking).trim() : "",
          vence: venceDe(c), plazo: PLAZO, piezas, notaAcuerdo: String(c.acuerdoNota || "").slice(0, 1500),
          carpeta: /^https:\/\/(drive|docs)\.google\.com\//.test(String(c.driveFolder || "").trim()) ? String(c.driveFolder).trim() : "",
          anteojos: Number(c.anteojosAcordados) || 0,
          cupon: c.codigoDescuento ? { code: String(c.codigoDescuento).toUpperCase(), pct: Number(c.descuentoPct) || null } : null,
          web: /^https?:\/\/[^\s]+$/.test(String(u.canjesWeb || "")) ? String(u.canjesWeb) : "",
          pedido: c.pedidoRef ? String(c.pedidoRef) : "",
          puedeCargar: puedeCargar(c), cancelado: c.estado === "Cancelado",
          subida: subidaDisponible(u, c),
          material: (Array.isArray(c.material) ? c.material : []).map(m => ({ id: m.id, piezaId: m.piezaId || "", tipo: m.tipo, nombre: m.nombre, size: m.size || 0, at: m.at })),
          ficha: ficha ? { id: ficha.id, nombre: ficha.nombre || "Ficha de la marca" } : null,
          guion: guion ? { nombre: guion.nombre || "Guion", texto: String(guion.texto || "").slice(0, 20000), archivo: guion.archivoId ? { id: guion.archivoId, nombre: guion.archivoNombre || guion.nombre || "Guion" } : null }
            : guionLink ? { nombre: "Tu guion", link: guionLink } : c.guionTareaId ? { nombre: "Tu guion", pendiente: true } : null,
        });
      }
      if (action === "portal_archivo") {
        const id = String(body.id || "");
        const ok = (ficha && ficha.id === id) || (guion && guion.archivoId === id);
        if (!ok) return res.status(404).json({ error: "Archivo no encontrado" });
        const a = (await db.collection("canjes_archivos").doc(id).get()).data();
        if (!a || a.uid !== uid) return res.status(404).json({ error: "Archivo no encontrado" });
        return res.json({ nombre: a.nombre, mime: a.mime, data: a.data });
      }
      if (action === "portal_link") {
        if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
        if (CERRADO.has(c.estado || "") && c.finalizadoPor !== "influencer") return res.status(409).json({ error: "Este canje ya está cerrado." });
        // Recién se carga contenido con el paquete despachado (auditoría 12/nov/2026: antes, pegar links en
        // "Esperando pedido" cerraba el canje y nunca se despachaba).
        if (!puedeCargar(c)) return res.status(409).json({ error: "Todavía no te despachamos el paquete. Cuando esté en camino vas a poder dejar acá los links." });
        const link = linkOk(body.link);
        if (link === null) return res.status(400).json({ error: "Ese link no parece válido. Copiá el link de la publicación o del archivo." });
        const ahoraIso = new Date().toISOString();
        const upd = aplicarLinkPieza(c, body.piezaId, link, ahoraIso);
        if (!upd) return res.status(404).json({ error: "No encontré esa pieza." });
        if (upd.bloqueado) return res.status(409).json({ error: "Ese link lo cargó la marca. Si querés cambiarlo, pegá el nuevo." });
        await d.ref.update({ ...upd, ...(upd.estado === "Cerrado" ? { finalizadoAt: FieldValue.serverTimestamp() } : {}), influencerUltimoLinkAt: ahoraIso, updatedAt: FieldValue.serverTimestamp() });
        return res.json({ ok: true, cerrado: upd.estado === "Cerrado", piezas: upd.piezas.map(p => ({ id: p.id, tipo: p.tipo || "Contenido", estado: p.estado || "pendiente", link: p.link || "" })) });
      }
      if (action === "portal_subida_iniciar") {
        if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
        if (c.estado === "Cancelado") return res.status(409).json({ error: "Este canje está cancelado." });
        if (!puedeCargar(c)) return res.status(409).json({ error: "Todavía no te despachamos el paquete. Cuando esté en camino vas a poder subir el material." });
        if (!subidaDisponible(u, c)) return res.status(409).json({ error: "La marca todavía no activó la subida de archivos. Escribile por WhatsApp." });
        const tipo = body.tipo === "editado" ? "editado" : "crudo";
        const piezaId = String(body.piezaId || "");
        const pz = piezasDe(c).find(x => String(x.id) === piezaId);
        if (!pz) return res.status(404).json({ error: "No encontré esa pieza." });
        const size = Number(body.size) || 0, mime = String(body.mime || "application/octet-stream").slice(0, 100);
        if (size <= 0 || size > MAX_SUBIDA) return res.status(400).json({ error: "El archivo es demasiado grande (máximo 10 GB)." });
        if (!/^(video|image|audio)\//.test(mime) && !/\.(mov|mp4|m4v|heic|jpe?g|png|webp|avi|mkv|zip)$/i.test(String(body.nombre || ""))) return res.status(400).json({ error: "Subí videos, fotos o audios." });
        if ((Array.isArray(c.material) ? c.material.length : 0) >= 150) return res.status(409).json({ error: "Llegaste al máximo de archivos de este canje. Escribile a la marca." });
        let t; try { t = await getValidDriveToken(db, uid); } catch (_) { t = null; }
        if (!t) return res.status(409).json({ error: "La marca tiene que volver a conectar su Google Drive. Escribile por WhatsApp." });
        const H = { Authorization: `Bearer ${t.accessToken}`, "Content-Type": "application/json" };
        let ds;
        try { ds = await carpetasCanje(db, d.ref, c, u, H); }
        catch (e) { console.error("[canjes subida carpeta]", e.message); return res.status(502).json({ error: "No pudimos preparar la carpeta de la marca en Drive. Probá en un rato o avisale a la marca." }); }
        const piezas = piezasDe(c), mismas = piezas.filter(x => x.tipo === pz.tipo);
        const etiqueta = `${pz.tipo || "Contenido"}${mismas.length > 1 ? " " + (mismas.indexOf(pz) + 1) : ""}`;
        const fecha = diaAR(Date.now());
        const nombre = nomDrive(`${fecha} ${etiqueta} ${tipo} - ${String(body.nombre || "archivo")}`).slice(0, 200);
        const origin = ORIGENES.includes(String(req.headers.origin || "")) || /^http:\/\/localhost:\d+$/.test(String(req.headers.origin || "")) ? String(req.headers.origin) : ORIGENES[0];
        const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,size,webViewLink,parents", {
          method: "POST", headers: { ...H, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": mime, "X-Upload-Content-Length": String(size), Origin: origin },
          body: JSON.stringify({ name: nombre, parents: [tipo === "editado" ? ds.editados : ds.crudos], description: `Canje de ${c.influencer || ""} ${c.usuario ? "@" + String(c.usuario).replace(/^@/, "") : ""} · ${etiqueta} · ${tipo}` }),
          signal: AbortSignal.timeout(20000),
        });
        const url = r.headers.get("location");
        if (!r.ok || !url) { const j = await r.json().catch(() => ({})); console.error("[canjes subida]", r.status, j?.error?.message); return res.status(502).json({ error: "Drive no aceptó la subida. Probá de nuevo en un rato." }); }
        const sid = randomBytes(12).toString("hex");
        await db.collection("canjes_subidas").doc(sid).set({ canjeId: d.id, uid, piezaId, tipo, nombre, nombreOriginal: String(body.nombre || "").slice(0, 200), size, mime, folderId: tipo === "editado" ? ds.editados : ds.crudos, at: new Date().toISOString() });
        return res.json({ ok: true, sid, url });
      }
      if (action === "portal_subida_fin") {
        if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
        const sid = String(body.sid || ""); const fileId = String(body.fileId || "");
        if (!/^[a-f0-9]{24}$/.test(sid) || !/^[A-Za-z0-9_-]{10,120}$/.test(fileId)) return res.status(400).json({ error: "Datos inválidos" });
        const sref = db.collection("canjes_subidas").doc(sid); const sub = (await sref.get()).data();
        if (!sub || sub.canjeId !== d.id) return res.status(404).json({ error: "No encontré esa subida." });
        const t = await getValidDriveToken(db, uid).catch(() => null);
        if (!t) return res.status(409).json({ error: "La marca tiene que volver a conectar su Google Drive." });
        const fr = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,size,mimeType,webViewLink,parents&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${t.accessToken}` }, signal: AbortSignal.timeout(15000) });
        const f = await fr.json().catch(() => ({}));
        if (!fr.ok || !(f.parents || []).includes(sub.folderId)) return res.status(409).json({ error: "No encontramos el archivo en la carpeta de la marca. Probá subirlo de nuevo." });
        const ahoraIso = new Date().toISOString();
        const item = { id: sid, piezaId: sub.piezaId, tipo: sub.tipo, nombre: sub.nombreOriginal || f.name, size: Number(f.size) || sub.size, mime: f.mimeType || sub.mime, driveId: f.id, link: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`, at: ahoraIso };
        const fresco = (await d.ref.get()).data() || c;
        const upd = aplicarMaterialPieza(fresco, sub.piezaId, ahoraIso) || {};
        await d.ref.update({ ...upd, ...(upd.estado === "Cerrado" ? { finalizadoAt: FieldValue.serverTimestamp() } : {}), material: FieldValue.arrayUnion(item), influencerUltimoLinkAt: ahoraIso, updatedAt: FieldValue.serverTimestamp() });
        await sref.delete().catch(() => {});
        const piezasR = (upd.piezas || piezasDe(fresco)).map(p => ({ id: p.id, tipo: p.tipo || "Contenido", estado: p.estado || "pendiente", link: p.link || "" }));
        return res.json({ ok: true, cerrado: upd.estado === "Cerrado", piezas: piezasR, item: { id: item.id, piezaId: item.piezaId, tipo: item.tipo, nombre: item.nombre, size: item.size, at: item.at } });
      }
      return res.status(400).json({ error: "Acción desconocida" });
    }

    // ── Del dueño (sesión) ──
    const uid = String(body.uid || req.query?.uid || "");
    const g = await requireUid(req, uid, "canjes");
    if (!g.ok) return res.status(g.code).json({ error: g.error });
    const uref = db.collection("users").doc(uid);

    if (action === "archivo_subir") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
      const tipo = body.tipo === "ficha" ? "ficha" : "guion";
      const data = String(body.data || ""); const mime = String(body.mime || "application/pdf").slice(0, 80);
      if (!data || data.length > MAX_B64) return res.status(400).json({ error: "El archivo es muy grande (máximo ~650 KB). Comprimilo o subilo como PDF más liviano." });
      if (!/^(application\/pdf|image\/(png|jpe?g|webp))$/.test(mime)) return res.status(400).json({ error: "Tiene que ser un PDF o una imagen." });
      const id = randomBytes(10).toString("hex"); const nombre = String(body.nombre || "archivo").slice(0, 120);
      await db.collection("canjes_archivos").doc(id).set({ uid, tipo, nombre, mime, data, at: new Date().toISOString() });
      if (tipo === "ficha") {
        const prev = (await uref.get()).data()?.canjesFicha?.id;
        await uref.set({ canjesFicha: { id, nombre, at: new Date().toISOString() } }, { merge: true });
        if (prev && prev !== id) await db.collection("canjes_archivos").doc(prev).delete().catch(() => {});
      }
      return res.json({ ok: true, id, nombre });
    }
    if (action === "archivo_ver") {
      const a = (await db.collection("canjes_archivos").doc(String(body.id || "x")).get()).data();
      if (!a || a.uid !== uid) return res.status(404).json({ error: "No encontrado" });
      return res.json({ nombre: a.nombre, mime: a.mime, data: a.data });
    }
    if (action === "archivo_quitar") {
      const id = String(body.id || "x"); const ref = db.collection("canjes_archivos").doc(id);
      const a = (await ref.get()).data();
      if (a && a.uid === uid) await ref.delete();
      const u = (await uref.get()).data() || {};
      if (u.canjesFicha?.id === id) await uref.update({ canjesFicha: FieldValue.delete() });
      return res.json({ ok: true });
    }
    // Lista de guiones fijos: [{id, nombre, texto, archivoId, archivoNombre}] (el archivo se sube aparte).
    if (action === "guion_guardar") {
      if (req.method !== "POST") return res.status(405).json({ error: "POST requerido" });
      const lista = (Array.isArray(body.guiones) ? body.guiones : []).slice(0, 40).map(x => ({
        id: /^[a-z0-9]{6,32}$/i.test(String(x.id || "")) ? String(x.id) : randomBytes(6).toString("hex"),
        nombre: String(x.nombre || "Guion").slice(0, 80), texto: String(x.texto || "").slice(0, 20000),
        archivoId: /^[a-f0-9]{20}$/.test(String(x.archivoId || "")) ? String(x.archivoId) : "", archivoNombre: String(x.archivoNombre || "").slice(0, 120),
      }));
      const prev = (await uref.get()).data()?.canjesGuiones || [];
      const quedan = new Set(lista.map(x => x.archivoId).filter(Boolean));
      for (const p of prev) if (p.archivoId && !quedan.has(p.archivoId)) await db.collection("canjes_archivos").doc(p.archivoId).delete().catch(() => {});
      const extra = {};
      if (typeof body.web === "string") { const w = body.web.trim(); const u2 = w ? (/^https?:\/\//i.test(w) ? w : "https://" + w) : ""; extra.canjesWeb = /^https?:\/\/[^\s]+\.[^\s]+$/.test(u2) ? u2.slice(0, 200) : ""; }
      await uref.set({ canjesGuiones: lista, ...extra }, { merge: true });
      return res.json({ ok: true, guiones: lista, web: extra.canjesWeb });
    }
    return res.status(400).json({ error: "Acción desconocida" });
  } catch (e) {
    console.error("[canjes]", action, e);
    return res.status(500).json({ error: "Error interno. Probá de nuevo." });
  }
}
