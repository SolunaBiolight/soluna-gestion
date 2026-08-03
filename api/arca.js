// api/arca.js
// ARCA (ex-AFIP) — Facturación electrónica para Growith
// Soporta: parseo XLSX de ML / CSV de Shopify, emisión WSAA+WSFE, generación PDF, descarga ZIP
//
// Dependencias npm: node-forge (firma CMS), xlsx (parseo), pdf-lib (PDF), jszip (ZIP)
// Instalá: npm install node-forge xlsx pdf-lib jszip

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldPath } from "firebase-admin/firestore";
import { XMLParser } from "fast-xml-parser";
import { getValidMLToken } from "./integrations.js";
import { guardUid } from "./_auth.js";

// Con varios ML conectados, la facturación usa la cuenta elegida para VENTAS de
// ML (margenesMlVentas). Vacío = primera cuenta (1 solo ML, como siempre).
async function mlVentasAcc(db, uid) {
  try { const s = await db.collection("users").doc(uid).get(); return String(s.data()?.margenesMlVentas || "") || null; }
  catch(_) { return null; }
}

// Filtra valores basura ("?", "-", "—", "S/N", "N/A", "null", undefined) y arma una dirección legible.
// Plataforma de pago legible a partir del gateway de TN. La usa el filtro del
// facturador: la dueña factura a distintos CUITs según por dónde entró la plata.
function normPlataformaPago(gateway, method) {
  const g = String(gateway || "").toLowerCase();
  if (g.includes("mercadopago") || g.includes("mercado pago")) return "Mercado Pago";
  if (g.includes("nuvempago") || g.includes("nuvem") || g.includes("pago nube") || g.includes("pagonube")) return "Pago Nube";
  if (g === "offline" || g === "custom" || g.includes("transfer") || g.includes("personalizado")) return "Personalizado / Transferencia";
  if (g) return String(gateway); // otro gateway: mostrar como venga
  if (String(method || "") === "custom") return "Personalizado / Transferencia";
  return "";
}

function cleanAddr(parts) {
  // Sólo descartamos placeholders puros — "S/N" puede ser un número de calle real.
  const invalid = new Set(["", "?", "-", "—", "null", "undefined", "N/A", "n/a"]);
  return (parts || [])
    .map(p => (p == null ? "" : String(p).trim()))
    .filter(p => !invalid.has(p))
    .join(", ");
}

// Extrae DNI/CUIT del comprador de una orden de Tienda Nube.
// TN guarda el dato en varios lugares según versión del checkout y configuración del vendedor.
function extractTNDoc(o) {
  // 1) Campo estándar del checkout
  const candidates = [
    o.customer?.identification,
    o.contact_identification,
    o.customer?.tax_id,
    o.billing_identification,
    o.identification,
  ];
  for (const c of candidates) {
    const clean = String(c || "").replace(/[.\-\s]/g, "");
    if (/^\d{7,11}$/.test(clean)) return clean;
  }
  // 2) Buscar en la nota del comprador (a veces los clientes ponen "DNI 12345678")
  const noteText = String(o.note || o.owner_note || "");
  if (noteText) {
    const m = noteText.match(/\b(\d{7,11})\b/);
    if (m) return m[1];
  }
  return "";
}

// Extrae DNI/CUIT del comprador de una orden de Shopify.
// El truco es: Shopify no tiene campo nativo de DNI, así que reutilizamos el campo "Company"
// (Empresa) del checkout, que el vendedor renombra a "DNI o CUIT" en las traducciones.
function extractShopifyDoc(o) {
  // PASO 1 — Match exacto en campos donde el doc viene SOLO (sin texto extra).
  // Cubre la config más común: campo "Company" del checkout renombrado a
  // "DNI o CUIT", o note_attributes nominados.
  const candidates = [
    o.billing_address?.company,
    o.shipping_address?.company,
    o.customer?.note,
    o.note_attributes?.find(a => /(dni|cuit|cuil|tax)/i.test(a?.name||""))?.value,
    o.customer?.default_address?.company,
    ...((o.customer?.addresses || []).map(a => a?.company)),
    ...((String(o.customer?.tags || "").split(",")).map(t => {
      const m = t.match(/(?:CUIT|DNI|CUIL|TAX)[:\s]*([\d.\-]+)/i);
      return m ? m[1] : null;
    })),
  ];
  for (const c of candidates) {
    if (!c) continue;
    const clean = String(c).replace(/[.\-\s]/g, "");
    if (/^\d{7,11}$/.test(clean)) return clean;
  }

  // PASO 2 — Fallback agresivo: el merchant edita la orden o el customer en
  // Shopify Admin y pega el CUIT en CUALQUIER línea (address1, address2,
  // nombre del cliente, etc) — no necesariamente en "Company". Buscamos por
  // regex un número de 11 dígitos (CUIT/CUIL) en cualquier campo de texto,
  // priorizando CUIT (11) sobre DNI (7-8) porque el merchant edita
  // justamente para emitir Factura A.
  const fields = [
    o.billing_address?.address1,
    o.billing_address?.address2,
    o.billing_address?.name,
    o.shipping_address?.address1,
    o.shipping_address?.address2,
    o.shipping_address?.name,
    o.customer?.default_address?.address1,
    o.customer?.default_address?.address2,
    o.customer?.default_address?.name,
    o.customer?.first_name,
    o.customer?.last_name,
    o.customer?.note,
    o.note,
    ...((o.note_attributes || []).map(a => a?.value)),
    ...((o.customer?.addresses || []).flatMap(a => [a?.address1, a?.address2, a?.name])),
  ].filter(Boolean).map(String);

  // CUIT en alguno de los campos individuales (ignorando puntos/guiones)
  for (const f of fields) {
    const clean = f.replace(/[.\-\s]/g, "");
    const m = clean.match(/(?:^|[^\d])(2[0-7]\d{9}|3[03]\d{9})(?=$|[^\d])/);
    if (m) return m[1];
  }
  // DNI en alguno de los campos individuales (7-8 dígitos aislados)
  for (const f of fields) {
    const m = f.match(/(?:^|[^\d+])(\d{7,8})(?=$|[^\d])/);
    if (m) return m[1];
  }
  return "";
}

// ─── Inicialización Firebase ───────────────────────────

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
    }),
  });
  return getFirestore();
}

// ─── URLs ARCA ─────────────────────────────────────────

function arcaUrls(prod = true) {
  if (prod) return {
    wsaa: "https://wsaa.afip.gov.ar/ws/services/LoginCms",
    wsfe: "https://servicios1.afip.gov.ar/wsfev1/service.asmx",
  };
  return {
    wsaa: "https://wsaahomo.afip.gov.ar/ws/services/LoginCms",
    wsfe: "https://wswhomo.afip.gov.ar/wsfev1/service.asmx",
  };
}

// ─── Validación local del par cert/key (antes de pegarle a AFIP) ──

async function validarParCertKey(certPem, keyPem, arcaProd) {
  const forge = (await import("node-forge")).default;

  let cert, key;
  try { cert = forge.pki.certificateFromPem(certPem); }
  catch (e) { throw new Error("El archivo .crt no es un certificado PEM válido. Volvé a subir el archivo que te dio ARCA después de procesar el CSR."); }
  try { key = forge.pki.privateKeyFromPem(keyPem); }
  catch (e) { throw new Error("El archivo .key no es una clave privada PEM válida. Asegurate de subir el .key que se generó junto con tu CSR."); }

  // 1) ¿Coinciden cert y key? Comparamos el modulus de la pub del cert con el de la priv key
  const certMod = cert.publicKey.n.toString(16);
  const keyMod = key.n.toString(16);
  if (certMod !== keyMod) {
    throw new Error("El certificado y la clave privada no coinciden — son de pares distintos. Si generaste el CSR desde Growith, la .key correcta es la que descargaste en ese mismo momento. Si lo hiciste por afuera, asegurate de subir el .key que se creó junto con el .csr que enviaste a ARCA.");
  }

  // 2) ¿Está vencido o todavía no es válido?
  const now = new Date();
  if (cert.validity.notAfter < now) {
    const venc = cert.validity.notAfter.toLocaleDateString("es-AR");
    throw new Error(`El certificado venció el ${venc}. Generá uno nuevo en ARCA (Administración de Certificados Digitales → Nuevo Certificado).`);
  }
  if (cert.validity.notBefore > now) {
    throw new Error("El certificado todavía no es válido (fecha de inicio en el futuro). Verificá la fecha de tu sistema.");
  }

  // 3) ¿El certificado es del ambiente que el usuario seleccionó?
  // Los certs de homologación tienen el issuer "AFIP-CA-HOMO" o similar; los de prod tienen "MEDIACERT"/"AC AFIP" etc.
  const issuer = (cert.issuer.attributes || []).map(a => `${a.shortName || a.name}=${a.value}`).join(",").toLowerCase();
  const esHomologacion = issuer.includes("homo") || issuer.includes("test");
  if (arcaProd && esHomologacion) {
    throw new Error("Marcaste ambiente Producción pero el certificado es de Homologación (issuer contiene 'homo'). Generá un certificado de producción en arca.gob.ar (no en wsaahomo).");
  }
  if (!arcaProd && !esHomologacion && issuer.length > 0) {
    throw new Error("Marcaste ambiente Homologación pero el certificado parece de Producción. Para pruebas, generá el certificado en wsaahomo.afip.gov.ar.");
  }

  return { cert, key };
}

// ─── Firma TRA con node-forge (reemplaza openssl subprocess) ──

async function firmarTRA(certPem, keyPem, arcaProd) {
  const forge = (await import("node-forge")).default;

  // Validación local primero — atajamos los errores típicos antes de gastar un round-trip a AFIP
  const { cert, key } = await validarParCertKey(certPem, keyPem, arcaProd);

  const now = new Date();
  const gen = new Date(now.getTime() - 10 * 60000);
  const exp = new Date(now.getTime() + 10 * 60000);
  const fmt = (d) => d.toISOString().replace(/\.\d{3}Z$/, "-00:00");

  const tra = `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${Math.floor(now.getTime() / 1000)}</uniqueId>
    <generationTime>${fmt(gen)}</generationTime>
    <expirationTime>${fmt(exp)}</expirationTime>
  </header>
  <service>wsfe</service>
</loginTicketRequest>`;

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(tra, "utf8");
  p7.addCertificate(cert);
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [],
  });
  p7.sign({ detached: false });

  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return Buffer.from(der, "binary").toString("base64");
}

// ─── Login WSAA ────────────────────────────────────────

// Undici Agent para ARCA: bajamos el SECLEVEL porque AFIP usa DH keys cortas (legacy SSL).
// Sin esto, Node 18+ rechaza el handshake con ERR_SSL_DH_KEY_TOO_SMALL.
let _arcaDispatcher = null;
async function getArcaDispatcher() {
  if (_arcaDispatcher) return _arcaDispatcher;
  const { Agent } = await import("undici");
  _arcaDispatcher = new Agent({
    connect: {
      ciphers: "DEFAULT:@SECLEVEL=0",
    },
  });
  return _arcaDispatcher;
}

async function arcaFetch(url, opts = {}, timeoutMs = 45000) {
  const { fetch: undiciFetch } = await import("undici");
  const dispatcher = await getArcaDispatcher();
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await undiciFetch(url, {
      ...opts,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; GrowithApp/1.0)",
        ...(opts.headers || {}),
      },
      signal: controller.signal,
      dispatcher,
    });
  } finally {
    clearTimeout(tid);
  }
}

async function loginWSAA(cmsCms64, wsaaUrl) {
  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Body>
    <wsaa:loginCms>
      <wsaa:in0>${cmsCms64}</wsaa:in0>
    </wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`;

  let r;
  try {
    r = await arcaFetch(wsaaUrl, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" },
      body: soap,
    });
  } catch (e) {
    const cause = e.cause?.code || e.cause?.message || e.code || "";
    if (e.name === "AbortError") throw new Error("ARCA no respondió en 45 segundos — puede estar saturado. Probá de nuevo en un minuto.");
    throw new Error(`No se pudo conectar con WSAA (${wsaaUrl.replace(/^https?:\/\//,"").split("/")[0]}): ${e.message}${cause ? " — " + cause : ""}. Si persiste, ARCA puede estar caído o bloqueando la IP del server.`);
  }
  const rawText = await r.text();

  // WSAA devuelve el loginTicketResponse dentro de <loginCmsReturn> con entidades HTML escapadas
  // (&lt;token&gt;...&lt;/token&gt;). Decodificamos para poder hacer match.
  const decodeEntities = (s) => s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

  const text = decodeEntities(rawText);

  // Extraer token y sign del XML decodificado (puede venir con HTTP 200 o 500 si es fault)
  const tokenMatch = text.match(/<token>([\s\S]*?)<\/token>/);
  const signMatch = text.match(/<sign>([\s\S]*?)<\/sign>/);
  if (tokenMatch && signMatch) {
    // expirationTime del loginTicketResponse = hasta cuándo sirve este TA
    // (AFIP da 12 horas). Se devuelve para poder cachearlo y NO pedir un login
    // nuevo en cada request — WSAA rechaza los logins repetidos mientras el
    // ticket siga vivo ("El CEE ya posee un TA válido").
    const expMatch = text.match(/<expirationTime>([\s\S]*?)<\/expirationTime>/);
    let exp = null;
    if (expMatch) { const ms = Date.parse(expMatch[1].trim()); if (isFinite(ms)) exp = new Date(ms).toISOString(); }
    return { token: tokenMatch[1].trim(), sign: signMatch[1].trim(), exp };
  }

  // No vino token → leer el SOAP Fault para dar un mensaje útil
  const faultStringM = text.match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i);
  const faultCodeM = text.match(/<faultcode[^>]*>([\s\S]*?)<\/faultcode>/i);
  const faultString = faultStringM?.[1]?.trim() || "";
  const faultCode = faultCodeM?.[1]?.trim() || "";
  const low = (faultString + " " + faultCode).toLowerCase();

  let mensaje = "ARCA rechazó el login";
  let hint = "";

  if (low.includes("notauthorized") || low.includes("destino inv") || low.includes("computador no autorizado") || low.includes("ns1:cms.notauthorized")) {
    mensaje = "El certificado no está autorizado para emitir facturas";
    hint = " — En arca.gob.ar entrá a 'Administrador de Relaciones de Clave Fiscal' → Nueva Relación → Servicio 'Facturación Electrónica (WSFE)' → Representante: el Computador Fiscal asociado a tu certificado. Después esperá 5 minutos y volvé a intentar.";
  } else if (low.includes("cms.sign") || low.includes("sign.invalid") || low.includes("firma")) {
    mensaje = "La firma del certificado es inválida";
    hint = " — Suele pasar cuando el .crt y el .key no son del mismo par. Si generaste todo desde Growith, asegurate de subir la .key que descargaste en el mismo momento que el CSR.";
  } else if (low.includes("cms.cert.notfound") || low.includes("cert.notfound") || low.includes("certificado no encontrado")) {
    mensaje = "ARCA no encuentra registrado tu certificado";
    hint = " — Verificá en 'Administración de Certificados Digitales' que tu certificado esté activo (no revocado). También puede pasar si subiste un certificado del ambiente equivocado: los de homologación no sirven en producción y viceversa.";
  } else if (low.includes("cms.cert.untrusted") || low.includes("untrusted") || low.includes("no es de confianza")) {
    mensaje = "ARCA no confía en el certificado que subiste";
    hint = " — Suele pasar si subiste el CSR (el que vos enviaste a ARCA) en lugar del CRT (el que ARCA te devolvió firmado). En 'Administración de Certificados Digitales' bajá el archivo .crt y subí ese, no el .csr.";
  } else if (low.includes("expired") || low.includes("vencido")) {
    mensaje = "El certificado está vencido";
    hint = " — Generá uno nuevo en arca.gob.ar → Administración de Certificados Digitales → Nuevo Certificado.";
  } else if (low.includes("cms.bad.base64") || low.includes("bad.base64")) {
    mensaje = "ARCA no pudo decodificar el certificado";
    hint = " — El archivo .crt está corrupto. Volvé a descargarlo de ARCA y subilo de nuevo.";
  } else if (low.includes("ns1:cms")) {
    mensaje = "ARCA rechazó el certificado (error CMS)";
    hint = " — Típicamente: (a) el .crt y .key no coinciden, (b) el certificado es de un ambiente y estás conectándote al otro (homologación ↔ producción), o (c) el certificado fue revocado. Verificá los tres puntos.";
  } else if (faultString) {
    mensaje = `ARCA rechazó el login: ${faultString}`;
  } else {
    mensaje = `WSAA HTTP ${r.status}: respuesta inesperada`;
  }

  throw new Error(mensaje + hint);
}

// ─── Cache del Ticket de Acceso (TA) de WSAA ───────────
//
// El TA que devuelve WSAA dura 12 HORAS y AFIP rechaza los logins repetidos
// mientras siga vigente ("El CEE ya posee un TA válido"). Pedir uno nuevo en
// cada request, además de sumar 2-4s de handshake legacy a cada emisión, hace
// que con muchos CUITs facturando el servicio empiece a rebotar logins.
//
// Estrategia:
//   1. Cache en memoria del contenedor caliente (ni siquiera lee Firestore).
//   2. Cache persistente por CUIT + ambiente: users/{uid}/arca_ta/{cuit}_{amb}.
//   3. Se renueva solo cuando faltan menos de 10 minutos para el vencimiento.
//   4. Lock por transacción: dos requests simultáneos NO piden dos TAs — el que
//      no toma el lock espera a que el otro publique el ticket.
const TA_MARGEN_MS = 10 * 60000; // renovar si faltan menos de 10 min
const TA_LOCK_MS   = 60000;      // un lock más viejo que esto se da por muerto
const _taMem = new Map();        // "uid|cuit|amb" → { token, sign, exp }

function taVigente(d) {
  if (!d || !d.token || !d.sign || !d.exp) return false;
  const ms = Date.parse(d.exp);
  return isFinite(ms) && ms - Date.now() > TA_MARGEN_MS;
}
function taRef(db, uid, cuitNum, prod) {
  return db.collection("users").doc(uid).collection("arca_ta").doc(`${cuitNum}_${prod ? "prod" : "homo"}`);
}
// Se llama cuando cambia el certificado o la clave: el TA viejo ya no aplica.
async function invalidarTA(db, uid, cuitNum) {
  _taMem.delete(`${uid}|${cuitNum}|prod`);
  _taMem.delete(`${uid}|${cuitNum}|homo`);
  try {
    await Promise.all([
      taRef(db, uid, cuitNum, true).delete(),
      taRef(db, uid, cuitNum, false).delete(),
    ]);
  } catch (_) {}
}

async function obtenerTA(db, uid, cfg) {
  const cuitNum = String(cfg.cuit).replace(/\D/g, "");
  const prod = !!cfg.arca_prod;
  const memKey = `${uid}|${cuitNum}|${prod ? "prod" : "homo"}`;

  const enMem = _taMem.get(memKey);
  if (taVigente(enMem)) return enMem;

  const ref = taRef(db, uid, cuitNum, prod);
  const { wsaa } = arcaUrls(prod);

  // 1) ¿Hay uno guardado y todavía vigente?
  try {
    const snap = await ref.get();
    const d = snap.exists ? snap.data() : null;
    if (taVigente(d)) { _taMem.set(memKey, d); return d; }
  } catch (_) { /* si Firestore falla seguimos: mejor pedir el TA que no facturar */ }

  // 2) Tomar el lock (o descubrir que otro request ya lo publicó)
  let lockMio = false;
  try {
    const r = await db.runTransaction(async tx => {
      const s = await tx.get(ref);
      const d = s.exists ? s.data() : null;
      if (taVigente(d)) return { ta: d };
      const lockMs = d?.lockAt ? Date.parse(d.lockAt) : 0;
      if (lockMs && Date.now() - lockMs < TA_LOCK_MS) return { esperar: true };
      tx.set(ref, { lockAt: new Date().toISOString() }, { merge: true });
      return { lock: true };
    });
    if (r.ta) { _taMem.set(memKey, r.ta); return r.ta; }
    if (r.esperar) {
      // Otro request está pidiendo el TA en este momento: lo esperamos en vez
      // de disparar un segundo login que AFIP rechazaría.
      for (let i = 0; i < 12; i++) {
        await new Promise(res => setTimeout(res, 1200));
        const s = await ref.get();
        const d = s.exists ? s.data() : null;
        if (taVigente(d)) { _taMem.set(memKey, d); return d; }
      }
      // No apareció: el otro murió a mitad de camino, seguimos nosotros.
    } else {
      lockMio = !!r.lock;
    }
  } catch (_) { /* sin lock igual pedimos el TA: peor es no poder facturar */ }

  // 3) Login real contra WSAA
  try {
    const cms = await firmarTRA(cfg.cert_pem, cfg.key_pem, prod);
    const { token, sign, exp } = await loginWSAA(cms, wsaa);
    const ta = {
      token, sign,
      // Si AFIP no mandó expirationTime, asumimos 11h (una hora menos que las
      // 12 nominales) para no reusar un ticket ya vencido.
      exp: exp || new Date(Date.now() + 11 * 3600000).toISOString(),
      obtenidoAt: new Date().toISOString(),
      lockAt: null,
    };
    _taMem.set(memKey, ta);
    try { await ref.set(ta); } catch (_) {}
    return ta;
  } catch (e) {
    // Liberar el lock: si no, la próxima emisión se queda esperando un minuto.
    if (lockMio) { try { await ref.set({ lockAt: null }, { merge: true }); } catch (_) {} }
    throw e;
  }
}

// ─── Llamada WSFE ──────────────────────────────────────

// noRetry: FECAESolicitar NUNCA se reintenta a ciegas — un timeout no dice si
// AFIP procesó o no el comprobante, y reintentar puede duplicarlo. El que llama
// decide (consultando FECompConsultar) si el comprobante salió igual.
async function wsfeCall(action, bodyXml, wsfeUrl, noRetry = false) {
  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <soapenv:Body>
    <ar:${action}>
      ${bodyXml}
    </ar:${action}>
  </soapenv:Body>
</soapenv:Envelope>`;

  // FECAESolicitar con timeout más corto: un cuelgue no puede comerse el
  // presupuesto de tiempo del lote entero.
  const timeoutMs = action === "FECAESolicitar" ? 30000 : 45000;
  for (let intento = 0; intento < 3; intento++) {
    let r;
    try {
      r = await arcaFetch(wsfeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: `http://ar.gov.afip.dif.FEV1/${action}`,
        },
        body: soap,
      }, timeoutMs);
    } catch (e) {
      if (!noRetry && intento < 2) { await new Promise(res => setTimeout(res, (intento + 1) * 3000)); continue; }
      const cause = e.cause?.code || e.cause?.message || "";
      if (e.name === "AbortError") throw new Error(`WSFE no respondió en ${Math.round(timeoutMs / 1000)} segundos. Probá de nuevo.`);
      throw new Error(`No se pudo conectar con WSFE: ${e.message}${cause ? " — " + cause : ""}`);
    }
    const text = await r.text();
    if (r.ok) return text;
    if (!noRetry && r.status === 500 && intento < 2) {
      await new Promise(res => setTimeout(res, (intento + 1) * 3000));
      continue;
    }
    throw new Error(`WSFE HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
}

// Escapado XML para todo string interpolado en los SOAP (defensa anti-inyección).
const xmlEsc = s => String(s).replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));

// Separa los bloques de la respuesta de FECAESolicitar: <Errors> son errores
// reales del request, <Observaciones>/<Obs> son motivos de rechazo o avisos del
// detalle, y <Events> son informativos de AFIP (NUNCA deciden éxito/fallo).
function parseWsfeResultado(xml) {
  const caeM = xml.match(/<CAE>(\d+)<\/CAE>/);
  const vtoM = xml.match(/<CAEFchVto>(\d{8})<\/CAEFchVto>/);
  const resM = xml.match(/<Resultado>([AR])<\/Resultado>/);
  const errBlock = (xml.match(/<Errors>([\s\S]*?)<\/Errors>/) || [])[1] || "";
  const obsBlock = (xml.match(/<Observaciones>([\s\S]*?)<\/Observaciones>/) || [])[1] || "";
  const errCode = parseInt((errBlock.match(/<Code>(\d+)<\/Code>/) || [])[1]) || null;
  const errMsgs = [...errBlock.matchAll(/<Msg>([\s\S]*?)<\/Msg>/g)].map(m => m[1]).join(" ").trim();
  const obsCode = parseInt((obsBlock.match(/<Code>(\d+)<\/Code>/) || [])[1]) || null;
  const obsMsgs = [...obsBlock.matchAll(/<Msg>([\s\S]*?)<\/Msg>/g)].map(m => m[1]).join(" ").trim();
  const resultado = resM?.[1] || null;
  const cae = caeM?.[1] || null;
  let caeVto = vtoM?.[1] || null;
  if (caeVto) caeVto = `${caeVto.slice(6)}/${caeVto.slice(4, 6)}/${caeVto.slice(0, 4)}`;
  return {
    cae, cae_vto: caeVto, resultado,
    // Resultado=A con Obs: el comprobante es VÁLIDO — las obs se guardan aparte.
    obs: (errMsgs || (resultado === "A" ? "" : obsMsgs)).trim(),
    err_code: errCode || (resultado === "R" ? obsCode : null),
    obs_codigo: resultado === "A" ? obsCode : null,
    obs_msg: resultado === "A" ? obsMsgs : "",
  };
}

function authXml(token, sign, cuitNum) {
  return `<ar:Auth>
    <ar:Token>${xmlEsc(token)}</ar:Token>
    <ar:Sign>${xmlEsc(sign)}</ar:Sign>
    <ar:Cuit>${parseInt(cuitNum)}</ar:Cuit>
  </ar:Auth>`;
}

async function getUltimoCbte(token, sign, cuitNum, puntoVenta, tipoCbte, wsfeUrl) {
  const body = `${authXml(token, sign, cuitNum)}
    <ar:PtoVta>${parseInt(puntoVenta)}</ar:PtoVta>
    <ar:CbteTipo>${parseInt(tipoCbte)}</ar:CbteTipo>`;
  const xml = await wsfeCall("FECompUltimoAutorizado", body, wsfeUrl);
  // Un error de ARCA acá NO es "cero comprobantes": devolver 0 haría arrancar
  // la numeración de nuevo y AFIP rechazaría todo por correlatividad.
  const errBlock = (xml.match(/<Errors>([\s\S]*?)<\/Errors>/) || [])[1];
  if (errBlock && /<Code>\d+<\/Code>/.test(errBlock)) {
    const msg = ((errBlock.match(/<Msg>([\s\S]*?)<\/Msg>/) || [])[1] || "").trim();
    throw new Error("AFIP: " + (msg || "error consultando el último comprobante autorizado"));
  }
  const m = xml.match(/<CbteNro>(\d+)<\/CbteNro>/);
  return m ? parseInt(m[1]) : 0;
}

// Lista los puntos de venta reales del CUIT (FEParamGetPtosVenta). Incluye los
// dados de baja o bloqueados: su numeración histórica sigue viva en AFIP (ej:
// el PV viejo de Monotributo después de migrar a RI) y el resync la necesita.
async function getPtosVenta(token, sign, cuitNum, wsfeUrl) {
  const xml = await wsfeCall("FEParamGetPtosVenta", authXml(token, sign, cuitNum), wsfeUrl);
  const nros = [];
  const re = /<Nro>(\d+)<\/Nro>/g;
  let m;
  while ((m = re.exec(xml))) {
    const n = parseInt(m[1]);
    if (n && !nros.includes(n)) nros.push(n);
  }
  return nros;
}

// Consulta un comprobante ya emitido en ARCA y devuelve sus datos (receptor incluido).
// Útil para recuperar doc_tipo/doc_nro cuando se perdieron en Firestore pero AFIP los tiene.
// Devuelve { doc_tipo, doc_nro } si lo encontró, o { error } con el motivo del fallo.
async function consultarComprobante(token, sign, cuitNum, puntoVenta, tipoCbte, cbteNro, wsfeUrl) {
  tipoCbte = parseInt(tipoCbte); cbteNro = parseInt(cbteNro); puntoVenta = parseInt(puntoVenta);
  if (![tipoCbte, cbteNro, puntoVenta].every(Number.isFinite)) return { error: "parámetros de consulta inválidos (PV/tipo/número)" };
  const body = `${authXml(token, sign, cuitNum)}
    <ar:FeCompConsReq>
      <ar:CbteTipo>${tipoCbte}</ar:CbteTipo>
      <ar:CbteNro>${cbteNro}</ar:CbteNro>
      <ar:PtoVta>${puntoVenta}</ar:PtoVta>
    </ar:FeCompConsReq>`;
  let xml;
  try { xml = await wsfeCall("FECompConsultar", body, wsfeUrl); }
  catch (e) { return { error: `SOAP: ${e.message}` }; }
  // Errores reales de ARCA viven SOLO dentro de <Errors>. El bloque <Events>
  // trae avisos informativos (ej: recordatorio de Condición IVA receptor) que
  // NO son errores — no hay que confundirlos.
  const errBlock = (xml.match(/<Errors>([\s\S]*?)<\/Errors>/) || [])[1];
  const errMsg = errBlock && (errBlock.match(/<Msg>([\s\S]*?)<\/Msg>/) || [])[1];
  if (errMsg) return { error: `ARCA: ${errMsg.trim()}` };
  const docTipoNum = parseInt((xml.match(/<DocTipo>(\d+)<\/DocTipo>/) || [])[1] || "0");
  const docNroRaw = (xml.match(/<DocNro>(\d+)<\/DocNro>/) || [])[1] || "";
  if (!docTipoNum) return { error: `respuesta sin DocTipo (raw: ${xml.replace(/\s+/g, " ").slice(0, 180)})` };
  // 80=CUIT, 96=DNI, 99=Consumidor Final
  const docTipo = docTipoNum === 80 ? "CUIT" : docTipoNum === 96 ? "DNI" : docTipoNum === 99 ? "CF" : "";
  return { doc_tipo: docTipo, doc_nro: docNroRaw };
}

// Consulta COMPLETA de un comprobante autorizado (FECompConsultar) — para
// reconstruir registros perdidos de arca_comprobantes desde AFIP (resync_afip).
// Devuelve:
//   null            → AFIP no tiene ese comprobante (código 602: número no emitido)
//   { error }       → falla SOAP u otro error de ARCA
//   { fecha, total, neto, iva, exento, cae, cae_vto, doc_tipo, doc_nro }
async function consultarComprobanteCompleto(token, sign, cuitNum, puntoVenta, tipoCbte, cbteNro, wsfeUrl) {
  tipoCbte = parseInt(tipoCbte); cbteNro = parseInt(cbteNro); puntoVenta = parseInt(puntoVenta);
  if (![tipoCbte, cbteNro, puntoVenta].every(Number.isFinite)) return { error: "parámetros de consulta inválidos (PV/tipo/número)" };
  const body = `${authXml(token, sign, cuitNum)}
    <ar:FeCompConsReq>
      <ar:CbteTipo>${tipoCbte}</ar:CbteTipo>
      <ar:CbteNro>${cbteNro}</ar:CbteNro>
      <ar:PtoVta>${puntoVenta}</ar:PtoVta>
    </ar:FeCompConsReq>`;
  let xml;
  try { xml = await wsfeCall("FECompConsultar", body, wsfeUrl); }
  catch (e) { return { error: `SOAP: ${e.message}` }; }
  // Errores reales viven SOLO en <Errors> (los <Events> son avisos informativos).
  const errBlock = (xml.match(/<Errors>([\s\S]*?)<\/Errors>/) || [])[1];
  if (errBlock) {
    const code = (errBlock.match(/<Code>(\d+)<\/Code>/) || [])[1] || "";
    const msg = ((errBlock.match(/<Msg>([\s\S]*?)<\/Msg>/) || [])[1] || "").trim();
    // 602 = "no existen datos ... para ese comprobante": hueco real en la numeración
    if (code === "602" || /no existen datos/i.test(msg)) return null;
    return { error: `ARCA ${code}: ${msg}` };
  }
  const g = (tag) => ((xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [])[1] || "").trim();
  const resultado = g("Resultado");
  if (resultado === "R") return null; // rechazado: nunca fue un comprobante válido
  const fch = g("CbteFch"); // YYYYMMDD
  if (!/^\d{8}$/.test(fch)) return { error: `respuesta sin CbteFch (raw: ${xml.replace(/\s+/g, " ").slice(0, 180)})` };
  const total = parseFloat(g("ImpTotal")) || 0;
  const neto = parseFloat(g("ImpNeto")) || 0;
  const iva = parseFloat(g("ImpIVA")) || 0;
  const opEx = parseFloat(g("ImpOpEx")) || 0;
  const vto = g("FchVto");
  const docTipoNum2 = parseInt(g("DocTipo") || "0");
  return {
    fecha: fch, total, neto, iva,
    exento: opEx > 0 && iva === 0,
    cae: g("CodAutorizacion") || null,
    cae_vto: /^\d{8}$/.test(vto) ? `${vto.slice(6)}/${vto.slice(4, 6)}/${vto.slice(0, 4)}` : null,
    doc_tipo: docTipoNum2 === 80 ? "CUIT" : docTipoNum2 === 96 ? "DNI" : "",
    doc_nro: (g("DocNro") || "").replace(/\D/g, ""),
  };
}

// Feriados nacionales AR 2026-2027 (hardcoded — actualizar a futuro).
// Solo los inamovibles principales — los trasladables Buscan último día hábil.
const FERIADOS_AR = new Set([
  // 2026
  "2026-01-01","2026-02-16","2026-02-17","2026-03-24","2026-04-02","2026-04-03",
  "2026-05-01","2026-05-25","2026-06-15","2026-06-20","2026-07-09","2026-08-17",
  "2026-10-12","2026-11-23","2026-12-08","2026-12-25",
  // 2027
  "2027-01-01","2027-02-08","2027-02-09","2027-03-24","2027-03-26",
  "2027-05-01","2027-05-25","2027-06-21","2027-07-09","2027-08-16",
  "2027-10-11","2027-11-22","2027-12-08","2027-12-25",
]);

// "Hoy" en hora argentina (YYYY-MM-DD). Entre las 21 y las 24hs ART el día UTC
// ya cambió: usar toISOString() para fechas de comprobantes corría el día.
function hoyARISO() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
}

function esDiaHabil(date) {
  const dow = date.getUTCDay(); // 0=domingo, 6=sabado
  if (dow === 0 || dow === 6) return false;
  const iso = date.toISOString().slice(0, 10);
  return !FERIADOS_AR.has(iso);
}

// Devuelve YYYYMMDD del último día hábil del mes anterior al mes actual de ARG.
function ultimoDiaHabilMesAnterior() {
  const argFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit" });
  const parts = argFmt.formatToParts(new Date());
  const y = parseInt(parts.find(p => p.type === "year").value);
  const m = parseInt(parts.find(p => p.type === "month").value);
  const prevYear = m === 1 ? y - 1 : y;
  const prevMonth = m === 1 ? 12 : m - 1;
  // Último día del mes anterior
  let d = new Date(Date.UTC(prevYear, prevMonth, 0)); // truco: día 0 del mes siguiente = último día del anterior
  while (!esDiaHabil(d)) d.setUTCDate(d.getUTCDate() - 1);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

// Chequea si una fecha YYYYMMDD está dentro del rango válido para ARCA:
// WSFE exige que CbteFch esté en el rango N-5 / N+5 (siendo N la fecha del pedido).
// Usamos 5 días corridos hacia atrás como máximo para evitar rechazo TN-3526.
function fechaValida(yyyymmdd) {
  const y = parseInt(yyyymmdd.slice(0, 4));
  const m = parseInt(yyyymmdd.slice(4, 6));
  const d = parseInt(yyyymmdd.slice(6, 8));
  if (!y || !m || !d || m > 12 || d > 31) return { ok: false, msg: "Fecha inválida." };
  const target = new Date(Date.UTC(y, m - 1, d));
  // Ventana N-5 calculada contra el "hoy" argentino, no el día UTC.
  const [ty, tm, td] = hoyARISO().split("-").map(Number);
  const today = new Date(Date.UTC(ty, tm - 1, td));
  const diffDays = (today.getTime() - target.getTime()) / (24 * 60 * 60 * 1000);
  if (diffDays < 0) return { ok: false, msg: "No podés emitir facturas con fecha futura." };
  if (diffDays > 5) return { ok: false, msg: `La fecha ${String(d).padStart(2,"0")}/${String(m).padStart(2,"0")}/${y} está fuera del rango ARCA (máximo 5 días corridos hacia atrás). ARCA rechaza comprobantes con fecha anterior a N-5 (error TN-3526).` };
  return { ok: true };
}
function dentroDe10DiasCorridos(yyyymmdd) { return fechaValida(yyyymmdd).ok; }

// Condición frente al IVA del RECEPTOR (RG ARCA 5616 — obligatorio desde 01/06/2026)
// Tabla: https://www.afip.gob.ar/ws/documentacion/ws-factura-electronica.asp
//   1 = IVA Responsable Inscripto
//   4 = IVA Sujeto Exento
//   5 = Consumidor Final
//   6 = Responsable Monotributo
//   7 = Sujeto No Categorizado
//  13 = Monotributista Social
//  15 = IVA No Alcanzado
function condicionIvaReceptor(tipoCbte, docTipoClas) {
  // Factura A (1/2/3): receptor es siempre Responsable Inscripto
  if (tipoCbte === 1 || tipoCbte === 2 || tipoCbte === 3) return 1;
  // Factura B (6/7/8) con CUIT: AFIP NO acepta 1 (RI) ni 6 (Monotributo) en clase B
  // (esos receptores corresponden a Factura A). Sin padrón para saber la condición
  // real, el valor válido y neutro es 7 = Sujeto No Categorizado.
  if ((tipoCbte === 6 || tipoCbte === 7 || tipoCbte === 8) && docTipoClas === "CUIT") return 7;
  // Factura C (11/12/13) con CUIT: receptor probablemente Resp. Inscripto que compra a monotributo
  if ((tipoCbte === 11 || tipoCbte === 12 || tipoCbte === 13) && docTipoClas === "CUIT") return 1;
  // Cualquier otro caso: Consumidor Final
  return 5;
}

async function facturar(token, sign, cuitNum, puntoVenta, cbteNro, orden, tipoCbte, wsfeUrl, monotributo = false, fechaImputacion = null, exento = false) {
  // AFIP acepta máximo 2 decimales: los totales de ML suelen llegar con arrastre
  // de punto flotante (26999.999999999996) y el WS rechaza el ImpTotal.
  const total = Math.round(Number(orden.total) * 100) / 100;
  if (!Number.isFinite(total) || total <= 0) throw new Error(`Total de la orden inválido (${orden.total}) — no se envió a AFIP.`);
  // Nada no-numérico se interpola en el XML de AFIP.
  puntoVenta = parseInt(puntoVenta); cbteNro = parseInt(cbteNro); tipoCbte = parseInt(tipoCbte);
  if (![puntoVenta, cbteNro, tipoCbte].every(Number.isFinite)) throw new Error("Punto de venta, número o tipo de comprobante inválido — no se envió a AFIP.");
  const fecha = fechaImputacion || hoyARISO().replace(/-/g, "");

  const docTipoClas = orden.doc_tipo;
  const nroDocNum = parseInt(String(orden.doc_nro || orden.dni || "").replace(/\D/g, ""), 10);
  let tipoDoc, nroDoc, neto, iva;

  if (monotributo) {
    tipoCbte = 11;
    tipoDoc = docTipoClas === "CUIT" ? 80 : docTipoClas === "DNI" ? 96 : 99;
    nroDoc = tipoDoc === 99 ? 0 : nroDocNum;
    neto = total; iva = 0;
  } else {
    // Exento (ebooks/digitales, punto de venta exento): TODO el monto va como
    // operación exenta (ImpOpEx), sin neto gravado ni IVA. El resto (físicos) → 21%.
    if (exento) { neto = 0; iva = 0; }
    else { neto = Math.round((total / 1.21) * 100) / 100; iva = Math.round((total - neto) * 100) / 100; }
    if (docTipoClas === "CUIT") { tipoDoc = 80; nroDoc = nroDocNum; }
    else if (docTipoClas === "DNI") { tipoDoc = 96; nroDoc = nroDocNum; }
    else { tipoDoc = 99; nroDoc = 0; }
  }
  if (tipoDoc !== 99 && !Number.isFinite(nroDoc)) throw new Error(`Documento del receptor inválido (${docTipoClas} "${orden.doc_nro || orden.dni || ""}") — no se envió a AFIP.`);

  const condIva = condicionIvaReceptor(tipoCbte, docTipoClas);
  const impOpEx = (!monotributo && exento) ? total : 0; // monto exento (sin IVA)

  const ivaXml = (!monotributo && !exento && iva > 0) ? `
    <ar:Iva>
      <ar:AlicIva>
        <ar:Id>5</ar:Id>
        <ar:BaseImp>${neto.toFixed(2)}</ar:BaseImp>
        <ar:Importe>${iva.toFixed(2)}</ar:Importe>
      </ar:AlicIva>
    </ar:Iva>` : "";

  const body = `${authXml(token, sign, cuitNum)}
    <ar:FeCAEReq>
      <ar:FeCabReq>
        <ar:CantReg>1</ar:CantReg>
        <ar:PtoVta>${puntoVenta}</ar:PtoVta>
        <ar:CbteTipo>${tipoCbte}</ar:CbteTipo>
      </ar:FeCabReq>
      <ar:FeDetReq>
        <ar:FECAEDetRequest>
          <ar:Concepto>1</ar:Concepto>
          <ar:DocTipo>${tipoDoc}</ar:DocTipo>
          <ar:DocNro>${nroDoc}</ar:DocNro>
          <ar:CbteDesde>${cbteNro}</ar:CbteDesde>
          <ar:CbteHasta>${cbteNro}</ar:CbteHasta>
          <ar:CbteFch>${fecha}</ar:CbteFch>
          <ar:ImpTotal>${total.toFixed(2)}</ar:ImpTotal>
          <ar:ImpTotConc>0</ar:ImpTotConc>
          <ar:ImpNeto>${neto.toFixed(2)}</ar:ImpNeto>
          <ar:ImpOpEx>${impOpEx.toFixed(2)}</ar:ImpOpEx>
          <ar:ImpTrib>0</ar:ImpTrib>
          <ar:ImpIVA>${iva.toFixed(2)}</ar:ImpIVA>
          <ar:MonId>PES</ar:MonId>
          <ar:MonCotiz>1</ar:MonCotiz>
          <ar:CondicionIVAReceptorId>${condIva}</ar:CondicionIVAReceptorId>
          ${ivaXml}
        </ar:FECAEDetRequest>
      </ar:FeDetReq>
    </ar:FeCAEReq>`;

  const xml = await wsfeCall("FECAESolicitar", body, wsfeUrl, true);
  return parseWsfeResultado(xml);
}

// ¿El rechazo de AFIP es por validación del RECEPTOR (CUIT inexistente,
// DocTipo/DocNro inválido, condición IVA)? Solo en ese caso tiene sentido el
// fallback A→B. Nunca ante errores genéricos, de red, de correlatividad
// (10016) ni de token (600/601).
function esRechazoReceptor(result) {
  const code = parseInt(result?.err_code) || 0;
  if ([10013, 10015, 10018].includes(code)) return true;
  if ([600, 601, 10016].includes(code)) return false;
  return /DocNro|DocTipo|no se encuentra|condici[oó]n/i.test(String(result?.obs || ""));
}

// ─── Helper: desadjuntar TODOS los documentos fiscales adjuntos a una venta ML ──
// ML expone varios endpoints según versión. Probamos en orden:
//   1) /packs/{pack_id}/fiscal_documents → DELETE /packs/{pack_id}/fiscal_documents/{doc_id}
//   2) /sites/MLA/fiscal_documents?orders={order_id} → DELETE /fiscal_documents/{doc_id}
//   3) /orders/{order_id}/fiscal_documents
// Si ninguno responde con docs, devolvemos { ok: false, reason }.
async function desadjuntarFacturaML(db, uid, orderIdFull) {
  try {
    const ml = await getValidMLToken(db, uid, await mlVentasAcc(db, uid));
    if (!ml?.accessToken) return { ok: false, reason: "ml_no_token" };
    const orderIdNum = String(orderIdFull).replace("ML-", "");

    // Resolver pack_id (puede ser igual a order_id si la venta no está en un pack)
    let packId = orderIdNum;
    try {
      const ordRes = await fetch(`https://api.mercadolibre.com/orders/${orderIdNum}?attributes=pack_id`, {
        headers: { Authorization: `Bearer ${ml.accessToken}` },
      });
      if (ordRes.ok) {
        const ordJ = await ordRes.json();
        if (ordJ.pack_id) packId = ordJ.pack_id;
      }
    } catch (_) {}

    const triedEndpoints = [];
    const auth = { Authorization: `Bearer ${ml.accessToken}` };

    // Helper para listar docs en un endpoint y borrar cada uno
    const tryListAndDelete = async (listUrl, deleteUrlBuilder) => {
      try {
        const r = await fetch(listUrl, { headers: auth });
        triedEndpoints.push({ url: listUrl, status: r.status });
        if (!r.ok) return { count: 0, errors: [`list ${r.status}`] };
        const j = await r.json();
        const docs = Array.isArray(j) ? j : (j?.fiscal_documents || j?.documents || j?.results || []);
        const errors = [];
        let deleted = 0;
        for (const doc of docs) {
          const docId = doc.id || doc.fiscal_document_id || doc.document_id || doc.uuid;
          if (!docId) continue;
          try {
            const delUrl = deleteUrlBuilder(docId);
            const dr = await fetch(delUrl, { method: "DELETE", headers: auth });
            triedEndpoints.push({ url: delUrl, status: dr.status, method: "DELETE" });
            if (dr.ok) deleted++;
            else errors.push(`delete ${docId} → ${dr.status}`);
          } catch (e) { errors.push(`delete ${docId} → ${e.message}`); }
        }
        return { count: deleted, errors };
      } catch (e) { return { count: 0, errors: [e.message] }; }
    };

    // Intento 1: /packs/{pack_id}/fiscal_documents
    let r1 = await tryListAndDelete(
      `https://api.mercadolibre.com/packs/${packId}/fiscal_documents`,
      (docId) => `https://api.mercadolibre.com/packs/${packId}/fiscal_documents/${docId}`
    );
    if (r1.count > 0) return { ok: true, deleted: r1.count, endpoint: "packs/{pack_id}", tried: triedEndpoints };

    // Intento 2: /orders/{order_id}/fiscal_documents
    let r2 = await tryListAndDelete(
      `https://api.mercadolibre.com/orders/${orderIdNum}/fiscal_documents`,
      (docId) => `https://api.mercadolibre.com/orders/${orderIdNum}/fiscal_documents/${docId}`
    );
    if (r2.count > 0) return { ok: true, deleted: r2.count, endpoint: "orders/{id}", tried: triedEndpoints };

    // Reason más específico según lo que pasó
    const lastStatus = triedEndpoints.length ? triedEndpoints[triedEndpoints.length - 1].status : null;
    let reason = "no_docs_or_delete_unsupported";
    if (lastStatus === 401 || lastStatus === 403) reason = `ML rechazó la operación (HTTP ${lastStatus}) — falta permiso en la app o token vencido`;
    else if (lastStatus === 404) reason = "ML no encontró documentos adjuntos en este pack (ya estaba limpio o nunca se subió)";
    else if (lastStatus === 405 || lastStatus === 501) reason = "ML no permite eliminar este documento vía API — borrar manualmente desde el panel de Mercado Libre";
    else if (triedEndpoints.length === 0) reason = "no se pudo contactar a ML";
    return { ok: false, reason, tried: triedEndpoints, errors: [...r1.errors, ...r2.errors] };
  } catch (e) {
    return { ok: false, reason: "exception", error: e.message };
  }
}

// ─── Nota de Crédito (anula factura emitida) ──────────────
// Mapeo Factura → Nota de Crédito correspondiente:
//   Factura A (1)  → Nota de Crédito A (3)
//   Factura B (6)  → Nota de Crédito B (8)
//   Factura C (11) → Nota de Crédito C (13)
function tipoNCparaFactura(tipoFactura) {
  if (tipoFactura === 1) return 3;
  if (tipoFactura === 6) return 8;
  if (tipoFactura === 11) return 13;
  // Default: NC B
  return 8;
}

async function emitirNotaCredito(token, sign, cuitNum, puntoVenta, cbteNcNro, facturaOriginal, wsfeUrl) {
  // facturaOriginal: { tipo, punto_venta, comprobante, total, doc_tipo, doc_nro, fecha_iso, monotributo }
  const tipoFactura = parseInt(facturaOriginal.tipo) || 6;
  const tipoNC = tipoNCparaFactura(tipoFactura);
  const monotributo = tipoFactura === 11;
  // Exento: la NC replica el esquema impositivo de la factura original (ImpOpEx)
  const exento = !monotributo && facturaOriginal.exento === true;
  const total = Math.round((parseFloat(facturaOriginal.total) || 0) * 100) / 100;
  const fecha = hoyARISO().replace(/-/g, "");
  // Numéricos duros: nada no-numérico se interpola en el XML de AFIP
  const nroAsoc = parseInt(facturaOriginal.comprobante);
  const pvAsoc = parseInt(facturaOriginal.punto_venta) || parseInt(puntoVenta);
  if (!Number.isFinite(nroAsoc) || !Number.isFinite(pvAsoc)) throw new Error("Número o punto de venta de la factura original inválido — la NC no se envió a AFIP.");
  puntoVenta = parseInt(puntoVenta); cbteNcNro = parseInt(cbteNcNro);
  if (![puntoVenta, cbteNcNro].every(Number.isFinite)) throw new Error("Punto de venta o número de la NC inválido — no se envió a AFIP.");

  const docTipoClas = facturaOriginal.doc_tipo;
  // Factura A → NC A requiere SIEMPRE CUIT del receptor (no se puede a Consumidor Final)
  if (tipoFactura === 1 || tipoFactura === 2 || tipoFactura === 3) {
    if (docTipoClas !== "CUIT" || !facturaOriginal.doc_nro) {
      return {
        cae: null, cae_vto: null, resultado: "R",
        obs: `Factura A original no tiene CUIT del receptor registrado en Growith (doc_tipo="${docTipoClas||""}", doc_nro="${facturaOriginal.doc_nro||""}"). NC A requiere CUIT obligatorio. Editá los datos del receptor o emití la NC manualmente desde el portal ARCA.`,
        tipo_nc: tipoNC, comprobante: cbteNcNro, neto: 0, iva: 0, total,
      };
    }
  }
  const nroDocNum = parseInt(String(facturaOriginal.doc_nro || "").replace(/\D/g, ""), 10);
  let tipoDoc, nroDoc, neto, iva;
  if (monotributo) {
    tipoDoc = docTipoClas === "CUIT" ? 80 : docTipoClas === "DNI" ? 96 : 99;
    nroDoc = tipoDoc === 99 ? 0 : nroDocNum;
    neto = total; iva = 0;
  } else if (exento) {
    // Factura original exenta: la NC declara todo como ImpOpEx, sin neto ni IVA
    neto = 0; iva = 0;
    if (docTipoClas === "CUIT") { tipoDoc = 80; nroDoc = nroDocNum; }
    else if (docTipoClas === "DNI") { tipoDoc = 96; nroDoc = nroDocNum; }
    else { tipoDoc = 99; nroDoc = 0; }
  } else {
    neto = Math.round((total / 1.21) * 100) / 100;
    iva = Math.round((total - neto) * 100) / 100;
    if (docTipoClas === "CUIT") { tipoDoc = 80; nroDoc = nroDocNum; }
    else if (docTipoClas === "DNI") { tipoDoc = 96; nroDoc = nroDocNum; }
    else { tipoDoc = 99; nroDoc = 0; }
  }
  if (tipoDoc !== 99 && !Number.isFinite(nroDoc)) throw new Error(`Documento del receptor inválido (${docTipoClas} "${facturaOriginal.doc_nro || ""}") — la NC no se envió a AFIP.`);

  const condIva = condicionIvaReceptor(tipoNC, docTipoClas);
  const impOpEx = exento ? total : 0;
  const ivaXml = (!monotributo && !exento && iva > 0) ? `
    <ar:Iva>
      <ar:AlicIva>
        <ar:Id>5</ar:Id>
        <ar:BaseImp>${neto.toFixed(2)}</ar:BaseImp>
        <ar:Importe>${iva.toFixed(2)}</ar:Importe>
      </ar:AlicIva>
    </ar:Iva>` : "";

  // CbtesAsoc: vincula la NC con la factura original — requerido por ARCA
  // para que se compute como reverso correcto y libere el IVA débito fiscal.
  const cbtesAsocXml = `
        <ar:CbtesAsoc>
          <ar:CbteAsoc>
            <ar:Tipo>${tipoFactura}</ar:Tipo>
            <ar:PtoVta>${pvAsoc}</ar:PtoVta>
            <ar:Nro>${nroAsoc}</ar:Nro>
            <ar:Cuit>${parseInt(cuitNum)}</ar:Cuit>
          </ar:CbteAsoc>
        </ar:CbtesAsoc>`;

  const body = `${authXml(token, sign, cuitNum)}
    <ar:FeCAEReq>
      <ar:FeCabReq>
        <ar:CantReg>1</ar:CantReg>
        <ar:PtoVta>${puntoVenta}</ar:PtoVta>
        <ar:CbteTipo>${tipoNC}</ar:CbteTipo>
      </ar:FeCabReq>
      <ar:FeDetReq>
        <ar:FECAEDetRequest>
          <ar:Concepto>1</ar:Concepto>
          <ar:DocTipo>${tipoDoc}</ar:DocTipo>
          <ar:DocNro>${nroDoc}</ar:DocNro>
          <ar:CbteDesde>${cbteNcNro}</ar:CbteDesde>
          <ar:CbteHasta>${cbteNcNro}</ar:CbteHasta>
          <ar:CbteFch>${fecha}</ar:CbteFch>
          <ar:ImpTotal>${total.toFixed(2)}</ar:ImpTotal>
          <ar:ImpTotConc>0</ar:ImpTotConc>
          <ar:ImpNeto>${neto.toFixed(2)}</ar:ImpNeto>
          <ar:ImpOpEx>${impOpEx.toFixed(2)}</ar:ImpOpEx>
          <ar:ImpTrib>0</ar:ImpTrib>
          <ar:ImpIVA>${iva.toFixed(2)}</ar:ImpIVA>
          <ar:MonId>PES</ar:MonId>
          <ar:MonCotiz>1</ar:MonCotiz>
          <ar:CondicionIVAReceptorId>${condIva}</ar:CondicionIVAReceptorId>
          ${cbtesAsocXml}
          ${ivaXml}
        </ar:FECAEDetRequest>
      </ar:FeDetReq>
    </ar:FeCAEReq>`;

  const xml = await wsfeCall("FECAESolicitar", body, wsfeUrl, true);
  const parsed = parseWsfeResultado(xml);
  return { ...parsed, tipo_nc: tipoNC, comprobante: cbteNcNro, neto, iva, total };
}

// ─── Parseo XLSX de Mercado Libre ─────────────────────

function clasificarDoc(numStr) {
  const s = String(numStr || "").replace(/\D/g, "");
  if (s.length === 11) {
    const mult = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    const suma = mult.reduce((acc, m, i) => acc + parseInt(s[i]) * m, 0);
    const resto = suma % 11;
    const verificador = resto === 0 ? 0 : resto === 1 ? 9 : 11 - resto;
    if (verificador === parseInt(s[10])) return { doc_tipo: "CUIT", doc_nro: s };
  }
  if (s.length >= 7 && s.length <= 8) return { doc_tipo: "DNI", doc_nro: s };
  return { doc_tipo: "CF", doc_nro: "" };
}

async function parsearXlsxML(buffer) {
  const XLSX = (await import("xlsx")).default;
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

  // Header en fila 5 (0-based), datos desde fila 6
  const C_ORDER=0, C_FECHA=1, C_ESTADO=2, C_UNIDADES=6, C_INGRESOS=7,
    C_TITULO=24, C_VARIANTE=25, C_PRECIO_UNIT=26, C_NOMBRE=33,
    C_DNI=35, C_CIUDAD=37, C_PROVINCIA=38, C_RECLAMO=61, C_MEDIACION=63;

  const ordenes = {};
  for (const row of rows.slice(6)) {
    const orderId = String(row[C_ORDER] || "").trim();
    if (!orderId) continue;
    const estado = String(row[C_ESTADO] || "").toLowerCase();
    if (["cancel", "devuel", "reembols"].some(x => estado.includes(x))) continue;
    const reclamo = String(row[C_RECLAMO] || "").trim().toLowerCase();
    const mediacion = String(row[C_MEDIACION] || "").trim().toLowerCase();
    if (reclamo.startsWith("s") || mediacion.startsWith("s")) continue;

    const nombre = String(row[C_NOMBRE] || "").trim();
    const dniRaw = String(row[C_DNI] || "").trim().replace(/[.\-]/g, "");
    const clas = clasificarDoc(dniRaw);
    const cantidad = parseInt(row[C_UNIDADES]) || 1;
    const precioUnit = parseFloat(row[C_PRECIO_UNIT]) || 0;
    const ingresos = parseFloat(row[C_INGRESOS]) || 0;
    const totalFila = ingresos || (cantidad * precioUnit);
    const titulo = String(row[C_TITULO] || "").trim();
    const variante = String(row[C_VARIANTE] || "").trim();
    const nombreItem = titulo ? (variante ? `${titulo} (${variante})` : titulo) : "Suplemento dietetico";

    const item = { nombre: nombreItem, nombre_original: nombreItem, cantidad, precio: precioUnit || (totalFila / cantidad), descuento_item: 0 };

    if (ordenes[orderId]) {
      ordenes[orderId].items.push(item);
      ordenes[orderId].total += totalFila;
    } else {
      ordenes[orderId] = {
        nombre, email: "", dni: dniRaw, ...clas,
        total: totalFila, subtotal: totalFila, descuento: 0, envio: 0,
        estado_pago: "paid",
        fecha: String(row[C_FECHA] || "").trim(),
        ciudad: String(row[C_CIUDAD] || "").trim(),
        provincia: String(row[C_PROVINCIA] || "").trim(),
        metodo_pago: "Mercado Pago",
        items: [item],
      };
    }
  }
  return ordenes;
}

// Parser CSV con soporte para valores entre comillas (maneja ; dentro de "..." sin romper)
function splitCsvLine(line, sep) {
  const out = []; let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i+1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === sep && !inQ) {
      out.push(cur); cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map(v => v.trim());
}

async function parsearCSV(buffer) {
  // Detectar formato: TN usa ";" y Latin1; Shopify usa "," y UTF-8
  const head = buffer.slice(0, 600).toString("utf-8");
  const headLatin = buffer.slice(0, 600).toString("latin1");
  const isTN = (head.includes(";") && (head.includes("Nombre del comprador") || headLatin.includes("Número de orden") || head.includes("Número de orden") || head.includes("DNI / CUIT")));

  if (isTN) return parsearCSVtn(buffer);
  return parsearCSVshopify(buffer);
}

async function parsearCSVshopify(buffer) {
  const text = buffer.toString("utf-8");
  const lines = text.split("\n");
  const headers = splitCsvLine(lines[0], ",");
  const ordenes = {};
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const vals = splitCsvLine(line, ",");
    const row = Object.fromEntries(headers.map((h, i) => [h, vals[i] || ""]));
    const orderId = row["Name"];
    if (!orderId) continue;
    const clas = clasificarDoc(row["Billing Company"] || "");
    if (!ordenes[orderId]) {
      ordenes[orderId] = {
        nombre: row["Billing Name"] || "", email: row["Email"] || "",
        dni: clas.doc_nro || row["Billing Company"] || "", ...clas,
        total: parseFloat(row["Total"]) || 0,
        subtotal: parseFloat(row["Subtotal"]) || 0,
        descuento: parseFloat(row["Discount Amount"]) || 0,
        envio: parseFloat(row["Shipping"]) || 0,
        estado_pago: row["Financial Status"] || "",
        fecha: row["Paid at"] || row["Created at"] || "",
        ciudad: row["Billing City"] || "",
        provincia: row["Billing Province Name"] || row["Billing Province"] || "",
        metodo_pago: row["Payment Method"] || "",
        items: [],
      };
    }
    const nombreItem = (row["Lineitem name"] || "Producto").trim();
    ordenes[orderId].items.push({
      nombre: nombreItem, nombre_original: nombreItem,
      cantidad: parseInt(row["Lineitem quantity"]) || 1,
      precio: parseFloat(row["Lineitem price"]) || 0,
      descuento_item: parseFloat(row["Lineitem discount"]) || 0,
    });
  }
  return ordenes;
}

async function parsearCSVtn(buffer) {
  // TN exporta en Latin1 (ISO-8859-1) con separador ; y filas múltiples por orden
  const text = buffer.toString("latin1");
  const lines = text.split(/\r?\n/);
  const headers = splitCsvLine(lines[0], ";").map(h => h.replace(/^"|"$/g, "").trim());

  // Índices de columnas
  const idx = (name) => headers.findIndex(h => h === name);
  const I = {
    orderId: idx("Número de orden"),
    email: idx("Email"),
    fecha: idx("Fecha"),
    estadoOrden: idx("Estado de la orden"),
    estadoPago: idx("Estado del pago"),
    subtotal: idx("Subtotal de productos"),
    descuento: idx("Descuento"),
    envio: idx("Costo de envío"),
    total: idx("Total"),
    nombre: idx("Nombre del comprador"),
    docNro: idx("DNI / CUIT"),
    direccion: idx("Dirección"),
    ciudad: idx("Ciudad"),
    provincia: idx("Provincia o estado"),
    medioPago: idx("Medio de pago"),
    fechaPago: idx("Fecha de pago"),
    producto: idx("Nombre del producto"),
    precio: idx("Precio del producto"),
    cantidad: idx("Cantidad del producto"),
    sku: idx("SKU"),
  };

  const ordenes = {};
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const vals = splitCsvLine(line, ";").map(v => v.replace(/^"|"$/g, ""));
    const orderId = vals[I.orderId];
    if (!orderId) continue;

    const nombreProd = vals[I.producto] || "";
    if (!nombreProd) continue;

    const cantidad = parseInt(vals[I.cantidad]) || 1;
    const precio = parseFloat(vals[I.precio]) || 0;

    if (!ordenes[orderId]) {
      // Primera fila: tiene datos del comprador
      const estadoOrden = (vals[I.estadoOrden] || "").toLowerCase();
      const estadoPago = (vals[I.estadoPago] || "").toLowerCase();
      // Filtrar canceladas y no pagadas
      if (estadoOrden.includes("cancel") || estadoOrden.includes("reembolso")) continue;

      const docRaw = (vals[I.docNro] || "").replace(/[.\-]/g, "").trim();
      const clas = clasificarDoc(docRaw);
      ordenes[orderId] = {
        nombre: vals[I.nombre] || "",
        email: vals[I.email] || "",
        dni: docRaw, ...clas,
        total: parseFloat(vals[I.total]) || 0,
        subtotal: parseFloat(vals[I.subtotal]) || 0,
        descuento: parseFloat(vals[I.descuento]) || 0,
        envio: parseFloat(vals[I.envio]) || 0,
        estado_pago: (estadoPago === "recibido" || estadoPago === "paid") ? "paid" : estadoPago,
        fecha: vals[I.fechaPago] || vals[I.fecha] || "",
        ciudad: vals[I.ciudad] || "",
        provincia: vals[I.provincia] || "",
        direccion: vals[I.direccion] || "",
        metodo_pago: vals[I.medioPago] || "",
        items: [{
          nombre: nombreProd, nombre_original: nombreProd,
          cantidad, precio, descuento_item: 0,
        }],
      };
    } else {
      // Fila adicional: solo agrega un item
      ordenes[orderId].items.push({
        nombre: nombreProd, nombre_original: nombreProd,
        cantidad, precio, descuento_item: 0,
      });
    }
  }
  return ordenes;
}

// ─── Generación PDF con pdf-lib ────────────────────────

// Genera el QR de ARCA según especificación oficial AFIP
// https://www.afip.gob.ar/fe/qr/especificaciones.asp
async function generarQrArca(factData, config) {
  const QRCode = (await import("qrcode")).default;

  const fecha = factData.fecha_iso || hoyARISO();
  const cuitNum = parseInt(String(config.cuit).replace(/\D/g, ""));
  const docTipoCode = factData.doc_tipo === "CUIT" ? 80 : factData.doc_tipo === "DNI" ? 96 : 99;
  const docNroNum = parseInt(String(factData.doc_nro || "0").replace(/\D/g, "")) || 0;

  const payload = {
    ver: 1,
    fecha,
    cuit: cuitNum,
    ptoVta: parseInt(factData.punto_venta || config.punto_venta) || 1, // PV REAL de la factura (no el default del CUIT)
    tipoCmp: factData.tipo_cbte,
    nroCmp: factData.comprobante,
    importe: parseFloat(factData.total),
    moneda: "PES",
    ctz: 1,
    tipoDocRec: docTipoCode,
    nroDocRec: docNroNum,
    tipoCodAut: "E",
    codAut: parseInt(factData.cae) || 0,
  };

  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  const url = `https://www.afip.gob.ar/fe/qr/?p=${b64}`;

  const pngBuffer = await QRCode.toBuffer(url, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 200,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
  return pngBuffer;
}

async function generarPDF(factData, config) {
  const { PDFDocument, rgb, StandardFonts } = await import("pdf-lib");

  const pdfDoc = await PDFDocument.create();
  const fontB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontR = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const { cuit, razon_social, nombre_fantasia, domicilio, condicion_fiscal, ingresos_brutos } = config;
  const punto_venta = factData.punto_venta || config.punto_venta; // PV REAL de la factura
  const isMonotributo = condicion_fiscal === "MONOTRIBUTO";
  const letra = factData.letra;
  const isNC = !!factData._is_nc; // nota de crédito: cambia título y código AFIP
  const total = factData.total;
  const exento = !!factData.exento; // factura sin IVA (digitales/ebooks)
  // Reimpresión: si el comprobante trae neto/iva persistidos (emitido bajo otra
  // condición fiscal del CUIT), se respetan en vez de recalcular con la actual.
  const neto = Number.isFinite(factData.neto) ? factData.neto
    : (isMonotributo || exento) ? (exento ? 0 : total) : Math.round((total / 1.21) * 100) / 100;
  const iva21 = Number.isFinite(factData.iva) ? factData.iva
    : (isMonotributo || exento) ? 0 : Math.round((total - neto) * 100) / 100;

  // Generar QR una vez (mismo para las 3 copias)
  let qrImage = null;
  try {
    const qrBuffer = await generarQrArca(factData, config);
    qrImage = await pdfDoc.embedPng(qrBuffer);
  } catch (e) {
    console.error("[pdf] no se pudo generar QR:", e.message);
  }

  // Formato moneda argentino: $43.980,90 (punto miles, coma decimal).
  const fmtAR = (n) => {
    const num = Number(n) || 0;
    return num.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Banner opcional (config.banner_b64 — data URL "data:image/png;base64,...")
  let bannerImage = null;
  if (config.banner_b64 && typeof config.banner_b64 === "string") {
    try {
      const m = config.banner_b64.match(/^data:image\/(\w+);base64,(.+)$/);
      if (m) {
        const mime = m[1].toLowerCase();
        const buf = Buffer.from(m[2], "base64");
        if (mime === "png") bannerImage = await pdfDoc.embedPng(buf);
        else if (mime === "jpg" || mime === "jpeg") bannerImage = await pdfDoc.embedJpg(buf);
      }
    } catch (e) {
      console.error("[pdf] no se pudo embeber banner:", e.message);
    }
  }

  // Sanitiza texto para Helvetica (WinAnsi). Primero mapeamos caracteres
  // comunes (curly quotes, em-dash, º, ª) a su equivalente latin-1; lo que
  // sobre fuera del rango lo borramos (no metemos "?" porque se ve feo).
  const safe = (s) => {
    let t = String(s || "");
    const map = {
      "‘":"'", "’":"'", "“":'"', "”":'"',
      "–":"-", "—":"-", "…":"...",
      " ":" ", "​":"", " ":" ",
      "º":"o", "ª":"a",
    };
    t = t.replace(/[‘’“”–—… ​ ºª]/g, ch => map[ch] || "");
    // Sólo lo que pdf-lib puede renderizar sin morir
    return t.replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
  };

  const drawPage = async (copyLabel) => {
    const page = pdfDoc.addPage([595, 842]);
    const { width: W, height: H } = page.getSize();
    const MX = 36;
    const UW = W - MX * 2;
    const MID = MX + UW / 2;

    const COL_BLACK = rgb(0, 0, 0);
    const COL_GREY = rgb(0.45, 0.45, 0.5);
    const COL_LINE = rgb(0.78, 0.78, 0.82);
    const COL_HEAD_BG = rgb(0.96, 0.96, 0.98);
    // Diseño monocromo: el "acento" pasa a ser negro / gris muy oscuro.
    const COL_ACCENT = rgb(0, 0, 0);
    const COL_ACCENT_SOFT = rgb(0.95, 0.95, 0.95);

    const draw = (text, x, y, size, bold = false, align = "left", color = COL_BLACK) => {
      const font = bold ? fontB : fontR;
      const t = safe(text);
      const tw = font.widthOfTextAtSize(t, size);
      let rx = x;
      if (align === "center") rx = x - tw / 2;
      else if (align === "right") rx = x - tw;
      page.drawText(t, { x: rx, y: H - y, size, font, color });
    };
    const rect = (x, y, w, h, opts = {}) => page.drawRectangle({
      x, y: H - y - h, width: w, height: h,
      borderColor: opts.borderColor || COL_LINE,
      borderWidth: opts.borderWidth ?? 0.6,
      color: opts.fill || rgb(1, 1, 1),
    });
    const line = (x1, y1, x2, y2, color = COL_LINE, thickness = 0.6) => page.drawLine({
      start: { x: x1, y: H - y1 }, end: { x: x2, y: H - y2 },
      thickness, color,
    });

    // ─────── HEADER ───────
    // Tres zonas: emisor (izq) | letra (centro) | datos factura (der)
    const HY = 40, HH = 92;
    const LW = 56; // ancho recuadro letra
    const halfW = (UW - LW) / 2;
    rect(MX, HY, halfW, HH);
    // Caja letra con fill suave de acento
    rect(MX + halfW, HY, LW, HH, { fill: COL_ACCENT_SOFT, borderColor: COL_ACCENT, borderWidth: 0.8 });
    rect(MX + halfW + LW, HY, halfW, HH);

    // Letra grande en el centro
    draw(letra, MX + halfW + LW / 2, HY + 48, 44, true, "center", COL_ACCENT);
    const cod = isNC
      ? (letra === "A" ? "03" : letra === "B" ? "08" : "13")
      : (letra === "A" ? "01" : letra === "B" ? "06" : "11");
    draw("COD. " + cod, MX + halfW + LW / 2, HY + 72, 7, true, "center", COL_GREY);

    // Emisor (izquierda) — banner si existe, sino nombre de fantasía
    if (bannerImage) {
      // Banner ocupa la franja superior izquierda. Mantenemos aspect ratio.
      const maxBW = halfW - 16;
      const maxBH = 38;
      const bw0 = bannerImage.width, bh0 = bannerImage.height;
      const scaleB = Math.min(maxBW / bw0, maxBH / bh0);
      const bw = bw0 * scaleB, bh = bh0 * scaleB;
      page.drawImage(bannerImage, {
        x: MX + 8, y: H - HY - 4 - bh, width: bw, height: bh,
      });
      // Datos del emisor abajo del banner, en cuerpo más chico
      let ey = HY + bh + 12;
      draw("Razón Social: " + razon_social, MX + 8, ey, 7); ey += 10;
      draw("Domicilio Comercial: " + (domicilio || "-"), MX + 8, ey, 7); ey += 10;
      draw("Cond. IVA: " + (isMonotributo ? "Responsable Monotributo" : "IVA Responsable Inscripto"), MX + 8, ey, 7); ey += 10;
      if (ingresos_brutos) { draw("Ingresos Brutos: " + ingresos_brutos, MX + 8, ey, 7); ey += 10; }
    } else {
      draw(nombre_fantasia || razon_social, MX + 8, HY + 16, 13, true, "left", COL_ACCENT);
      draw("Razón Social: " + razon_social, MX + 8, HY + 32, 7);
      draw("Domicilio Comercial: " + (domicilio || "-"), MX + 8, HY + 44, 7);
      draw("Condición frente al IVA: " + (isMonotributo ? "Responsable Monotributo" : "IVA Responsable Inscripto"), MX + 8, HY + 56, 7);
      if (ingresos_brutos) draw("Ingresos Brutos: " + ingresos_brutos, MX + 8, HY + 68, 7);
      draw("Fecha Inicio Actividades: " + (config.fecha_inicio || "-"), MX + 8, HY + 80, 7);
    }

    // Datos factura (derecha)
    const RX = MX + halfW + LW + 10;
    draw(isNC ? "NOTA DE CRÉDITO " + letra : "FACTURA " + letra, RX, HY + 16, isNC ? 11 : 15, true, "left", COL_ACCENT);
    // pequeña línea bajo el título
    line(RX, HY + 22, RX + halfW - 18, HY + 22, COL_ACCENT, 0.8);
    draw("Punto de Venta: " + String(punto_venta).padStart(5, "0"), RX, HY + 36, 8);
    draw("Comp. Nro: " + String(factData.comprobante).padStart(8, "0"), RX, HY + 48, 8);
    draw("Fecha de Emisión: " + factData.fecha, RX, HY + 60, 8);
    draw("CUIT: " + cuit, RX, HY + 72, 8);
    if (nombre_fantasia && bannerImage) {
      // si hay banner, mostrar nombre de fantasía aquí también, abajo
      draw(nombre_fantasia, RX, HY + 84, 7, true, "left", COL_GREY);
    }

    // ─────── DATOS RECEPTOR ───────
    const RY = HY + HH + 14;
    rect(MX, RY, UW, 42, { fill: rgb(0.99, 0.99, 1), borderColor: COL_LINE });
    // Mini label sobre la caja
    draw("DATOS DEL RECEPTOR", MX + 8, RY - 2, 7, true, "left", COL_GREY);
    const docTipo = factData.doc_tipo;
    const docNro = factData.doc_nro || "";
    const condIVA = docTipo === "CUIT" ? "IVA Responsable Inscripto" : "Consumidor Final";
    const docLabel = docTipo === "CUIT" ? "CUIT" : docTipo === "DNI" ? "DNI" : "";
    const clienteName = factData.cliente || "Consumidor Final";

    if (docLabel && docNro) {
      draw(docLabel + ": " + docNro, MX + 8, RY + 12, 8, true);
      draw("Nombre y Apellido / Razón Social: " + clienteName, MID + 8, RY + 12, 8, true);
    } else {
      draw("Nombre y Apellido / Razón Social: " + clienteName, MX + 8, RY + 12, 8, true);
    }
    draw("Condición frente al IVA: " + condIVA, MX + 8, RY + 25, 7);
    draw("Domicilio: " + (factData.domicilio || "No informado"), MID + 8, RY + 25, 7);
    draw("Condición de venta: Contado", MX + 8, RY + 36, 7);
    if (isNC && factData._cbte_asoc) {
      const pvAsocPdf = String(parseInt(factData._pv_asoc) || punto_venta).padStart(5, "0");
      draw("Comprobante asociado: Factura " + letra + " N° " + pvAsocPdf + "-" + String(factData._cbte_asoc).padStart(8, "0"), MID + 8, RY + 36, 7, true);
    }

    // ─────── TABLA ITEMS ───────
    const TY = RY + 58;
    // Columnas: [Producto/Servicio, Cant, Unidad, Precio Unit, Bonif%, Subtotal]
    // (Quitamos "Código" — no es obligatorio en facturas AR y nunca lo tenemos)
    // Si es A/C, se agrega IVA % al final
    const showIVA = !isMonotributo;
    let cols, hdrs;
    if (showIVA) {
      cols = [238, 38, 50, 65, 38, 60, 34];
      hdrs = ["Producto / Servicio", "Cant.", "U. Medida", "Precio Unit.", "Bonif.", "Subtotal", "Alíc. IVA"];
    } else {
      cols = [280, 40, 56, 70, 40, 76];
      hdrs = ["Producto / Servicio", "Cant.", "U. Medida", "Precio Unit.", "Bonif.", "Subtotal"];
    }
    const totalColsW = cols.reduce((s,c)=>s+c, 0);
    const scale = UW / totalColsW;
    const scaledCols = cols.map(c => c * scale);

    // Header fila — con fondo de acento
    let cx = MX;
    const headRowH = 16;
    for (let i = 0; i < scaledCols.length; i++) {
      page.drawRectangle({
        x: cx, y: H - TY - headRowH, width: scaledCols[i], height: headRowH,
        color: COL_ACCENT, borderColor: COL_ACCENT, borderWidth: 0.4,
      });
      const align = i === 0 ? "left" : i >= 3 ? "right" : "center";
      const xPos = align === "right" ? cx + scaledCols[i] - 4 : align === "center" ? cx + scaledCols[i] / 2 : cx + 4;
      draw(hdrs[i], xPos, TY + 11, 7, true, align, rgb(1, 1, 1));
      cx += scaledCols[i];
    }

    // Filas de items — zebra striping
    let iy = TY + headRowH;
    const items = factData.items || [];
    // Cada ítem refleja SU PROPIO descuento (precio × cant − su descuento), así un
    // producto con promo no le "contagia" el descuento a otro sin promo. El residual
    // (descuento a nivel orden / redondeo) se prorratea para que el detalle sume
    // EXACTO el total. Es solo display: el total a ARCA siempre es orden.total.
    const netoItem = it => Math.max(0, (parseFloat(it.precio)||0)*(parseInt(it.cantidad)||1) - (parseFloat(it.descuento_item)||0));
    const sumNet = items.reduce((s, it) => s + netoItem(it), 0);
    const escala = sumNet > 0 ? total / sumNet : 1;
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const cant = parseInt(item.cantidad) || 1;
      const lineReal = netoItem(item) * escala; // monto real de esta línea (su descuento + prorrateo)
      // Exento/Monotributo: no se divide por 1.21. RI gravado muestra el neto.
      const subtotal = (isMonotributo || exento) ? Math.round(lineReal*100)/100 : Math.round((lineReal/1.21)*100)/100;
      const precioUnit = Math.round((subtotal / cant) * 100) / 100;
      const bonif = 0; // el descuento ya está aplicado en el precio mostrado
      const nombreItem = (item.nombre || "Producto").length > 60 ? (item.nombre || "Producto").slice(0, 60) + "..." : (item.nombre || "Producto");
      const cellData = [
        nombreItem,
        String(item.cantidad),
        "unidades",
        fmtAR(precioUnit),
        bonif > 0 ? fmtAR(bonif) : "0,00",
        fmtAR(subtotal),
        ...(showIVA ? [exento ? "Exento" : "21,00%"] : []),
      ];

      const rowH = 13;
      const rowBg = idx % 2 === 0 ? rgb(1, 1, 1) : rgb(0.985, 0.985, 0.995);
      let cx2 = MX;
      for (let i = 0; i < scaledCols.length; i++) {
        rect(cx2, iy, scaledCols[i], rowH, { borderWidth: 0.3, fill: rowBg });
        const align = i === 0 ? "left" : i >= 3 ? "right" : "center";
        const xPos = align === "right" ? cx2 + scaledCols[i] - 4 : align === "center" ? cx2 + scaledCols[i] / 2 : cx2 + 4;
        draw(cellData[i], xPos, iy + 9, 7, false, align);
        cx2 += scaledCols[i];
      }
      iy += rowH;
    }

    // Filler para que la tabla tenga altura mínima
    const minRows = 4;
    for (let i = items.length; i < minRows; i++) {
      let cx2 = MX;
      const fillBg = i % 2 === 0 ? rgb(1, 1, 1) : rgb(0.985, 0.985, 0.995);
      for (const c of scaledCols) { rect(cx2, iy, c, 13, { borderWidth: 0.3, fill: fillBg }); cx2 += c; }
      iy += 13;
    }

    // ─────── TOTALES ───────
    const totY = iy + 18;
    const totH = showIVA ? 116 : 60;
    rect(MX, totY, UW, totH, { fill: rgb(0.985, 0.985, 0.99) });
    // Importes a la derecha
    const labelX = MX + UW - 140;
    const valX = MX + UW - 12;
    let ty2 = totY + 14;
    if (showIVA) {
      // Discriminación IVA por alícuota. Si es exento, el monto va en "Op. Exentas".
      const rows = exento ? [
        ["Importe Neto Gravado:", "$ 0,00"],
        ["Importe Op. Exentas:", "$ " + fmtAR(total)],
        ["IVA 21%:", "$ 0,00"],
        ["Importe Otros Tributos:", "$ 0,00"],
      ] : [
        ["Importe Neto Gravado:", "$ " + fmtAR(neto)],
        ["IVA 0%:", "$ 0,00"],
        ["IVA 10,5%:", "$ 0,00"],
        ["IVA 21%:", "$ " + fmtAR(iva21)],
        ["IVA 27%:", "$ 0,00"],
        ["Importe Otros Tributos:", "$ 0,00"],
      ];
      for (const [l, v] of rows) {
        draw(l, labelX, ty2, 8, false, "right");
        draw(v, valX, ty2, 8, false, "right");
        ty2 += 12;
      }
    } else {
      draw("Subtotal:", labelX, ty2, 8, false, "right");
      draw("$ " + fmtAR(total), valX, ty2, 8, false, "right");
      ty2 += 12;
    }
    // Línea separadora antes del importe total
    line(MX + UW - 220, ty2 + 4, MX + UW - 8, ty2 + 4, COL_ACCENT, 0.8);
    // Importe total con fondo de acento
    page.drawRectangle({
      x: MX + UW - 220, y: H - ty2 - 28, width: 212, height: 22,
      color: COL_ACCENT,
    });
    draw("IMPORTE TOTAL:", labelX, ty2 + 22, 10, true, "right", rgb(1, 1, 1));
    draw("$ " + fmtAR(total), valX, ty2 + 22, 12, true, "right", rgb(1, 1, 1));

    // ─────── CAE / AUTORIZACIÓN + QR ARCA ───────
    const caeY = totY + totH + 14;
    const qrSize = 80;
    rect(MX, caeY, UW, qrSize + 10, { fill: rgb(0.98, 0.98, 1), borderColor: COL_LINE });

    // QR a la izquierda
    if (qrImage) {
      page.drawImage(qrImage, {
        x: MX + 8, y: H - caeY - qrSize - 5, width: qrSize, height: qrSize,
      });
    }

    // Texto del medio
    const midX = MX + qrSize + 22;
    draw("Comprobante Autorizado", midX, caeY + 16, 9, true, "left", COL_ACCENT);
    draw("AGENCIA DE RECAUDACION Y CONTROL ADUANERO (ARCA)", midX, caeY + 28, 7, false, "left", COL_GREY);

    // CAE a la derecha
    draw("CAE N°:", MX + UW - 140, caeY + 16, 8, true, "left");
    draw(factData.cae || "-", MX + UW - 8, caeY + 16, 10, true, "right", COL_ACCENT);
    draw("Fecha de Vto. CAE:", MX + UW - 140, caeY + 28, 7, false, "left");
    draw(factData.cae_vto || "-", MX + UW - 8, caeY + 28, 8, true, "right");

    // ─────── COPIA + FOOTER GROWITH ───────
    draw(copyLabel, MX, H - 50, 7, true, "left", COL_ACCENT);
    draw("Página 1 de 1", MX + UW, H - 50, 7, false, "right", COL_GREY);

    // Línea separadora antes del footer
    line(MX, H - 38, MX + UW, H - 38, COL_LINE);
    draw("Documento emitido por Growith - growithapp.com", MX + UW / 2, H - 28, 7, false, "center", COL_GREY);
  };

  for (const copy of ["ORIGINAL", "DUPLICADO", "TRIPLICADO"]) {
    await drawPage(copy);
  }

  return pdfDoc.save();
}

// ─── Helpers Firestore para config CUIT ───────────────

// El docId de arca_cuits es SIEMPRE el CUIT normalizado a dígitos: un cuit con
// guiones acá leería/escribiría un doc distinto al real.
async function loadCuitConfig(db, uid, cuit) {
  const snap = await db.collection("users").doc(uid).collection("arca_cuits").doc(String(cuit).replace(/\D/g, "")).get();
  return snap.exists ? snap.data() : null;
}
async function saveCuitConfig(db, uid, cuit, data) {
  await db.collection("users").doc(uid).collection("arca_cuits").doc(String(cuit).replace(/\D/g, "")).set(data, { merge: true });
}
// Id de la marca de emisión de una orden. Los ids de orden traen prefijos y
// caracteres que Firestore no acepta en un doc id (ej: "ML-2000/1"), así que se
// normalizan. Colección: users/{uid}/arca_emisiones/{cuit}__{orden}
function marcaEmisionId(cuit, ordenId) {
  return `${String(cuit).replace(/\D/g, "")}__${String(ordenId).replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 380);
}

async function listCuits(db, uid) {
  const snap = await db.collection("users").doc(uid).collection("arca_cuits").get();
  return snap.docs.map(d => d.data());
}

// ─── Handler principal ─────────────────────────────────

export const config = {
  api: { bodyParser: false },
};

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipart(body, boundary) {
  const parts = [];
  const sep = Buffer.from("--" + boundary);
  const find = (buf, needle, start = 0) => {
    for (let i = start; i <= buf.length - needle.length; i++) {
      if (needle.every((b, j) => buf[i + j] === b)) return i;
    }
    return -1;
  };
  let start = 0;
  while (true) {
    const idx = find(body, [...sep], start);
    if (idx === -1) break;
    const cs = idx + sep.length + 2;
    const next = find(body, [...sep], cs);
    if (next === -1) break;
    const part = body.slice(cs, next - 2);
    const he = find(part, [13, 10, 13, 10]);
    if (he === -1) { start = next; continue; }
    const headers = part.slice(0, he).toString();
    const data = part.slice(he + 4);
    const nameM = headers.match(/name="([^"]+)"/);
    const filenameM = headers.match(/filename="([^"]+)"/);
    if (nameM) parts.push({ name: nameM[1], filename: filenameM?.[1] || null, data });
    start = next;
  }
  return parts;
}

export default async function handler(req, res) {
  { const _o=String(req.headers.origin||""); res.setHeader("Access-Control-Allow-Origin", (["https://www.growithapp.com","https://growithapp.com","https://soluna-gestion.vercel.app"].includes(_o)||_o.endsWith("-soluna1.vercel.app")||_o.startsWith("http://localhost"))?_o:"https://www.growithapp.com"); } // allowlist CORS
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { action, uid, cuit } = req.query;
  if (!uid) return res.status(401).json({ error: "Falta uid" });

  // Gate único de autorización: TODAS las acciones de este endpoint (emitir en
  // AFIP, guardar/borrar certificados fiscales, leer PII de compradores, etc.)
  // pasan por acá. El uid viaja por query y no es secreto: hay que exigir que
  // el token pertenezca a esa cuenta (o a su equipo / a un admin).
  // Incluye el camino multipart (save_cuit / parse), que también resuelve el
  // uid desde la query string y manda el Authorization en el header.
  if (!(await guardUid(req, res, uid))) return;

  const db = initAdmin();

  try {
    // ── CUITS: listar ──────────────────────────────────

    if (action === "list_cuits" && req.method === "GET") {
      const cuits = await listCuits(db, uid);
      // Import dinámico (mismo patrón que firmarTRA) — sin esto cert_expiry
      // fallaba silenciosamente por ReferenceError dentro del try.
      let forge = null;
      try { forge = (await import("node-forge")).default; } catch (_) {}
      return res.json({ cuits: cuits.map(c => {
        let cert_expiry = null;
        if (c.cert_pem && forge) {
          try {
            const parsed = forge.pki.certificateFromPem(c.cert_pem);
            cert_expiry = parsed.validity.notAfter.toISOString();
          } catch(_) {}
        }
        return { ...c, cert_pem: undefined, key_pem: undefined, has_cert: Boolean(c.cert_pem), has_key: Boolean(c.key_pem), cert_expiry };
      }) });
    }

    // ── CUITS: guardar config ──────────────────────────

    if (action === "save_cuit" && req.method === "POST") {
      const body = await readBody(req);
      const ct = req.headers["content-type"] || "";
      const bm = ct.match(/boundary=([^\s;]+)/);

      let data = {};
      if (bm) {
        // multipart: puede traer cert y key como archivos
        const parts = parseMultipart(body, bm[1]);
        for (const p of parts) {
          if (p.filename) data[p.name] = p.data.toString("utf-8");
          else data[p.name] = p.data.toString("utf-8").trim();
        }
      } else {
        data = JSON.parse(body.toString());
      }

      const cuitNum = String(data.cuit || cuit || "").replace(/\D/g, "");
      if (!cuitNum) return res.status(400).json({ error: "Falta CUIT" });

      const existing = await loadCuitConfig(db, uid, cuitNum) || {};
      const updated = {
        ...existing,
        cuit: cuitNum,
        razon_social: data.razon_social || existing.razon_social || "",
        nombre_fantasia: data.nombre_fantasia || existing.nombre_fantasia || "",
        domicilio: data.domicilio || existing.domicilio || "",
        fecha_inicio: data.fecha_inicio || existing.fecha_inicio || "",
        condicion_fiscal: data.condicion_fiscal || existing.condicion_fiscal || "RESPONSABLE_INSCRIPTO",
        punto_venta: parseInt(data.punto_venta) || existing.punto_venta || 1,
        arca_prod: data.arca_prod === "true" || data.arca_prod === true || existing.arca_prod || false,
      };
      // Puntos de venta múltiples con su régimen de IVA: [{numero, exento, nombre}].
      // Ej: PV físicos (21%) + PV digitales/ebooks (exento). Si no se manda, se
      // mantiene lo existente.
      if (data.puntos_venta !== undefined) {
        try {
          const arr = typeof data.puntos_venta === "string" ? JSON.parse(data.puntos_venta) : data.puntos_venta;
          updated.puntos_venta = (Array.isArray(arr) ? arr : [])
            .map(p => ({ numero: parseInt(p.numero) || 0, exento: !!p.exento, nombre: String(p.nombre || "").slice(0, 40) }))
            .filter(p => p.numero > 0);
        } catch(_) {}
      }
      if (data.cert_pem) updated.cert_pem = data.cert_pem;
      if (data.key_pem) updated.key_pem = data.key_pem;
      // Banner opcional para PDF (data URL "data:image/png;base64,...")
      if (data.banner_b64 === "") updated.banner_b64 = ""; // permitir borrar
      else if (data.banner_b64) updated.banner_b64 = data.banner_b64;

      await saveCuitConfig(db, uid, cuitNum, updated);
      // Si cambió el certificado, la clave o el ambiente, el Ticket de Acceso
      // cacheado ya no corresponde: se descarta para que el próximo pedido
      // vuelva a loguearse contra WSAA. Guardar la config SIN cambios en estos
      // tres campos no invalida nada (WSAA rechaza logins repetidos).
      const certCambio = data.cert_pem && data.cert_pem !== existing.cert_pem;
      const keyCambio = data.key_pem && data.key_pem !== existing.key_pem;
      const ambCambio = data.arca_prod !== undefined && updated.arca_prod !== !!existing.arca_prod;
      if (certCambio || keyCambio || ambCambio) {
        await invalidarTA(db, uid, cuitNum);
      }
      return res.json({ ok: true, cuit: cuitNum, has_cert: Boolean(updated.cert_pem), has_key: Boolean(updated.key_pem) });
    }

    // ── CUITS: test conexión ───────────────────────────

    if (action === "test_cuit" && req.method === "POST") {
      if (!cuit) return res.status(400).json({ error: "Falta cuit" });
      const cfg = await loadCuitConfig(db, uid, cuit);
      if (!cfg?.cert_pem || !cfg?.key_pem) return res.status(400).json({ error: "Falta certificado o clave" });

      const { wsfe } = arcaUrls(cfg.arca_prod);
      // Validación local del par cert/key (donde falla el 90% de los casos) y
      // después TA cacheado: forzar un login nuevo acá haría que ARCA rebote el
      // pedido con "El CEE ya posee un TA válido".
      await validarParCertKey(cfg.cert_pem, cfg.key_pem, cfg.arca_prod);
      const { token, sign } = await obtenerTA(db, uid, cfg);
      const ultimoB = await getUltimoCbte(token, sign, parseInt(cfg.cuit), cfg.punto_venta, 6, wsfe);

      await saveCuitConfig(db, uid, cuit, { ...cfg, last_test: { ok: true, ts: new Date().toISOString(), ultimo_b: ultimoB } });
      return res.json({ ok: true, msg: "Conexión OK", ultimo_b: ultimoB });
    }

    // ── CUITS: eliminar ────────────────────────────────

    if (action === "delete_cuit" && req.method === "DELETE") {
      if (!cuit) return res.status(400).json({ error: "Falta cuit" });
      await db.collection("users").doc(uid).collection("arca_cuits").doc(String(cuit)).delete();
      await invalidarTA(db, uid, String(cuit).replace(/\D/g, "")); // no dejar tickets colgados
      return res.json({ ok: true });
    }

    // ── DASHBOARD: stats del mes actual para el CUIT activo ─

    if (action === "dashboard_stats" && req.method === "GET") {
      const cuitParam = String(req.query.cuit || "").replace(/\D/g, "");
      if (!cuitParam) return res.status(400).json({ error: "Falta cuit" });

      // Filtro de mes — usa params month/year si vienen, sino el mes actual ARG.
      let argYear, argMonth;
      if (req.query.month && req.query.year) {
        argYear = String(req.query.year);
        argMonth = String(req.query.month).padStart(2, "0");
      } else {
        const argFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit" });
        const parts = argFmt.formatToParts(new Date());
        argYear = parts.find(p => p.type === "year").value;
        argMonth = parts.find(p => p.type === "month").value;
      }
      const monthStart = `${argYear}-${argMonth}-01T03:00:00.000Z`;
      // Inicio del mes siguiente
      const nextMonth = parseInt(argMonth) === 12 ? "01" : String(parseInt(argMonth) + 1).padStart(2, "0");
      const nextYear = parseInt(argMonth) === 12 ? String(parseInt(argYear) + 1) : argYear;
      const monthEnd = `${nextYear}-${nextMonth}-01T03:00:00.000Z`;

      const snap = await db.collection("users").doc(uid).collection("arca_comprobantes")
        .where("cuit_emisor", "==", cuitParam)
        .get();

      let iva_debito = 0, total_facturado = 0, neto_total = 0, facturas_emitidas = 0;
      const porLetra = { A: 0, B: 0, C: 0 };
      for (const d of snap.docs) {
        const data = d.data();
        // Anuladas con NC: no cuentan en los totales del mes (antes se borraban).
        if (data.anulada) continue;
        // Prioridad: fecha_cbte (YYYY-MM-DD) > fecha_str parseado (DD/MM/YYYY) > emitido_at.
        // fecha_cbte se guarda desde el fix de julio 2026. fecha_str existe en todos los registros.
        // emitido_at es el timestamp del servidor — puede no coincidir con la fecha AFIP si se backdateó.
        let dateKey = data.fecha_cbte;
        if (!dateKey && data.fecha_str) {
          const p = data.fecha_str.split("/");
          if (p.length === 3) dateKey = `${p[2]}-${p[1]}-${p[0]}`;
        }
        const inMonth = dateKey
          ? (dateKey >= `${argYear}-${argMonth}-01` && dateKey < `${nextYear}-${nextMonth}-01`)
          : (!!data.emitido_at && data.emitido_at >= monthStart && data.emitido_at < monthEnd);
        if (!inMonth) continue;
        facturas_emitidas++;
        iva_debito += data.iva || 0;
        total_facturado += data.total || 0;
        neto_total += data.neto || 0;
        if (porLetra[data.letra] !== undefined) porLetra[data.letra]++;
      }

      // Label del mes elegido
      const meses = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
      const mesLabel = `${meses[parseInt(argMonth)-1]} ${argYear}`;

      return res.json({
        iva_debito: Math.round(iva_debito * 100) / 100,
        iva_credito: 0,
        facturas_emitidas,
        total_facturado: Math.round(total_facturado * 100) / 100,
        neto_total: Math.round(neto_total * 100) / 100,
        por_letra: porLetra,
        mes: mesLabel,
        year: parseInt(argYear),
        month: parseInt(argMonth),
      });
    }

    // ── PARSEAR archivo (XLSX o CSV) ───────────────────

    if (action === "parse" && req.method === "POST") {
      const body = await readBody(req);
      const ct = req.headers["content-type"] || "";
      const bm = ct.match(/boundary=([^\s;]+)/);
      if (!bm) return res.status(400).json({ error: "Falta boundary" });

      const parts = parseMultipart(body, bm[1]);
      const filePart = parts.find(p => p.filename);
      if (!filePart) return res.status(400).json({ error: "No se recibió archivo" });

      const ext = (filePart.filename || "").split(".").pop().toLowerCase();
      let ordenes;
      if (ext === "xlsx") ordenes = await parsearXlsxML(filePart.data);
      else if (ext === "csv") ordenes = await parsearCSV(filePart.data);
      else return res.status(400).json({ error: "Formato no soportado. Usá .xlsx (ML) o .csv (Shopify)" });

      const pagadas = Object.fromEntries(Object.entries(ordenes).filter(([, o]) => o.estado_pago === "paid" || !o.estado_pago));
      const productos = [...new Set(Object.values(pagadas).flatMap(o => o.items.map(i => i.nombre_original)))];

      return res.json({ ordenes: pagadas, total: Object.keys(pagadas).length, productos });
    }

    // ── LIMPIEZA ML: re-correr desadjuntarFacturaML en TODAS las anuladas ──
    // Útil para arrastrar ventas que se anularon antes del fix de detach.
    if (action === "cleanup_ml_anuladas" && req.method === "POST") {
      try {
        const anulSnap = await db.collection("users").doc(uid).collection("arca_facturadas").get();
        const targets = [];
        for (const d of anulSnap.docs) {
          const data = d.data();
          // Solo las anuladas que sean de ML (order_id empieza con ML-)
          if (data.anulada && String(d.id).startsWith("ML-")) {
            targets.push(d.id);
          }
        }
        if (targets.length === 0) {
          return res.json({ ok: true, total: 0, detached: 0, failed: 0, message: "No hay ventas anuladas de ML para limpiar" });
        }
        const results = [];
        let detached = 0, failed = 0;
        // Procesamos secuencial para no chocar con rate-limit de ML
        for (const orderIdFull of targets) {
          const r = await desadjuntarFacturaML(db, uid, orderIdFull);
          if (r.ok) { detached++; results.push({ order_id: orderIdFull, ok: true, deleted: r.deleted, endpoint: r.endpoint }); }
          else { failed++; results.push({ order_id: orderIdFull, ok: false, reason: r.reason, errors: r.errors }); }
        }
        return res.json({ ok: true, total: targets.length, detached, failed, results });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // ── EMITIR NOTAS DE CRÉDITO EN LOTE (anula múltiples facturas) ──
    if (action === "emit_nc_batch" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const { cuit: cuitEmit, facturas } = body;
      if (!cuitEmit || !Array.isArray(facturas) || facturas.length === 0) {
        return res.status(400).json({ error: "Faltan cuit o lista de facturas" });
      }
      const cfg = await loadCuitConfig(db, uid, cuitEmit);
      if (!cfg?.cert_pem || !cfg?.key_pem) return res.status(400).json({ error: "CUIT sin certificado configurado" });
      try {
        const { wsfe } = arcaUrls(cfg.arca_prod);
        const { token, sign } = await obtenerTA(db, uid, cfg);
        const cuitNum = parseInt(cfg.cuit);
        const pv = parseInt(cfg.punto_venta) || 1;

        // Cache último cbte por PV+tipo NC para minimizar API calls
        const ultimosNC = {};
        const results = [];

        // Dedupe defensivo por (punto_venta, comprobante): un doble-click del
        // front no puede emitir dos NC de la misma factura.
        const vistosNC = new Set();
        const facturasUnicas = facturas.filter(f => {
          const k = `${f.punto_venta || ""}_${f.comprobante}`;
          if (vistosNC.has(k)) return false;
          vistosNC.add(k);
          return true;
        });

        for (const factura of facturasUnicas) {
          const tipoFactura = parseInt(factura.tipo) || 6;
          const tipoNC = tipoNCparaFactura(tipoFactura);
          // La NC sale por el MISMO punto de venta que la factura original
          const pvNC = parseInt(factura.punto_venta) || pv;
          try {
            // Si la factura ya está anulada, no emitir otra NC. De paso se toma
            // el flag exento fiable del comprobante guardado (no del front).
            let compNC = null;
            try {
              const cuitDig = String(cuitEmit).replace(/\D/g, "");
              const nro8 = String(factura.comprobante).padStart(8, "0");
              for (const docId of [`${cuitDig}_${pvNC}_${tipoFactura}_${nro8}`, `${cuitDig}_${tipoFactura}_${nro8}`]) {
                const s = await db.collection("users").doc(uid).collection("arca_comprobantes").doc(docId).get();
                if (s.exists) { compNC = s.data(); break; }
              }
            } catch (_) {}
            if (compNC?.anulada) {
              results.push({ ok: false, factura_comprobante: factura.comprobante, error: `ya anulada (NC ${compNC.nc_nro || "?"})` });
              continue;
            }
            if (compNC) factura.exento = !!compNC.exento;
            // Factura A sin CUIT en Firestore: recuperarlo desde ARCA y persistirlo.
            if ([1, 2, 3].includes(tipoFactura) && (factura.doc_tipo !== "CUIT" || !factura.doc_nro)) {
              // Probar con el PV del comprobante y, si difiere, con el PV del CUIT.
              const pvCandidatos = [...new Set([parseInt(factura.punto_venta) || pv, pv])];
              let consultaArca = null;
              for (const pvTry of pvCandidatos) {
                consultaArca = await consultarComprobante(token, sign, cuitNum, pvTry, tipoFactura, parseInt(factura.comprobante), wsfe);
                if (consultaArca && !consultaArca.error && consultaArca.doc_tipo) break;
              }
              if (consultaArca && consultaArca.doc_tipo === "CUIT" && consultaArca.doc_nro) {
                factura.doc_tipo = "CUIT";
                factura.doc_nro = consultaArca.doc_nro;
                // update() falla si el doc no existe — nunca crea registros fantasma
                try {
                  const cuitDig = String(cuitEmit).replace(/\D/g, "");
                  const nro8 = String(factura.comprobante).padStart(8, "0");
                  for (const docId of [`${cuitDig}_${pvNC}_${tipoFactura}_${nro8}`, `${cuitDig}_${tipoFactura}_${nro8}`]) {
                    try {
                      await db.collection("users").doc(uid).collection("arca_comprobantes").doc(docId)
                        .update({ doc_tipo: "CUIT", doc_nro: consultaArca.doc_nro });
                      break;
                    } catch (_) {}
                  }
                } catch (_) {}
              } else {
                // No pudimos recuperar el CUIT desde ARCA. Devolver error diagnóstico.
                const diag = consultaArca?.error ? consultaArca.error :
                  consultaArca?.doc_tipo === "CF" ? "ARCA registra el comprobante como Consumidor Final (sin CUIT). ¿Es realmente Factura A?" :
                  `ARCA devolvió doc_tipo="${consultaArca?.doc_tipo}" doc_nro="${consultaArca?.doc_nro}"`;
                results.push({ ok: false, factura_comprobante: factura.comprobante, error: `[consulta-arca pv=${pvCandidatos.join("/")}] ${diag}` });
                continue;
              }
            }
            const ncKey = `${pvNC}_${tipoNC}`;
            if (ultimosNC[ncKey] === undefined) {
              ultimosNC[ncKey] = await getUltimoCbte(token, sign, cuitNum, pvNC, tipoNC, wsfe);
            }
            const ncNro = ++ultimosNC[ncKey];
            const result = await emitirNotaCredito(token, sign, cuitNum, pvNC, ncNro, factura, wsfe);
            if (result.resultado !== "A" || !result.cae) {
              results.push({ ok: false, factura_comprobante: factura.comprobante, error: result.obs || "rechazada" });
              // Tras un rechazo no se decrementa en memoria: se re-consulta AFIP
              // en el próximo uso para no desincronizar el numerador.
              delete ultimosNC[ncKey];
              continue;
            }
            const letra = tipoNC === 3 ? "A" : tipoNC === 8 ? "B" : "C";
            const ncFactData = {
              comprobante: ncNro, cae: result.cae, cae_vto: result.cae_vto,
              fecha: new Date().toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }),
              cliente: factura.cliente || "Consumidor Final",
              doc_tipo: factura.doc_tipo, doc_nro: factura.doc_nro || "",
              letra, tipo_cbte: tipoNC, punto_venta: pvNC,
              domicilio: factura.domicilio || "",
              total: parseFloat(factura.total) || 0,
              exento: !!factura.exento,
              items: factura.items || [{ nombre: `Anulación Factura ${letra} ${String(factura.comprobante).padStart(8,"0")}`, cantidad: 1, precio: parseFloat(factura.total) || 0 }],
              _is_nc: true,
              _cbte_asoc: factura.comprobante,
              _pv_asoc: factura.punto_venta || pvNC,
            };
            const pdfBytes = await generarPDF(ncFactData, cfg);
            const pdfB64 = Buffer.from(pdfBytes).toString("base64");

            // Persistir
            try {
              await db.collection("users").doc(uid).collection("arca_notas_credito").add({
                cuit: String(cuitEmit), tipo: tipoNC, letra,
                punto_venta: pvNC, comprobante: ncNro,
                cae: result.cae, cae_vto: result.cae_vto,
                total: parseFloat(factura.total) || 0,
                cliente: factura.cliente || "",
                doc_tipo: factura.doc_tipo || "", doc_nro: factura.doc_nro || "",
                factura_origen: { tipo: tipoFactura, comprobante: factura.comprobante, punto_venta: factura.punto_venta || pv },
                fecha: new Date().toISOString(),
                pdf_b64: pdfB64.length < 900000 ? pdfB64 : null,
              });
            } catch (e) {}

            // Marcar orden anulada + marcar el comprobante como anulada:true en
            // arca_comprobantes (NO se borra: queda visible en Registros con badge
            // ANULADA). Todos los lectores tratan anulada:true como NO facturado,
            // así la orden vuelve a aparecer como pendiente de facturar.
            let mlDetached = false;
            if (factura.order_id) {
              try {
                await db.collection("users").doc(uid).collection("arca_facturadas").doc(String(factura.order_id))
                  .set({ anulada: true, anulada_at: new Date().toISOString(), nc_comprobante: ncNro }, { merge: true });
                // Filtro por cuit_emisor: la misma orden pudo facturarse desde
                // otro CUIT — la NC de este no puede marcarle la anulación.
                const compSnap = await db.collection("users").doc(uid).collection("arca_comprobantes")
                  .where("cuit_emisor", "==", String(cuitEmit).replace(/\D/g, ""))
                  .where("orden_id", "==", factura.order_id).get();
                const batchUpd = db.batch();
                compSnap.docs.forEach(d => batchUpd.set(d.ref, { anulada: true, anulada_at: new Date().toISOString(), nc_nro: ncNro }, { merge: true }));
                if (!compSnap.empty) await batchUpd.commit();
              } catch (_) {}
              // ML: desadjuntar factura original del pack/orden
              if (String(factura.order_id).startsWith("ML-")) {
                const mlR = await desadjuntarFacturaML(db, uid, factura.order_id);
                mlDetached = mlR.ok;
              }
            } else {
              // Sin order_id (manual / recuperada de AFIP): marcar por docId.
              // update() falla si el doc no existe — nunca crea registros fantasma.
              const cuitDig = String(cuitEmit).replace(/\D/g, "");
              const nro8 = String(factura.comprobante).padStart(8, "0");
              const pvComp = parseInt(factura.punto_venta) || pv;
              for (const docId of [`${cuitDig}_${pvComp}_${tipoFactura}_${nro8}`, `${cuitDig}_${tipoFactura}_${nro8}`]) {
                try {
                  await db.collection("users").doc(uid).collection("arca_comprobantes").doc(docId)
                    .update({ anulada: true, anulada_at: new Date().toISOString(), nc_nro: ncNro });
                  break;
                } catch (_) {}
              }
            }
            results.push({
              ok: true,
              factura_comprobante: factura.comprobante,
              nc: { tipo: tipoNC, letra, punto_venta: pvNC, comprobante: ncNro, cae: result.cae, total: result.total, nombre_pdf: `NC ${letra} - ${String(ncNro).padStart(8,"0")}.pdf`, pdf_b64: pdfB64 },
              ml_detached: mlDetached,
            });
          } catch (e) {
            results.push({ ok: false, factura_comprobante: factura.comprobante, error: e.message });
          }
        }
        const okCount = results.filter(r => r.ok).length;
        return res.json({ ok: true, total: facturasUnicas.length, ok_count: okCount, errors: results.filter(r => !r.ok), results });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // ── ACTUALIZAR RECEPTOR (CUIT/DNI) de un comprobante registrado ──
    // Útil para cargar el CUIT cuando el comprobante original se emitió sin él
    // y ahora hace falta para poder emitir la NC (caso Factura A).
    if (action === "update_comprobante_receptor" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const { cuit_emisor, tipo_cbte, nro, doc_tipo, doc_nro, cliente } = body;
      if (!cuit_emisor || !tipo_cbte || !nro) return res.status(400).json({ error: "Faltan datos del comprobante" });
      try {
        // Buscar por campos (cubre ambos formatos de docId, con y sin PV) y
        // actualizar SOLO si el comprobante existe — nunca crear un fantasma.
        const q = await db.collection("users").doc(uid).collection("arca_comprobantes")
          .where("cuit_emisor", "==", String(cuit_emisor).replace(/\D/g, ""))
          .where("tipo_cbte", "==", parseInt(tipo_cbte))
          .where("nro", "==", parseInt(nro))
          .get();
        if (q.empty) return res.status(404).json({ error: "El comprobante no está en Registros — no se puede actualizar el receptor." });
        await q.docs[0].ref.update({
          doc_tipo: doc_tipo || "",
          doc_nro: String(doc_nro || "").replace(/\D/g, ""),
          ...(cliente ? { cliente } : {}),
        });
        return res.json({ ok: true });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // ── EMITIR NOTA DE CRÉDITO (anula factura emitida) ──
    if (action === "emit_nc" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const { cuit: cuitEmit, factura } = body;
      // factura: { tipo, punto_venta, comprobante, total, doc_tipo, doc_nro, cliente, domicilio, items, fecha_iso, order_id }
      if (!cuitEmit || !factura) return res.status(400).json({ error: "Faltan cuit o factura" });
      const cfg = await loadCuitConfig(db, uid, cuitEmit);
      if (!cfg?.cert_pem || !cfg?.key_pem) return res.status(400).json({ error: "CUIT sin certificado configurado" });

      try {
        const { wsfe } = arcaUrls(cfg.arca_prod);
        const { token, sign } = await obtenerTA(db, uid, cfg);
        const cuitNum = parseInt(cfg.cuit);
        // La NC sale por el MISMO punto de venta que la factura original
        const pv = parseInt(factura.punto_venta) || parseInt(cfg.punto_venta) || 1;

        const tipoFactura = parseInt(factura.tipo) || 6;
        const tipoNC = tipoNCparaFactura(tipoFactura);

        // Comprobante guardado: frena la doble anulación y aporta el flag
        // exento fiable (no se confía en el que mande el front).
        let compNC = null;
        try {
          const cuitDig = String(cuitEmit).replace(/\D/g, "");
          const nro8 = String(factura.comprobante).padStart(8, "0");
          for (const docId of [`${cuitDig}_${pv}_${tipoFactura}_${nro8}`, `${cuitDig}_${tipoFactura}_${nro8}`]) {
            const s = await db.collection("users").doc(uid).collection("arca_comprobantes").doc(docId).get();
            if (s.exists) { compNC = s.data(); break; }
          }
        } catch (_) {}
        if (compNC?.anulada) {
          return res.status(409).json({ error: `La factura N° ${factura.comprobante} ya está anulada (NC ${compNC.nc_nro || "?"}) — no se emite otra NC.` });
        }
        if (compNC) factura.exento = !!compNC.exento;

        // Si es Factura A y nos llegó sin CUIT del receptor, intentar recuperarlo
        // consultando ARCA (FECompConsultar). ARCA siempre tiene los datos originales.
        if ([1, 2, 3].includes(tipoFactura) && (factura.doc_tipo !== "CUIT" || !factura.doc_nro)) {
          const pvCandidatos = [...new Set([parseInt(factura.punto_venta) || pv, pv])];
          let datos = null;
          for (const pvTry of pvCandidatos) {
            datos = await consultarComprobante(token, sign, cuitNum, pvTry, tipoFactura, parseInt(factura.comprobante), wsfe);
            if (datos && !datos.error && datos.doc_tipo) break;
          }
          if (datos && datos.doc_tipo === "CUIT" && datos.doc_nro) {
            factura.doc_tipo = "CUIT";
            factura.doc_nro = datos.doc_nro;
            // Actualizar Firestore para que no haga falta volver a consultar.
            // update() falla si el doc no existe — nunca crea registros fantasma
            try {
              const cuitDig = String(cuitEmit).replace(/\D/g, "");
              const nro8 = String(factura.comprobante).padStart(8, "0");
              for (const docId of [`${cuitDig}_${pv}_${tipoFactura}_${nro8}`, `${cuitDig}_${tipoFactura}_${nro8}`]) {
                try {
                  await db.collection("users").doc(uid).collection("arca_comprobantes").doc(docId)
                    .update({ doc_tipo: "CUIT", doc_nro: datos.doc_nro });
                  break;
                } catch (_) {}
              }
            } catch (_) {}
          } else if (datos?.error) {
            return res.status(502).json({ error: "No se pudo recuperar el CUIT del receptor desde ARCA", detalle: `[consulta-arca pv=${pvCandidatos.join("/")}] ${datos.error}` });
          }
        }

        const ultimoNC = await getUltimoCbte(token, sign, cuitNum, pv, tipoNC, wsfe);
        const ncNro = ultimoNC + 1;

        const result = await emitirNotaCredito(token, sign, cuitNum, pv, ncNro, factura, wsfe);
        if (result.resultado !== "A" || !result.cae) {
          return res.status(502).json({ error: "ARCA rechazó la NC", detalle: result.obs, resultado: result.resultado });
        }

        // PDF de la NC (reusamos generarPDF con datos modificados)
        const letra = tipoNC === 3 ? "A" : tipoNC === 8 ? "B" : "C";
        const ncFactData = {
          comprobante: ncNro,
          cae: result.cae,
          cae_vto: result.cae_vto,
          fecha: new Date().toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }),
          cliente: factura.cliente || "Consumidor Final",
          doc_tipo: factura.doc_tipo,
          doc_nro: factura.doc_nro || "",
          letra,
          tipo_cbte: tipoNC,
          punto_venta: pv,
          domicilio: factura.domicilio || "",
          total: parseFloat(factura.total) || 0,
          exento: !!factura.exento,
          items: factura.items || [{ nombre: `Anulación Factura ${letra} ${String(factura.comprobante).padStart(8,"0")}`, cantidad: 1, precio: parseFloat(factura.total) || 0 }],
          _is_nc: true,
          _cbte_asoc: factura.comprobante,
          _pv_asoc: factura.punto_venta || pv,
        };
        const pdfBytes = await generarPDF(ncFactData, cfg);
        const pdfB64 = Buffer.from(pdfBytes).toString("base64");

        // Persistir registro de la NC en Firestore
        const ncRecord = {
          cuit: String(cuitEmit),
          tipo: tipoNC,
          letra,
          punto_venta: pv,
          comprobante: ncNro,
          cae: result.cae,
          cae_vto: result.cae_vto,
          total: parseFloat(factura.total) || 0,
          cliente: factura.cliente || "",
          doc_tipo: factura.doc_tipo || "",
          doc_nro: factura.doc_nro || "",
          factura_origen: {
            tipo: tipoFactura,
            comprobante: factura.comprobante,
            punto_venta: factura.punto_venta || pv,
          },
          fecha: new Date().toISOString(),
          pdf_b64: pdfB64.length < 900000 ? pdfB64 : null,
        };
        try {
          await db.collection("users").doc(uid).collection("arca_notas_credito").add(ncRecord);
        } catch (e) { /* no crítico */ }

        // Si el factura original tiene un order_id, marcamos anulada (en
        // arca_facturadas y en el propio comprobante — NO se borra, queda en
        // Registros con badge ANULADA y todos los lectores lo tratan como NO
        // facturado) + DESADJUNTAMOS de ML para que vuelva a aparecer como pendiente
        let mlDetachedSingle = false;
        if (factura.order_id) {
          try {
            await db.collection("users").doc(uid).collection("arca_facturadas").doc(String(factura.order_id))
              .set({ anulada: true, anulada_at: new Date().toISOString(), nc_comprobante: ncNro }, { merge: true });
            // Filtro por cuit_emisor: la misma orden pudo facturarse desde otro
            // CUIT — la NC de este no puede marcarle la anulación.
            const compSnap = await db.collection("users").doc(uid).collection("arca_comprobantes")
              .where("cuit_emisor", "==", String(cuitEmit).replace(/\D/g, ""))
              .where("orden_id", "==", factura.order_id).get();
            const batchUpd = db.batch();
            compSnap.docs.forEach(d => batchUpd.set(d.ref, { anulada: true, anulada_at: new Date().toISOString(), nc_nro: ncNro }, { merge: true }));
            if (!compSnap.empty) await batchUpd.commit();
          } catch (e) {}
          // ML: desadjuntar la factura original del pack/orden
          if (String(factura.order_id).startsWith("ML-")) {
            const mlResult = await desadjuntarFacturaML(db, uid, factura.order_id);
            mlDetachedSingle = mlResult.ok;
          }
        } else {
          // Sin order_id (manual / recuperada de AFIP): marcar por docId.
          // update() falla si el doc no existe — nunca crea registros fantasma.
          const cuitDig = String(cuitEmit).replace(/\D/g, "");
          const nro8 = String(factura.comprobante).padStart(8, "0");
          const pvComp = parseInt(factura.punto_venta) || pv;
          for (const docId of [`${cuitDig}_${pvComp}_${tipoFactura}_${nro8}`, `${cuitDig}_${tipoFactura}_${nro8}`]) {
            try {
              await db.collection("users").doc(uid).collection("arca_comprobantes").doc(docId)
                .update({ anulada: true, anulada_at: new Date().toISOString(), nc_nro: ncNro });
              break;
            } catch (_) {}
          }
        }

        return res.json({
          ok: true,
          nc: {
            tipo: tipoNC,
            letra,
            punto_venta: pv,
            comprobante: ncNro,
            cae: result.cae,
            cae_vto: result.cae_vto,
            total: result.total,
            pdf_b64: pdfB64,
            nombre_pdf: `NC ${letra} - ${String(ncNro).padStart(8,"0")}.pdf`,
            ml_detached: factura.order_id && String(factura.order_id).startsWith("ML-") ? mlDetachedSingle : null,
          },
        });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // ── EMITIR facturas ────────────────────────────────

    if (action === "emit" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const { cuit: cuitRaw, ordenes, product_map, fecha_factura, punto_venta: pvSel, exento: exentoReq } = body;
      // Normalizar SIEMPRE a dígitos: cuit_emisor se guarda con este valor y el
      // historial (list_batches / dashboard_stats) filtra con el cuit normalizado.
      // Un cuit con guiones acá = comprobantes invisibles en Registros.
      const cuitEmit = String(cuitRaw || "").replace(/\D/g, "");
      if (!cuitEmit || !ordenes) return res.status(400).json({ error: "Faltan cuit u ordenes" });
      let exento = exentoReq === true || exentoReq === "true"; // factura exenta (digitales/ebooks)

      console.log(`[arca/emit] uid=${uid} cuit=${cuitEmit} n=${Object.keys(ordenes||{}).length} fecha_factura=${JSON.stringify(fecha_factura)}`);

      // Resolver fecha de imputación.
      //   - Si el frontend manda fecha_factura (YYYYMMDD), usamos ESA fecha
      //     directamente. La que el merchant eligió es la que va a ARCA.
      //   - Validamos formato y rango ARCA (max 10 días corridos hacia atrás).
      //   - Si NO viene (cliente antiguo), default = hoy.
      let fechaImputacion = null;
      if (fecha_factura) {
        if (!/^\d{8}$/.test(String(fecha_factura))) {
          return res.status(400).json({ error: "fecha_factura debe ser YYYYMMDD" });
        }
        fechaImputacion = String(fecha_factura);
        const fv = fechaValida(fechaImputacion);
        if (!fv.ok) {
          return res.status(400).json({ error: fv.msg });
        }
      }

      const cfg = await loadCuitConfig(db, uid, cuitEmit);
      if (!cfg?.cert_pem || !cfg?.key_pem) return res.status(400).json({ error: "Falta certificado o clave para ese CUIT" });

      const isMonotributo = cfg.condicion_fiscal === "MONOTRIBUTO";
      const { wsfe } = arcaUrls(cfg.arca_prod);

      // Autenticar — TA cacheado por CUIT (dura 12h; pedir uno nuevo por lote
      // hace que ARCA rechace el login mientras el anterior siga vigente).
      let { token, sign } = await obtenerTA(db, uid, cfg);

      // Numeradores — usa el punto de venta elegido (ej: PV físicos vs PV digitales
      // exento). Si el front no manda uno, cae al punto_venta por defecto del CUIT.
      const cuitNum = parseInt(cfg.cuit);
      const pv = parseInt(pvSel) || cfg.punto_venta;
      // Exento: lo decide la CONFIG del punto de venta, no el front. Si hay
      // puntos_venta configurados y el flag del front no coincide, gana la config.
      if (Array.isArray(cfg.puntos_venta) && cfg.puntos_venta.length) {
        exento = cfg.puntos_venta.find(p => String(p.numero) === String(pv))?.exento === true;
      }
      let cbteA = isMonotributo ? 0 : (await getUltimoCbte(token, sign, cuitNum, pv, 1, wsfe)) + 1;
      let cbteB = isMonotributo ? 0 : (await getUltimoCbte(token, sign, cuitNum, pv, 6, wsfe)) + 1;
      let cbteC = isMonotributo ? (await getUltimoCbte(token, sign, cuitNum, pv, 11, wsfe)) + 1 : 0;

      const resultados = [];
      const pdfs = []; // { nombre, bytes }

      // ── Idempotencia del lote ──────────────────────────
      // Emitir dos veces la misma factura en AFIP no se puede deshacer (hay que
      // sacar nota de crédito). Si un lote se corta a la mitad — timeout de la
      // función, red, el usuario que reintenta — las órdenes que YA salieron no
      // se vuelven a emitir. Dos capas:
      //   1. Pre-chequeo contra arca_comprobantes (lo ya facturado, histórico).
      //   2. Una marca por orden en arca_emisiones ANTES de pegarle a AFIP, que
      //      además frena dos requests simultáneos sobre la misma orden.
      const ordenesEntries = Object.entries(ordenes);
      const yaFacturadas = new Map(); // orden_id → comprobante existente
      try {
        const ids = ordenesEntries.map(([id]) => id);
        // Misma query que usa check_duplicates (índice ya existente): "in"
        // acepta 30 valores por consulta.
        for (let i = 0; i < ids.length; i += 30) {
          const snap = await db.collection("users").doc(uid).collection("arca_comprobantes")
            .where("cuit_emisor", "==", cuitEmit)
            .where("orden_id", "in", ids.slice(i, i + 30))
            .get();
          snap.docs.forEach(d => { const x = d.data(); if (x.orden_id && !x.anulada) yaFacturadas.set(String(x.orden_id), x); });
        }
      } catch (e) {
        // Si el pre-chequeo falla NO se aborta la emisión (quedaría el merchant
        // sin poder facturar): la marca por orden sigue protegiendo.
        console.error("[arca emit] pre-chequeo de duplicados falló:", e.message);
      }

      // Deadline global del lote (mismo patrón que el resync): si el tiempo se
      // acaba, las órdenes restantes se devuelven como pendientes en vez de
      // dejar que Vercel mate la función a mitad de una emisión.
      const DEADLINE_EMIT = Date.now() + 90000;
      const pendientesIds = [];
      let taRenovado = false; // un solo re-login por lote ante token vencido

      for (const [orderId, orden] of ordenesEntries) {
        if (Date.now() > DEADLINE_EMIT) { pendientesIds.push(orderId); continue; }
        // Total inválido: no se toma marca ni se llama a AFIP.
        if (!Number.isFinite(Number(orden.total)) || Number(orden.total) <= 0) {
          resultados.push({ orden_id: orderId, ok: false, total: orden.total,
            obs: `Total de la orden inválido (${orden.total}) — no se envió a AFIP.` });
          continue;
        }
        // ¿Ya tiene factura? No se re-emite.
        const previa = yaFacturadas.get(String(orderId));
        if (previa) {
          resultados.push({ orden_id: orderId, ok: false, ya_facturada: true, total: orden.total,
            obs: `Ya tiene factura ${previa.letra || ""} N° ${previa.nro || "?"} (CAE ${previa.cae || "?"}) — no se re-emite para no duplicarla en ARCA.` });
          continue;
        }
        // Marca "en curso" antes de pegarle a AFIP.
        const marcaRef = db.collection("users").doc(uid).collection("arca_emisiones").doc(marcaEmisionId(cuitEmit, orderId));
        let marcaTomada = false;
        try {
          await marcaRef.create({ orden_id: orderId, cuit_emisor: cuitEmit, estado: "en_curso", at: new Date().toISOString() });
          marcaTomada = true;
        } catch (_) {
          // Ya existía: o salió con CAE, o hay otra emisión en vuelo.
          let m = null;
          try { m = (await marcaRef.get()).data(); } catch (_) {}
          const atMs = m?.at ? Date.parse(m.at) : 0;
          if (m && m.estado === "emitido") {
            resultados.push({ orden_id: orderId, ok: false, ya_facturada: true, total: orden.total,
              obs: `Ya facturada (CAE ${m.cae || "?"}) — no se re-emite para no duplicarla en ARCA.` });
            continue;
          }
          // Rechazada hace menos de 2 minutos: frena el doble-click inmediato.
          // Pasado ese rato, el reintento (con datos corregidos) es legítimo.
          if (m && m.estado === "rechazado" && atMs && Date.now() - atMs < 2 * 60000) {
            resultados.push({ orden_id: orderId, ok: false, total: orden.total,
              obs: "ARCA rechazó esta orden hace un momento — esperá un par de minutos antes de reintentar." });
            continue;
          }
          if (m && m.estado !== "rechazado" && atMs && Date.now() - atMs < 10 * 60000) {
            resultados.push({ orden_id: orderId, ok: false, ya_facturada: true, total: orden.total,
              obs: "Hay otra emisión de esta orden en curso — no se re-emite. Revisá el resultado en unos minutos." });
            continue;
          }
          // Marca vieja y sin CAE: la corrida anterior murió antes de emitir → se retoma.
          try { await marcaRef.set({ estado: "en_curso", at: new Date().toISOString() }, { merge: true }); marcaTomada = true; } catch (_) {}
        }

        // Aplicar mapeo de productos
        if (product_map) {
          for (const item of orden.items) {
            if (product_map[item.nombre_original]) item.nombre = product_map[item.nombre_original];
          }
        }

        let result, letra, tipoCbte, cbteNro;

        // Un error de red/SOAP en UNA orden no puede tumbar el lote entero: si
        // explota, se informa esa orden y se sigue con las demás. La marca queda
        // en "en_curso" a propósito — no sabemos si ARCA llegó a dar el CAE, así
        // que durante 10 minutos no se reintenta (duplicar es peor que demorar).
        try {
          if (isMonotributo) {
            letra = "C"; tipoCbte = 11; cbteNro = cbteC;
            result = await facturar(token, sign, cuitNum, pv, cbteC, orden, 11, wsfe, true, fechaImputacion, exento);
          } else {
            const tieneCuit = orden.doc_tipo === "CUIT";
            if (tieneCuit) {
              letra = "A"; tipoCbte = 1; cbteNro = cbteA;
              result = await facturar(token, sign, cuitNum, pv, cbteA, orden, 1, wsfe, false, fechaImputacion, exento);
              // Fallback A→B SOLO ante rechazo de validación del receptor —
              // nunca por errores genéricos, de token (600/601) ni de
              // correlatividad (10016).
              if (!result.cae && esRechazoReceptor(result)) {
                letra = "B"; tipoCbte = 6; cbteNro = cbteB;
                result = await facturar(token, sign, cuitNum, pv, cbteB, orden, 6, wsfe, false, fechaImputacion, exento);
              }
            } else {
              letra = "B"; tipoCbte = 6; cbteNro = cbteB;
              result = await facturar(token, sign, cuitNum, pv, cbteB, orden, 6, wsfe, false, fechaImputacion, exento);
            }
          }
        } catch (e) {
          // Error de red/timeout: FECAESolicitar no se reintenta a ciegas. El
          // pedido pudo procesarse igual, así que ANTES de darlo por fallido se
          // consulta si el comprobante ya existe en AFIP con el número esperado.
          let rec = null;
          if (tipoCbte && cbteNro) {
            try { rec = await consultarComprobanteCompleto(token, sign, cuitNum, pv, tipoCbte, cbteNro, wsfe); } catch (_) {}
          }
          if (rec && !rec.error && rec.cae) {
            // AFIP SÍ lo emitió: se trata como éxito con los datos de la consulta.
            result = { cae: rec.cae, cae_vto: rec.cae_vto, resultado: "A", obs: "", err_code: null, obs_codigo: null, obs_msg: "" };
          } else {
            console.error(`[arca emit] ${orderId} error de conexión:`, e.message);
            resultados.push({ orden_id: orderId, ok: false, total: orden.total,
              obs: `No se pudo confirmar con ARCA: ${e.message} — verificá en el historial de ARCA antes de reintentar (por si el comprobante salió igual).` });
            continue;
          }
        }

        // Token AFIP vencido a mitad de lote (600/601): renovar el TA UNA sola
        // vez, re-sincronizar el numerador y reintentar este comprobante.
        if (!result.cae && [600, 601].includes(result.err_code) && !taRenovado) {
          taRenovado = true;
          try {
            await invalidarTA(db, uid, cuitEmit);
            ({ token, sign } = await obtenerTA(db, uid, cfg));
            cbteNro = (await getUltimoCbte(token, sign, cuitNum, pv, tipoCbte, wsfe)) + 1;
            if (letra === "A") cbteA = cbteNro; else if (letra === "C") cbteC = cbteNro; else cbteB = cbteNro;
            result = await facturar(token, sign, cuitNum, pv, cbteNro, orden, tipoCbte, wsfe, isMonotributo, fechaImputacion, exento);
          } catch (e2) {
            resultados.push({ orden_id: orderId, ok: false, total: orden.total,
              obs: `Token de ARCA vencido y no se pudo renovar: ${e2.message}` });
            continue;
          }
        }

        if (result.cae) {
          // Cerrar la marca ANTES de generar el PDF: si el PDF o el adjunto a ML
          // fallan, la factura ya existe en ARCA y no debe re-emitirse nunca.
          if (marcaTomada) {
            try {
              await marcaRef.set({ estado: "emitido", cae: result.cae, tipo_cbte: tipoCbte, nro: cbteNro, punto_venta: pv, at: new Date().toISOString() }, { merge: true });
            } catch (e) { console.error("[arca emit] no se pudo cerrar la marca:", e.message); }
          }
          // Generar PDF — usar la fecha que eligió el usuario (fechaImputacion),
          // NO new Date() que siempre pone hoy aunque ARCA tenga la fecha correcta.
          const fechaIso = fechaImputacion
            ? `${fechaImputacion.slice(0,4)}-${fechaImputacion.slice(4,6)}-${fechaImputacion.slice(6,8)}`
            : hoyARISO();
          const fechaDisplay = new Date(fechaIso + "T12:00:00-03:00")
            .toLocaleDateString("es-AR", { day:"2-digit", month:"2-digit", year:"numeric" });
          const factData = {
            comprobante: cbteNro, cae: result.cae, cae_vto: result.cae_vto,
            fecha: fechaDisplay,
            fecha_iso: fechaIso,
            cliente: orden.nombre || "Consumidor Final",
            doc_tipo: orden.doc_tipo, doc_nro: orden.doc_nro || orden.dni || "",
            letra, tipo_cbte: tipoCbte,
            domicilio: cleanAddr([orden.direccion, orden.ciudad, orden.provincia]),
            total: orden.total, items: orden.items, exento, punto_venta: pv,
          };
          // Persistir el comprobante en Firestore ANTES de los pasos best-effort
          // (PDF, adjuntar a ML). La factura ya existe en AFIP: si el PDF explota
          // o la función muere por timeout acá, el registro tiene que quedar —
          // antes se guardaba al final y una falla intermedia lo hacía invisible
          // en Registros para siempre.
          // docId con punto de venta (mismo formato que el resync): dos PV con
          // el mismo número de comprobante ya no se pisan entre sí.
          const compRef = db.collection("users").doc(uid).collection("arca_comprobantes")
            .doc(`${cuitEmit}_${pv}_${tipoCbte}_${String(cbteNro).padStart(8, "0")}`);
          let compGuardado = false;
          const netoComp = (isMonotributo || exento) ? (exento ? 0 : orden.total) : Math.round((orden.total / 1.21) * 100) / 100;
          const ivaComp = (isMonotributo || exento) ? 0 : Math.round((orden.total - netoComp) * 100) / 100;
          const compData = {
              cuit_emisor: cuitEmit,
              tipo_cbte: tipoCbte,
              letra,
              nro: cbteNro,
              punto_venta: pv,
              exento,
              fecha_str: factData.fecha,
              fecha_cbte: factData.fecha_iso,
              emitido_at: new Date().toISOString(),
              cae: result.cae,
              cae_vto: result.cae_vto,
              cliente: orden.nombre || "Consumidor Final",
              doc_tipo: orden.doc_tipo,
              doc_nro: orden.doc_nro || orden.dni || "",
              total: orden.total,
              neto: netoComp,
              iva: ivaComp,
              orden_id: orderId,
              // Items reales para re-imprimir el PDF con el detalle correcto
              items: (orden.items || []).map(it => ({
                nombre: it.nombre || it.nombre_original || "Producto",
                cantidad: parseInt(it.cantidad) || 1,
                precio: parseFloat(it.precio) || 0,
                descuento_item: parseFloat(it.descuento_item) || 0,
              })),
              domicilio: cleanAddr([orden.direccion, orden.ciudad, orden.provincia]),
              ml_uploaded: false,
              ml_uploaded_at: null,
              // Resultado=A con observaciones de AFIP: el comprobante es válido,
              // pero las obs quedan registradas.
              obs_codigo: result.obs_codigo || null,
              obs_msg: result.obs_msg || "",
          };
          try {
            await compRef.set(compData);
            compGuardado = true;
          } catch (e) {
            console.error("[arca] no se pudo guardar comprobante:", e.message);
          }

          // PDF — best-effort: una falla acá NO puede tumbar el lote ni perder
          // el registro (la factura ya salió y ya está guardada arriba).
          let pdfBytes = null;
          try {
            pdfBytes = await generarPDF(factData, cfg);
            const nombreCliente = (orden.nombre || "Consumidor_Final").replace(/[^a-zA-Z0-9 \-_]/g, "").trim();
            pdfs.push({ nombre: `F${letra} - ${nombreCliente} - ${String(cbteNro).padStart(8, "0")}.pdf`, bytes: Buffer.from(pdfBytes).toString("base64") });
          } catch (e) {
            console.error(`[arca emit] ${orderId} no se pudo generar el PDF (la factura salió igual):`, e.message);
          }

          // ── Auto-adjuntar factura a venta de ML ─────────────
          // 1) Consultamos pack_id real de la orden (a veces es distinto al order_id)
          // 2) Subimos PDF al endpoint /packs/{pack_id}/fiscal_documents
          let ml_uploaded = false, ml_upload_error = null;
          if (orderId.startsWith("ML-") && pdfBytes) {
            try {
              const ml = await getValidMLToken(db, uid, await mlVentasAcc(db, uid));
              if (!ml?.accessToken) throw new Error("Sin access_token de ML");
              const orderIdRaw = orderId.replace(/^ML-/, "");

              // Conseguir pack_id real (si la orden esta en un pack)
              let packId = orderIdRaw;
              try {
                const oRes = await fetch(`https://api.mercadolibre.com/orders/${orderIdRaw}?fields=pack_id`, {
                  headers: { Authorization: `Bearer ${ml.accessToken}` },
                });
                if (oRes.ok) {
                  const oData = await oRes.json();
                  if (oData.pack_id) packId = String(oData.pack_id);
                }
              } catch (_) { /* fallback al order_id */ }

              // Construir multipart manualmente (mas confiable que FormData/Blob en Vercel runtime)
              const boundary = "----GrowithBoundary" + Date.now();
              const pdfBuf = Buffer.from(pdfBytes);
              const filename = `F${letra}-${String(cbteNro).padStart(8, "0")}.pdf`;
              const head = Buffer.from(
                `--${boundary}\r\n` +
                `Content-Disposition: form-data; name="fiscal_document"; filename="${filename}"\r\n` +
                `Content-Type: application/pdf\r\n\r\n`
              );
              const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
              const body = Buffer.concat([head, pdfBuf, tail]);

              const tryUpload = async () => fetch(`https://api.mercadolibre.com/packs/${packId}/fiscal_documents`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${ml.accessToken}`,
                  "Content-Type": `multipart/form-data; boundary=${boundary}`,
                  "Content-Length": String(body.length),
                },
                body,
              });
              let upRes = await tryUpload();
              // 409 conflict = ya hay una factura adjunta (probablemente la vieja anulada).
              // Limpiar y reintentar UNA vez.
              if (upRes.status === 409) {
                try {
                  const listR = await fetch(`https://api.mercadolibre.com/packs/${packId}/fiscal_documents`, {
                    headers: { Authorization: `Bearer ${ml.accessToken}` },
                  });
                  if (listR.ok) {
                    const listJ = await listR.json().catch(() => ({}));
                    const docs = Array.isArray(listJ) ? listJ : (listJ.results || listJ.fiscal_documents || []);
                    for (const d of docs) {
                      const did = d.id || d.fiscal_document_id;
                      if (did) {
                        await fetch(`https://api.mercadolibre.com/packs/${packId}/fiscal_documents/${did}`, {
                          method: "DELETE",
                          headers: { Authorization: `Bearer ${ml.accessToken}` },
                        }).catch(() => {});
                      }
                    }
                    upRes = await tryUpload();
                  }
                } catch (_) {}
              }

              if (upRes.ok) {
                ml_uploaded = true;
              } else {
                const txt = await upRes.text().catch(() => "");
                // Solo status + primeros 80 chars (sin datos personales)
                ml_upload_error = `HTTP ${upRes.status}: ${txt.slice(0, 80)}`;
                console.error(`[ml-upload] ${orderId} pack=${packId}:`, ml_upload_error);
              }
            } catch (e) {
              ml_upload_error = e.message;
              console.error(`[ml-upload] ${orderId} error:`, e.message);
            }
          }

          if (orderId.startsWith("ML-") && !pdfBytes && !ml_upload_error) ml_upload_error = "PDF no generado — adjuntalo después desde Registros";

          resultados.push({ orden_id: orderId, ok: true, letra, comprobante: cbteNro, cae: result.cae, cae_vto: result.cae_vto, total: orden.total, ml_uploaded, ml_upload_error });

          // El comprobante ya se guardó ANTES del PDF/ML — acá solo se actualiza
          // el flag de adjunto ML, o se reintenta el guardado completo si falló.
          try {
            if (!compGuardado) {
              await compRef.set({ ...compData, ml_uploaded: ml_uploaded || false, ml_uploaded_at: ml_uploaded ? new Date().toISOString() : null });
            } else if (ml_uploaded) {
              await compRef.set({ ml_uploaded: true, ml_uploaded_at: new Date().toISOString() }, { merge: true });
            }
          } catch (e) {
            console.error("[arca] no se pudo guardar/actualizar comprobante:", e.message);
          }

          if (letra === "A") cbteA++;
          else if (letra === "C") cbteC++;
          else cbteB++;
        } else {
          // Transparencia para diagnóstico: qué comprobante intentamos y con qué
          // condición fiscal del emisor — sin esto, el "mismo error" de AFIP no
          // dice si el server usó la config nueva o la vieja.
          // ARCA rechazó: la marca NO se borra — queda en estado "rechazado"
          // con timestamp, para frenar el doble-click inmediato pero permitir
          // el reintento legítimo (con datos corregidos) a los 2 minutos.
          if (marcaTomada) {
            try {
              await marcaRef.set({ estado: "rechazado", obs: String(result.obs || "").slice(0, 200), at: new Date().toISOString() }, { merge: true });
            } catch (_) {}
          }
          const intento = `[Intenté Factura ${letra || (isMonotributo ? "C" : "?")} · PV ${pv} · emisor ${cfg.condicion_fiscal || "?"}] `;
          // Sin el texto del obs en el log (puede traer el doc del receptor) — solo el código.
          console.log(`[arca emit] ${orderId} RECHAZADA — tipo ${tipoCbte} pv ${pv} cond ${cfg.condicion_fiscal} code=${result.err_code || "?"}`);
          resultados.push({ orden_id: orderId, ok: false, obs: intento + result.obs, total: orden.total });
        }
      }

      // Persistir el batch (lote de emisión) — solo metadata, NO los PDFs (se regeneran on-demand)
      try {
        const exitosos = resultados.filter(r => r.ok);
        if (exitosos.length > 0) {
          const batchId = "B_" + Date.now();
          const totalBatch = exitosos.reduce((s, r) => s + (r.total || 0), 0);
          await db.collection("users").doc(uid).collection("arca_batches").doc(batchId).set({
            batch_id: batchId,
            cuit_emisor: cuitEmit,
            emitido_at: new Date().toISOString(),
            cantidad: exitosos.length,
            total: totalBatch,
            comprobante_ids: exitosos.map(r => `${cuitEmit}_${pv}_${r.tipo_cbte || (isMonotributo ? 11 : (r.letra === "A" ? 1 : 6))}_${String(r.comprobante).padStart(8, "0")}`),
            resumen: exitosos.map(r => ({
              orden_id: r.orden_id,
              letra: r.letra,
              comprobante: r.comprobante,
              cae: r.cae,
              total: r.total,
            })),
          });
        }
      } catch (e) {
        console.error("[arca] no se pudo guardar batch:", e.message);
      }

      // Lotes grandes: los PDFs en base64 revientan el límite de respuesta de
      // Vercel — el front los regenera con get_batch_pdfs.
      const parcialExtra = pendientesIds.length ? { parcial: true, pendientes: pendientesIds } : {};
      if (resultados.length > 15) {
        return res.json({ ok: true, resultados, pdfs: [], pdfs_via_batch: true, ...parcialExtra });
      }
      return res.json({ ok: true, resultados, pdfs, ...parcialExtra });
    }

    // ── HISTORIAL: lista de batches del CUIT activo ──
    // Construido dinámicamente desde arca_comprobantes agrupando por timestamp cercano (±10 min).
    // Así incluye facturas emitidas antes de que existiera el sistema de batches.

    // ── ADJUNTAR FACTURAS ML PENDIENTES (botón "adjuntar todas") ──
    // Recorre arca_comprobantes con orden_id ML-* y ml_uploaded != true.
    // Por cada uno: regenera el PDF, consigue pack_id real, sube a ML, marca uploaded.
    if (action === "attach_ml_pending" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const cuitParam = String(body.cuit || "").replace(/\D/g, "");
      if (!cuitParam) return res.status(400).json({ error: "Falta cuit" });

      const cfg = await loadCuitConfig(db, uid, cuitParam);
      if (!cfg) return res.status(404).json({ error: "CUIT no encontrado" });

      const ml = await getValidMLToken(db, uid, await mlVentasAcc(db, uid));
      if (!ml?.accessToken) return res.status(400).json({ error: "No hay cuenta ML conectada o el token expiró" });

      const snap = await db.collection("users").doc(uid).collection("arca_comprobantes")
        .where("cuit_emisor", "==", cuitParam).get();

      const pending = snap.docs
        .map(d => ({ ref: d.ref, ...d.data() }))
        .filter(c => c.orden_id?.startsWith("ML-") && !c.ml_uploaded && !c.anulada);

      if (pending.length === 0) {
        return res.json({ ok: true, total: 0, uploaded: 0, errors: [], message: "No hay facturas pendientes de adjuntar a ML" });
      }

      let uploaded = 0;
      const errors = [];

      for (const c of pending) {
        try {
          // 1) Regenerar PDF
          const factData = {
            comprobante: c.nro, cae: c.cae, cae_vto: c.cae_vto,
            // fecha_cbte = fecha REAL del comprobante en AFIP (el emitido_at
            // puede diferir si se backdateó) — el QR debe llevar la real.
            fecha: c.fecha_str, fecha_iso: c.fecha_cbte || c.emitido_at?.slice(0, 10),
            cliente: c.cliente || "Consumidor Final",
            doc_tipo: c.doc_tipo, doc_nro: c.doc_nro || "",
            letra: c.letra, tipo_cbte: c.tipo_cbte,
            domicilio: c.domicilio || "",
            total: c.total, neto: c.neto, iva: c.iva, punto_venta: c.punto_venta, exento: !!c.exento,
            items: (Array.isArray(c.items) && c.items.length > 0)
              ? c.items
              : [{ nombre: "(Detalle no disponible)", cantidad: 1, precio: c.total, descuento_item: 0 }],
          };
          const pdfBytes = await generarPDF(factData, cfg);

          // 2) Conseguir pack_id real
          const orderIdRaw = c.orden_id.replace(/^ML-/, "");
          let packId = orderIdRaw;
          try {
            const oRes = await fetch(`https://api.mercadolibre.com/orders/${orderIdRaw}?fields=pack_id`, {
              headers: { Authorization: `Bearer ${ml.accessToken}` },
            });
            if (oRes.ok) {
              const oData = await oRes.json();
              if (oData.pack_id) packId = String(oData.pack_id);
            }
          } catch (_) { /* fallback */ }

          // 3) Subir multipart
          const boundary = "----GrowithBoundary" + Date.now() + "_" + uploaded;
          const pdfBuf = Buffer.from(pdfBytes);
          const filename = `F${c.letra}-${String(c.nro).padStart(8, "0")}.pdf`;
          const head = Buffer.from(
            `--${boundary}\r\n` +
            `Content-Disposition: form-data; name="fiscal_document"; filename="${filename}"\r\n` +
            `Content-Type: application/pdf\r\n\r\n`
          );
          const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
          const reqBody = Buffer.concat([head, pdfBuf, tail]);

          const doUpload = async () => fetch(`https://api.mercadolibre.com/packs/${packId}/fiscal_documents`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${ml.accessToken}`,
              "Content-Type": `multipart/form-data; boundary=${boundary}`,
              "Content-Length": String(reqBody.length),
            },
            body: reqBody,
          });
          let upRes = await doUpload();
          // 409 = ya hay un fiscal doc anterior (típicamente la anulada). Borrar + retry.
          if (upRes.status === 409) {
            try {
              const listR = await fetch(`https://api.mercadolibre.com/packs/${packId}/fiscal_documents`, {
                headers: { Authorization: `Bearer ${ml.accessToken}` },
              });
              if (listR.ok) {
                const listJ = await listR.json().catch(() => ({}));
                const docs = Array.isArray(listJ) ? listJ : (listJ.results || listJ.fiscal_documents || []);
                for (const d of docs) {
                  const did = d.id || d.fiscal_document_id;
                  if (did) {
                    await fetch(`https://api.mercadolibre.com/packs/${packId}/fiscal_documents/${did}`, {
                      method: "DELETE",
                      headers: { Authorization: `Bearer ${ml.accessToken}` },
                    }).catch(() => {});
                  }
                }
                upRes = await doUpload();
              }
            } catch (_) {}
          }

          if (upRes.ok) {
            await c.ref.set({ ml_uploaded: true, ml_uploaded_at: new Date().toISOString() }, { merge: true });
            uploaded++;
          } else {
            const txt = await upRes.text().catch(() => "");
            // Solo status + primeros 80 chars (sin datos personales)
            errors.push({ orden_id: c.orden_id, error: `HTTP ${upRes.status}: ${txt.slice(0, 80)}` });
          }
        } catch (e) {
          errors.push({ orden_id: c.orden_id, error: e.message });
        }
      }

      return res.json({ ok: true, total: pending.length, uploaded, errors });
    }

    if (action === "list_batches" && req.method === "GET") {
      const cuitParam = String(req.query.cuit || "").replace(/\D/g, "");
      if (!cuitParam) return res.status(400).json({ error: "Falta cuit" });

      // Filtro opcional por mes/año (mismo formato que dashboard_stats)
      let filterStart = null, filterEnd = null;
      if (req.query.month && req.query.year) {
        const y = String(req.query.year);
        const m = String(req.query.month).padStart(2, "0");
        filterStart = `${y}-${m}-01T03:00:00.000Z`;
        const nextM = parseInt(m) === 12 ? "01" : String(parseInt(m) + 1).padStart(2, "0");
        const nextY = parseInt(m) === 12 ? String(parseInt(y) + 1) : y;
        filterEnd = `${nextY}-${nextM}-01T03:00:00.000Z`;
      }

      const snap = await db.collection("users").doc(uid).collection("arca_comprobantes")
        .where("cuit_emisor", "==", cuitParam)
        .get();

      // _docId: id REAL del documento (formato viejo sin PV o nuevo con PV) —
      // es lo que get_batch_pdfs necesita para reimprimir.
      const comprobantes = snap.docs.map(d => ({ _docId: d.id, ...d.data() }))
        .filter(c => !filterStart || (c.emitido_at >= filterStart && c.emitido_at < filterEnd))
        .sort((a, b) => (b.emitido_at || "").localeCompare(a.emitido_at || ""));

      const GROUP_WINDOW_MS = 10 * 60 * 1000; // 10 minutos
      const batches = [];
      let current = null;
      for (const c of comprobantes) {
        const ts = c.emitido_at ? new Date(c.emitido_at).getTime() : 0;
        if (!current || current._lastTs - ts > GROUP_WINDOW_MS) {
          current = {
            batch_id: "B_" + ts,
            cuit_emisor: cuitParam,
            emitido_at: c.emitido_at,
            cantidad: 0,
            total: 0,
            comprobante_ids: [],
            resumen: [],
            _lastTs: ts,
          };
          batches.push(current);
        }
        current.cantidad++;
        current.total += c.total || 0;
        current.comprobante_ids.push(c._docId);
        current.resumen.push({
          orden_id: c.orden_id || ("N° " + c.nro),
          letra: c.letra,
          comprobante: c.nro,
          cae: c.cae,
          total: c.total || 0,
          // Detalle para la vista "Comprobantes" de Registros
          tipo_cbte: c.tipo_cbte,
          punto_venta: c.punto_venta || null,
          doc_tipo: c.doc_tipo || "",
          doc_nro: c.doc_nro || "",
          cliente: c.cliente || "",
          fecha_cbte: c.fecha_cbte || null,
          neto: c.neto || 0,
          iva: c.iva || 0,
          cae_vto: c.cae_vto || null,
          ml_uploaded: !!c.ml_uploaded,
          recuperado_afip: !!c.recuperado_afip,
          exento: !!c.exento,
          anulada: !!c.anulada,
          nc_nro: c.nc_nro || null,
        });
        current._lastTs = ts;
      }

      // Limpiar campo interno antes de devolver
      const out = batches.slice(0, 100).map(b => {
        const { _lastTs, ...rest } = b;
        return rest;
      });

      return res.json({ batches: out });
    }

    // ── HISTORIAL: notas de crédito del CUIT (misma auth y patrón que list_batches) ──
    if (action === "list_ncs" && req.method === "GET") {
      const cuitParam = String(req.query.cuit || "").replace(/\D/g, "");
      if (!cuitParam) return res.status(400).json({ error: "Falta cuit" });

      // Filtro opcional por mes/año (mismos params year/month que list_batches)
      let filterStart = null, filterEnd = null;
      if (req.query.month && req.query.year) {
        const y = String(req.query.year);
        const m = String(req.query.month).padStart(2, "0");
        filterStart = `${y}-${m}-01T03:00:00.000Z`;
        const nextM = parseInt(m) === 12 ? "01" : String(parseInt(m) + 1).padStart(2, "0");
        const nextY = parseInt(m) === 12 ? String(parseInt(y) + 1) : y;
        filterEnd = `${nextY}-${nextM}-01T03:00:00.000Z`;
      }

      // El campo `cuit` puede haberse guardado con o sin guiones según la época:
      // se trae todo y se filtra normalizando a dígitos (colección chica).
      const snap = await db.collection("users").doc(uid).collection("arca_notas_credito").get();
      const ncs = snap.docs.map(d => d.data())
        .filter(c => String(c.cuit || "").replace(/\D/g, "") === cuitParam)
        .filter(c => !filterStart || (c.fecha >= filterStart && c.fecha < filterEnd))
        .sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""))
        .map(c => ({
          tipo: c.tipo,
          letra: c.letra || (c.tipo === 3 ? "A" : c.tipo === 8 ? "B" : c.tipo === 13 ? "C" : ""),
          punto_venta: c.punto_venta || null,
          comprobante: c.comprobante,
          cae: c.cae || null,
          total: c.total || 0,
          fecha: c.fecha || null,
          cliente: c.cliente || "",
          doc_tipo: c.doc_tipo || "",
          doc_nro: c.doc_nro || "",
          factura_origen: c.factura_origen || null,
          recuperado_afip: !!c.recuperado_afip,
        }));

      return res.json({ ncs });
    }

    // ── HISTORIAL: regenerar PDFs de un batch específico ──

    if (action === "get_batch_pdfs" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const { cuit: cuitParam, comprobante_ids } = body;
      if (!cuitParam || !Array.isArray(comprobante_ids)) return res.status(400).json({ error: "Faltan cuit o comprobante_ids" });

      const cfg = await loadCuitConfig(db, uid, cuitParam);
      if (!cfg) return res.status(404).json({ error: "CUIT no encontrado" });

      const pdfs = [];
      for (const comprobanteId of comprobante_ids) {
        const cSnap = await db.collection("users").doc(uid).collection("arca_comprobantes").doc(comprobanteId).get();
        if (!cSnap.exists) continue;
        const c = cSnap.data();
        const factData = {
          comprobante: c.nro,
          cae: c.cae,
          cae_vto: c.cae_vto,
          fecha: c.fecha_str,
          // fecha_cbte = fecha REAL del comprobante en AFIP (para el QR)
          fecha_iso: c.fecha_cbte || c.emitido_at?.slice(0, 10),
          cliente: c.cliente || "Consumidor Final",
          doc_tipo: c.doc_tipo,
          doc_nro: c.doc_nro || "",
          letra: c.letra,
          tipo_cbte: c.tipo_cbte,
          domicilio: c.domicilio || "",
          total: c.total, neto: c.neto, iva: c.iva, punto_venta: c.punto_venta, exento: !!c.exento,
          // Items reales si fueron persistidos al emitir, sino fallback (facturas viejas)
          items: (Array.isArray(c.items) && c.items.length > 0)
            ? c.items
            : [{ nombre: "(Detalle no disponible en re-impresión)", cantidad: 1, precio: c.total, descuento_item: 0 }],
        };
        const pdfBytes = await generarPDF(factData, cfg);
        const nombreCliente = (c.cliente || "Consumidor_Final").replace(/[^a-zA-Z0-9 \-_]/g, "").trim();
        pdfs.push({
          nombre: `F${c.letra} - ${nombreCliente} - ${String(c.nro).padStart(8, "0")}.pdf`,
          bytes: Buffer.from(pdfBytes).toString("base64"),
        });
      }
      return res.json({ pdfs });
    }

    // ── INTEGRACIONES: traer órdenes pendientes de facturar de TODAS las plataformas conectadas ──

    if (action === "pending_orders" && req.method === "GET") {
      const cuitParam = String(req.query.cuit || "").replace(/\D/g, "");
      if (!cuitParam) return res.status(400).json({ error: "Falta cuit" });

      // Rango de fechas — en zona Argentina (UTC-3) para no correr el día.
      const argYmd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(d);
      let sinceDate, untilDate;
      if (req.query.since) {
        sinceDate = String(req.query.since).slice(0, 10);
        untilDate = req.query.until ? String(req.query.until).slice(0, 10) : argYmd(new Date());
      } else {
        // "days" es la cantidad de días INCLUIDO hoy: days=1 es solo el día de hoy
        // en Argentina. Antes restaba days completos, así que "Hoy" traía ayer y hoy.
        const days = Math.min(parseInt(req.query.days) || 7, 365);
        sinceDate = argYmd(new Date(Date.now() - (days - 1) * 86400000));
        untilDate = argYmd(new Date());
      }

      const userSnap = await db.collection("users").doc(uid).get();
      if (!userSnap.exists) return res.json({ connections: [], ordenes: {} });
      const stores = userSnap.data().stores || [];

      // IDs ya facturadas (mantenemos para marcar visualmente, no para filtrar)
      const billedSnap = await db.collection("users").doc(uid).collection("arca_comprobantes")
        .where("cuit_emisor", "==", cuitParam).get();
      const billedMap = new Map();
      for (const d of billedSnap.docs) {
        const data = d.data();
        // anulada:true = ya NO cuenta como facturada (la orden vuelve a ser facturable)
        if (data.orden_id && !data.anulada) billedMap.set(data.orden_id, { letra: data.letra, nro: data.nro, emitido_at: data.emitido_at });
      }
      // IDs que fueron facturadas y luego ANULADAS con NC — para mostrar recordatorio
      // visual aunque ya no estén "facturadas" (porque borramos de arca_comprobantes al anular)
      const anuladaMap = new Map();
      try {
        const anulSnap = await db.collection("users").doc(uid).collection("arca_facturadas").get();
        for (const d of anulSnap.docs) {
          const data = d.data();
          if (data.anulada) anuladaMap.set(d.id, { anulada_at: data.anulada_at, nc_comprobante: data.nc_comprobante });
        }
      } catch (_) {}

      const connections = [];
      const ordenes = {};
      let tnDebug = null; // diagnóstico: cuántas órdenes trajo TN por status

      // Los tres canales se consultan EN PARALELO (antes era secuencial: TN,
      // después Shopify, después ML — el tiempo total era la suma de los tres).
      // Cada canal escribe en su propio mapa y al final se mergea en orden fijo
      // para mantener determinismo en la respuesta.
      const tnStore = stores.find(s => s.type === "tiendanube");
      const shStore = stores.find(s => s.type === "shopify");
      const mlStore = stores.find(s => s.type === "mercadolibre");
      if (tnStore?.accessToken && tnStore?.storeId) connections.push({ platform: "tiendanube", name: tnStore.storeName || "Tienda Nube", connected: true });
      if (shStore?.accessToken && shStore?.shop) connections.push({ platform: "shopify", name: shStore.storeName || shStore.shop, connected: true });
      if (mlStore?.userId) connections.push({ platform: "mercadolibre", name: mlStore.nickname || `ML #${mlStore.userId}`, connected: true });
      const ordTN = {}, ordSH = {}, ordML = {};
      const fetchers = [];

      // ─── Tienda Nube ───
      if (tnStore?.accessToken && tnStore?.storeId) fetchers.push((async () => {
        const headers = {
          "Authentication": `bearer ${tnStore.accessToken}`,
          "User-Agent": "GrowithApp (contacto.growith@gmail.com)",
        };
        // Llamada helper: trae TODAS las páginas de TN para un payment_status dado.
        const fetchTNStatus = async (status) => {
          const out = [];
          // created_at: filtra por cuando se realizó la orden — coincide con el criterio
          // estándar de TN y apps de referencia. En TN el pago es casi siempre inmediato
          // al hacer el pedido, así que created_at ≈ fecha de pago en la práctica.
          // sort_by=created_at+desc: las más recientes primero.
          const baseParams = `per_page=200&payment_status=${status}&created_at_min=${sinceDate}T00:00:00-03:00&created_at_max=${untilDate}T23:59:59-03:00&sort_by=created_at&sort_direction=desc`;
          for (let page = 1; page <= 10; page++) { // hasta 2000 órdenes por status
            const url = `https://api.tiendanube.com/v1/${tnStore.storeId}/orders?${baseParams}&page=${page}`;
            const r = await fetch(url, { headers });
            if (!r.ok) { console.warn(`[tn-pending] ${status} page ${page} failed: ${r.status}`); break; }
            const batch = await r.json();
            if (!Array.isArray(batch) || batch.length === 0) break;
            out.push(...batch);
            if (batch.length < 200) break;
          }
          return out;
        };
        // Tres llamadas en paralelo: paid, authorized y partially_paid
        // paid        → pago confirmado (siempre facturable)
        // authorized  → MercadoPago aprobó, aún no liquidó (facturable)
        // partially_paid → pago parcial recibido (facturable por el monto recibido)
        const [paidBatch, authBatch, partialBatch] = await Promise.all([
          fetchTNStatus("paid"),
          fetchTNStatus("authorized"),
          fetchTNStatus("partially_paid"),
        ]);
        // Mergear deduplicando por TN id interno
        const tnById = new Map();
        for (const o of [...paidBatch, ...authBatch, ...partialBatch]) {
          tnById.set(String(o.id || o.number), o);
        }
        const allTN = [...tnById.values()];
        // Diagnóstico: cuántos trajo TN por status
        tnDebug = {
          paid: paidBatch.length,
          authorized: authBatch.length,
          partially_paid: partialBatch.length,
          total_raw: allTN.length,
        };
        console.log(`[tn-pending] raw fetched — paid:${tnDebug.paid} auth:${tnDebug.authorized} partial:${tnDebug.partially_paid} total:${tnDebug.total_raw} range:${sinceDate}→${untilDate}`);
        for (const o of allTN) {
          const orderId = "TN-" + String(o.number || o.id);
          if ((o.status || "").toLowerCase() === "cancelled") continue;
          const pStatus = (o.payment_status || "").toLowerCase();
          if (!["paid", "authorized", "partially_paid"].includes(pStatus)) continue;
          const docRaw = extractTNDoc(o);
          const clas = clasificarDoc(docRaw);
          const customerName = `${o.customer?.first_name || ""} ${o.customer?.last_name || ""}`.trim()
            || o.customer?.name || o.contact_name || "";
          const billed = billedMap.get(orderId);
          ordTN[orderId] = {
            _platform: "tiendanube",
            _platform_label: "TN",
            _order_number: String(o.number || o.id),
            _billed: !!billed,
            _billed_info: billed || null,
            _was_anulada: !!anuladaMap.get(orderId),
            _anulada_info: anuladaMap.get(orderId) || null,
            nombre: customerName,
            email: o.customer?.email || o.contact_email || "",
            dni: docRaw, ...clas,
            total: parseFloat(o.total) || 0,
            subtotal: parseFloat(o.subtotal) || 0,
            descuento: parseFloat(o.discount) || 0,
            envio: parseFloat(o.shipping_cost_customer) || 0,
            estado_pago: pStatus,
            fecha: o.paid_at || o.created_at || "",
            ciudad: o.shipping_address?.city || o.billing_city || "",
            provincia: o.shipping_address?.province || o.billing_province || "",
            // TN tiene address (calle), number, floor, locality. Combinamos todo.
            direccion: [
              o.shipping_address?.address || o.billing_address || "",
              o.shipping_address?.number || o.billing_number || "",
              o.shipping_address?.floor || o.billing_floor || "",
            ].filter(Boolean).join(" ").trim(),
            metodo_pago: o.payment_details?.method || "Pagado",
            plataforma_pago: normPlataformaPago(o.gateway_name || o.gateway, o.payment_details?.method),
            items: (o.products || []).map(p => ({
              nombre: p.name || "Producto",
              nombre_original: p.name || "Producto",
              cantidad: parseInt(p.quantity) || 1,
              precio: parseFloat(p.price) || 0,
              descuento_item: 0,
            })),
          };
        }
      })().catch(e => console.error("[tn-pending] error:", e.message)));

      // ─── Shopify ───
      if (shStore?.accessToken && shStore?.shop) fetchers.push((async () => {
        const allSH = [];
        // Shopify usa cursor pagination con Link header. IMPORTANTE: ordenamos
        // por created_at DESC (más nuevas primero). Sin esto, Shopify devuelve las
        // más VIEJAS primero y, con el tope de páginas, nunca llegaban las ventas
        // recientes → "no tomaba las ventas nuevas". El orden se preserva en el cursor.
        let pageInfoUrl = `https://${shStore.shop}/admin/api/2024-10/orders.json?status=any&financial_status=paid&limit=250&order=created_at+desc&created_at_min=${sinceDate}T00:00:00-03:00&created_at_max=${untilDate}T23:59:59-03:00`;
        // Paginación COMPLETA (como Márgenes): seguimos el cursor hasta que no haya
        // más páginas. El tope de 60 es solo un seguro anti-loop (60×250 = 15k).
        for (let i = 0; i < 60; i++) {
          if (!pageInfoUrl) break;
          const shRes = await fetch(pageInfoUrl, {
            headers: { "X-Shopify-Access-Token": shStore.accessToken },
          });
          if (!shRes.ok) break;
          const data = await shRes.json();
          const batch = data.orders || [];
          allSH.push(...batch);
          // Detectar next page por Link header
          const linkHeader = shRes.headers.get("link") || shRes.headers.get("Link") || "";
          const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
          pageInfoUrl = nextMatch ? nextMatch[1] : null;
        }
        // Cache de customer fetches para no pegar 200 veces al mismo customer
        // dentro del mismo refresh. clave = customer.id, valor = customer JSON
        // (o null si fail).
        const customerCache = new Map();
        async function fetchCustomerFresh(customerId) {
          if (!customerId) return null;
          if (customerCache.has(customerId)) return customerCache.get(customerId);
          try {
            const r = await fetch(`https://${shStore.shop}/admin/api/2024-10/customers/${customerId}.json`, {
              headers: { "X-Shopify-Access-Token": shStore.accessToken },
            });
            if (!r.ok) { customerCache.set(customerId, null); return null; }
            const d = await r.json();
            customerCache.set(customerId, d?.customer || null);
            return d?.customer || null;
          } catch (_) { customerCache.set(customerId, null); return null; }
        }

        for (const o of allSH) {
          const orderId = "SH-" + (o.name || String(o.order_number || o.id));
          if (o.cancelled_at) continue;
          // Filtros estrictos: solo pagadas (no pending, refunded, voided)
          if ((o.financial_status || "").toLowerCase() !== "paid") continue;
          // Extract con snapshot de la orden (rápido, sin requests extra).
          let docRaw = extractShopifyDoc(o);

          // FALLBACK: si el snapshot de la orden no trae doc, pero la orden
          // tiene customer_id, traemos el customer ACTUAL desde Shopify. Eso
          // refleja el CUIT que el merchant editó después de la venta —
          // billing/shipping_address de la orden son snapshots inmutables.
          if (!docRaw && o.customer?.id && !billedMap.get(orderId)) {
            const fresh = await fetchCustomerFresh(o.customer.id);
            if (fresh) {
              // Re-armamos un "o fake" con customer enriquecido para reusar el extractor
              docRaw = extractShopifyDoc({ ...o, customer: { ...o.customer, ...fresh } });
            }
          }

          const clas = clasificarDoc(docRaw);
          const customerName = `${o.customer?.first_name || ""} ${o.customer?.last_name || ""}`.trim()
            || o.billing_address?.name || o.shipping_address?.name || "";
          const billed = billedMap.get(orderId);
          ordSH[orderId] = {
            _platform: "shopify",
            _platform_label: "SH",
            _order_number: o.name || String(o.order_number || o.id),
            _billed: !!billed,
            _billed_info: billed || null,
            _was_anulada: !!anuladaMap.get(orderId),
            _anulada_info: anuladaMap.get(orderId) || null,
            nombre: customerName,
            email: o.email || o.customer?.email || "",
            dni: docRaw, ...clas,
            total: parseFloat(o.total_price) || 0,
            subtotal: parseFloat(o.subtotal_price) || 0,
            descuento: parseFloat(o.total_discounts) || 0,
            envio: parseFloat(o.total_shipping_price_set?.shop_money?.amount) || 0,
            estado_pago: "paid",
            fecha: o.processed_at || o.created_at || "",
            ciudad: o.billing_address?.city || o.shipping_address?.city || "",
            provincia: o.billing_address?.province || o.shipping_address?.province || "",
            direccion: [
              o.billing_address?.address1 || o.shipping_address?.address1 || "",
              o.billing_address?.address2 || o.shipping_address?.address2 || "",
            ].filter(Boolean).join(", "),
            metodo_pago: o.payment_gateway_names?.join(", ") || "Pagado",
            plataforma_pago: o.payment_gateway_names?.join(", ") || "",
            items: (o.line_items || []).map(li => ({
              nombre: li.title || "Producto",
              nombre_original: li.title || "Producto",
              cantidad: parseInt(li.quantity) || 1,
              precio: parseFloat(li.price) || 0,
              // Descuento REAL asignado a esta línea (Shopify ya reparte los
              // descuentos de orden/bundle por producto en discount_allocations).
              descuento_item: (li.discount_allocations||[]).reduce((s,da)=>s+(parseFloat(da.amount)||0),0) || parseFloat(li.total_discount) || 0,
            })),
          };
        }
      })().catch(e => console.error("[sh-pending] error:", e.message)));

      // ─── Mercado Libre ───
      if (mlStore?.userId) fetchers.push((async () => {
        try {
          const { accessToken, userId } = await getValidMLToken(db, uid, await mlVentasAcc(db, uid)) || {};
          if (accessToken) {
            const allML = [];
            for (let offset = 0; offset < 500; offset += 50) {
              // date_closed = cuando la orden pasó a estado "paid" (más preciso que date_created para facturar)
              const url = `https://api.mercadolibre.com/orders/search?seller=${userId}&order.status=paid&order.date_closed.from=${sinceDate}T00:00:00.000-03:00&order.date_closed.to=${untilDate}T23:59:59.999-03:00&limit=50&offset=${offset}&sort=date_desc`;
              const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
              if (!r.ok) {
                console.error("[ml] orders search failed", r.status, await r.text().catch(()=>""));
                break;
              }
              const data = await r.json();
              const batch = data.results || [];
              allML.push(...batch);
              if (batch.length < 50) break;
            }

            // Pre-filtrar las que NO van a entrar (canceladas/inválidas/refundeadas) para no gastar fetch billing_info
            const mlPaid = allML.filter(o => {
              const st = (o.status || "").toLowerCase();
              if (["cancelled", "invalid", "partially_paid", "payment_required", "payment_in_process"].includes(st)) return false;
              const validPayments = (o.payments || []).filter(p => !["refunded", "cancelled"].includes((p.status || "").toLowerCase()));
              if ((o.payments || []).length > 0 && validPayments.length === 0) return false;
              return true;
            });

            // Fetch billing_info en paralelo (chunks de 5 para evitar 429)
            const billingByOrderId = {};
            let billingOk = 0, billingErr = 0;
            // Solo pedimos billing_info de las órdenes SIN facturar: las ya
            // facturadas se muestran en verde y no se re-emiten, así que no
            // necesitan datos fiscales. En un período largo esto ahorra la
            // enorme mayoría de los requests (el cuello de botella histórico).
            const mlNeedBilling = mlPaid.filter(o => !billedMap.get("ML-" + String(o.id)));
            const CHUNK = 10;
            for (let i = 0; i < mlNeedBilling.length; i += CHUNK) {
              const chunk = mlNeedBilling.slice(i, i + CHUNK);
              await Promise.all(chunk.map(async (o) => {
                try {
                  const r = await fetch(`https://api.mercadolibre.com/orders/${o.id}/billing_info`, {
                    headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "GrowithApp (contacto.growith@gmail.com)" },
                  });
                  if (r.ok) {
                    const data = await r.json();
                    // Probar varios paths que ML usa según versión del endpoint
                    billingByOrderId[o.id] = data.buyer?.billing_info || data.billing_info || (data.doc_number ? data : null);
                    billingOk++;
                  } else {
                    billingErr++;
                    // No loguear el body: billing_info trae datos personales del comprador
                    if (billingErr <= 3) console.error(`[ml-billing] ${o.id} status=${r.status}`);
                  }
                } catch (e) {
                  billingErr++;
                  if (billingErr <= 3) console.error(`[ml-billing] ${o.id} error: ${e.message}`);
                }
              }));
            }
            if (billingErr > 0) console.warn(`[ml-billing] ${billingErr}/${mlNeedBilling.length} fallaron (ok=${billingOk})`);

            for (const o of mlPaid) {
              const orderId = "ML-" + String(o.id);
              const buyer = o.buyer || {};
              // Combinamos billing_info del endpoint específico Y del response de /orders/search
              const bi = billingByOrderId[o.id] || buyer.billing_info || null;
              const additional = (bi && Array.isArray(bi.additional_info)) ? bi.additional_info : [];
              const getInfo = (type) => additional.find(a => a.type === type)?.value || "";

              const businessName = getInfo("BUSINESS_NAME");
              const biFirstName = getInfo("FIRST_NAME");
              const biLastName = getInfo("LAST_NAME");
              // Nombre con fallback en cascada: 1) razón social, 2) billing_info nombres,
              // 3) buyer.first/last_name del search, 4) nickname, 5) "Consumidor Final"
              const customerName = businessName
                || [biFirstName, biLastName].filter(Boolean).join(" ").trim()
                || [buyer.first_name, buyer.last_name].filter(Boolean).join(" ").trim()
                || buyer.nickname
                || "Consumidor Final";
              // Doc: primero del billing_info dedicado, después del que vino en search
              const docRaw = String(bi?.doc_number || buyer.billing_info?.doc_number || "").replace(/[.\-]/g, "");
              const clas = clasificarDoc(docRaw);
              const shipAddr = o.shipping?.receiver_address || {};
              // billing_info también puede traer address (datos fiscales)
              const biAddr = bi?.buyer?.billing_info?.address || bi?.address || {};
              const billed = billedMap.get(orderId);

              // Construir dirección con todos los datos posibles (calle + número + dpto)
              const calle = shipAddr.street_name || biAddr.street_name || "";
              const numero = shipAddr.street_number || biAddr.street_number || "";
              const comment = shipAddr.comment || ""; // dpto, piso, etc
              const direccionStr = [
                [calle, numero].filter(Boolean).join(" "),
                comment,
              ].filter(Boolean).join(", ");

              ordML[orderId] = {
                _platform: "mercadolibre",
                _platform_label: "ML",
                _order_number: String(o.id),
                _billed: !!billed,
                _billed_info: billed || null,
                nombre: customerName,
                email: buyer.email || "",
                dni: docRaw, ...clas,
                // Facturar lo que REALMENTE paga el cliente: total_amount NO resta
                // el cupón/descuento (el comprador paga total_amount − coupon.amount).
                total: Math.max(0, (parseFloat(o.total_amount) || 0) - (parseFloat(o.coupon?.amount) || 0)),
                subtotal: Math.max(0, (parseFloat(o.total_amount) || 0) - (parseFloat(o.coupon?.amount) || 0)),
                descuento: parseFloat(o.coupon?.amount) || 0,
                envio: parseFloat(o.shipping?.cost) || 0,
                estado_pago: "paid",
                fecha: o.date_closed || o.date_created || "",
                ciudad: shipAddr.city?.name || biAddr.city_name || biAddr.city?.name || "",
                provincia: shipAddr.state?.name || biAddr.state_name || biAddr.state?.name || "",
                direccion: direccionStr,
                metodo_pago: "Mercado Pago",
                plataforma_pago: "Mercado Pago",
                items: (o.order_items || []).map(it => ({
                  nombre: it.item?.title || "Producto",
                  nombre_original: it.item?.title || "Producto",
                  cantidad: parseInt(it.quantity) || 1,
                  precio: parseFloat(it.unit_price) || 0,
                  descuento_item: 0,
                })),
              };
            }
          }
        } catch (e) {
          console.error("[ml] error trayendo órdenes:", e.message);
        }
      })());

      await Promise.all(fetchers);
      Object.assign(ordenes, ordTN, ordSH, ordML);

      // Plataformas no conectadas (informativas)
      if (!stores.find(s => s.type === "tiendanube")) connections.push({ platform: "tiendanube", connected: false });
      if (!stores.find(s => s.type === "shopify")) connections.push({ platform: "shopify", connected: false });
      if (!stores.find(s => s.type === "mercadolibre")) connections.push({ platform: "mercadolibre", connected: false });

      // Ordenar todas las órdenes por fecha desc (las más recientes primero), mezclando canales.
      const ordenadas = Object.fromEntries(
        Object.entries(ordenes).sort(([, a], [, b]) =>
          String(b.fecha || "").localeCompare(String(a.fecha || ""))
        )
      );

      // No cachear esta respuesta — el merchant edita datos del cliente
      // (DNI/CUIT) directamente en TN/Shopify y necesita ver el cambio
      // reflejado apenas vuelve a Growith y aprieta "Actualizar".
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      return res.json({
        connections,
        total_pending: Object.keys(ordenadas).length,
        ordenes: ordenadas,
        _tn_debug: tnDebug || null, // cuántas trajo TN por status (para diagnóstico)
      });
    }

    // ── TN: traer órdenes pendientes de facturar (legacy, mantener compat) ──

    if (action === "tn_pending_orders" && req.method === "GET") {
      const cuitParam = String(req.query.cuit || "").replace(/\D/g, "");
      if (!cuitParam) return res.status(400).json({ error: "Falta cuit" });

      // Rango de fechas: usa `since` y `until` si vienen, sino calcula desde `days`
      // (en zona Argentina UTC-3 para no correr el día).
      const argYmd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(d);
      let sinceDate, untilDate;
      if (req.query.since) {
        sinceDate = String(req.query.since).slice(0, 10);
        untilDate = req.query.until ? String(req.query.until).slice(0, 10) : argYmd(new Date());
      } else {
        // "days" incluye el día de hoy: days=1 es solo hoy en Argentina. Antes
        // restaba days completos y "Hoy" devolvía ayer + hoy.
        const days = Math.min(parseInt(req.query.days) || 7, 365);
        sinceDate = argYmd(new Date(Date.now() - (days - 1) * 86400000));
        untilDate = argYmd(new Date());
      }

      // 1) Leer la store TN del user
      const userSnap = await db.collection("users").doc(uid).get();
      if (!userSnap.exists) return res.json({ connected: false });
      const tnStore = (userSnap.data().stores || []).find(s => s.type === "tiendanube");
      if (!tnStore?.accessToken || !tnStore?.storeId) return res.json({ connected: false });

      // 2) Traer órdenes pagas del período seleccionado
      const headers = {
        "Authentication": `bearer ${tnStore.accessToken}`,
        "User-Agent": "GrowithApp (contacto.growith@gmail.com)",
      };
      const fetchLegacyStatus = async (status) => {
        const out = [];
        for (let page = 1; page <= 5; page++) {
          let url = `https://api.tiendanube.com/v1/${tnStore.storeId}/orders?per_page=200&page=${page}&payment_status=${status}&created_at_min=${sinceDate}T00:00:00-03:00`;
          if (untilDate) url += `&created_at_max=${untilDate}T23:59:59-03:00`;
          const r = await fetch(url, { headers });
          if (!r.ok) { console.warn(`[tn-legacy] ${status} page ${page} failed: ${r.status}`); break; }
          const batch = await r.json();
          if (!Array.isArray(batch) || batch.length === 0) break;
          out.push(...batch);
          if (batch.length < 200) break;
        }
        return out;
      };
      const [paidLeg, authLeg] = await Promise.all([fetchLegacyStatus("paid"), fetchLegacyStatus("authorized")]);
      const legById = new Map();
      for (const o of [...paidLeg, ...authLeg]) legById.set(o.id ?? o.number, o);
      const allOrders = [...legById.values()];

      // 3) Filtrar las que ya están facturadas (cruzando con arca_comprobantes)
      const billedSnap = await db.collection("users").doc(uid).collection("arca_comprobantes")
        .where("cuit_emisor", "==", cuitParam).get();
      const billedIds = new Set(billedSnap.docs.map(d => { const x = d.data(); return x.anulada ? null : x.orden_id; }).filter(Boolean));

      // 4) Normalizar al schema interno
      const ordenes = {};
      for (const o of allOrders) {
        const orderId = String(o.number || o.id);
        if (billedIds.has(orderId)) continue;
        // Skip canceladas y no-pagas (incluir "authorized" para órdenes recientes con MercadoPago)
        if ((o.status || "").toLowerCase() === "cancelled") continue;
        const pStatusLeg = (o.payment_status || "").toLowerCase();
        if (!["paid", "authorized"].includes(pStatusLeg)) continue;

        const docRaw = String(o.customer?.identification || "").replace(/[.\-]/g, "");
        const clas = clasificarDoc(docRaw);
        const customerName = `${o.customer?.first_name || ""} ${o.customer?.last_name || ""}`.trim()
          || o.customer?.name || o.contact_name || "";

        ordenes[orderId] = {
          nombre: customerName,
          email: o.customer?.email || o.contact_email || "",
          dni: docRaw,
          ...clas,
          total: parseFloat(o.total) || 0,
          subtotal: parseFloat(o.subtotal) || 0,
          descuento: parseFloat(o.discount) || 0,
          envio: parseFloat(o.shipping_cost_customer) || 0,
          estado_pago: "paid",
          fecha: o.paid_at || o.created_at || "",
          ciudad: o.shipping_address?.city || o.billing_city || "",
          provincia: o.shipping_address?.province || o.billing_province || "",
          direccion: [
            o.shipping_address?.address || o.billing_address || "",
            o.shipping_address?.number || o.billing_number || "",
            o.shipping_address?.floor || o.billing_floor || "",
          ].filter(Boolean).join(" ").trim(),
          metodo_pago: o.payment_details?.method || (o.payment_status === "paid" ? "Pagado" : ""),
          plataforma_pago: normPlataformaPago(o.gateway_name || o.gateway, o.payment_details?.method),
          items: (o.products || []).map(p => ({
            nombre: p.name || "Producto",
            nombre_original: p.name || "Producto",
            cantidad: parseInt(p.quantity) || 1,
            precio: parseFloat(p.price) || 0,
            descuento_item: 0,
          })),
        };
      }

      return res.json({
        connected: true,
        store_name: tnStore.storeName || "Tienda Nube",
        total_found: allOrders.length,
        total_pending: Object.keys(ordenes).length,
        ordenes,
      });
    }

    // ── DUPLICADOS: verificar si una orden ya fue facturada este mes ──

    if (action === "check_duplicates" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const { cuit: cuitParam, order_ids } = body;
      if (!cuitParam || !Array.isArray(order_ids)) return res.status(400).json({ error: "Faltan cuit u order_ids" });
      // Firestore "where in" limita a 30 valores — batchea si es necesario.
      // Sin filtro de fecha: detecta duplicados aunque la factura original sea de otro mes.
      const dup = [];
      for (let i = 0; i < order_ids.length; i += 30) {
        const chunk = order_ids.slice(i, i + 30);
        const snap = await db.collection("users").doc(uid).collection("arca_comprobantes")
          .where("cuit_emisor", "==", cuitParam)
          .where("orden_id", "in", chunk)
          .get();
        snap.docs.forEach(d => {
          const x = d.data();
          if (x.anulada) return; // anulada con NC → la orden es re-facturable, no es duplicado
          dup.push({ orden_id: x.orden_id, letra: x.letra, nro: x.nro, total: x.total });
        });
      }
      return res.json({ duplicates: dup });
    }

    // ── RECUPERAR REGISTROS DESDE AFIP (resync) ────────
    // Reconstruye en arca_comprobantes (y arca_notas_credito) los comprobantes
    // que AFIP tiene autorizados pero que no quedaron guardados localmente (ej:
    // la función murió después del CAE y antes del guardado, o un guardado que
    // falló, o se emitieron desde otro sistema antes de usar Growith).
    // Estrategia: FEParamGetPtosVenta → por cada PV real del CUIT (incluidos los
    // dados de baja: la numeración histórica sigue en AFIP), escanear SIEMPRE
    // facturas A/B/C (1,6,11) y NC A/B/C (3,8,13) sin importar la condición
    // fiscal ACTUAL — una migración Monotributo→RI deja PVs/tipos viejos que de
    // otra forma nunca se revisarían. FECompUltimoAutorizado por PV/tipo → se
    // recorre la numeración hacia atrás y se consulta con FECompConsultar SOLO
    // los números que faltan.
    // Merge puro: create() nunca pisa un registro existente; los reconstruidos
    // quedan marcados con recuperado_afip:true. No resucita facturas anuladas
    // con NC (se cruzan contra arca_notas_credito.factura_origen).
    // Params (body): cuit (obligatorio), pv (opcional: limita a ese PV),
    //                tipo_cbte (opcional), desde_nro (opcional, con tipo_cbte+pv),
    //                cursor (opcional: el devuelto por la corrida anterior).
    // Presupuesto por corrida: 200 consultas a AFIP o ~90s — si queda numeración
    // sin revisar devuelve pendientes:true + cursor {pv,tipo,nro,pvs} para que
    // la próxima corrida retome exactamente donde quedó, sin re-escanear.
    // Respuesta: { ok, pvs, tipos, consultados, recuperados, migrados,
    //              pendientes, cursor, porPv: {"pv_tipo": n}, detalle }
    if (action === "resync_afip" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const cuitParam = String(body.cuit || "").replace(/\D/g, "");
      if (!cuitParam) return res.status(400).json({ error: "Falta cuit" });
      const cfg = await loadCuitConfig(db, uid, cuitParam);
      if (!cfg?.cert_pem || !cfg?.key_pem) return res.status(400).json({ error: "Falta certificado o clave para ese CUIT" });

      const { wsfe } = arcaUrls(cfg.arca_prod);
      const { token, sign } = await obtenerTA(db, uid, cfg);
      const cuitNum = parseInt(cfg.cuit);
      let cursor = (body.cursor && typeof body.cursor === "object" && parseInt(body.cursor.pv)) ? body.cursor : null;

      const compCol = db.collection("users").doc(uid).collection("arca_comprobantes");

      // Migración de formato (solo la primera ronda, sin cursor): registros
      // viejos guardaron cuit_emisor CON guiones → no matchean el filtro por
      // dígitos y desaparecen del historial (y el resync los duplicaría).
      // Normalizamos a solo dígitos, paginado de a 500.
      let migrados = 0;
      if (!cursor) {
        let last = null;
        while (true) {
          let q = compCol.orderBy(FieldPath.documentId()).limit(500);
          if (last) q = q.startAfter(last);
          const page = await q.get();
          if (page.empty) break;
          const batch = db.batch();
          let dirty = 0;
          page.docs.forEach(d => {
            const ce = d.data().cuit_emisor;
            if (ce != null && /\D/.test(String(ce))) {
              batch.set(d.ref, { cuit_emisor: String(ce).replace(/\D/g, "") }, { merge: true });
              dirty++;
            }
          });
          if (dirty) { await batch.commit(); migrados += dirty; }
          last = page.docs[page.size - 1];
          if (page.size < 500) break;
        }
      }

      // Tipos a escanear: SIEMPRE facturas A/B/C y NC A/B/C, sin importar la
      // condición fiscal actual (una migración de condición deja tipos viejos).
      const NC_TIPOS = new Set([3, 8, 13]);
      const tiposValidos = [1, 6, 11, 3, 8, 13];
      const tipoReq = parseInt(body.tipo_cbte) || null;
      const tipos = tipoReq
        ? (tiposValidos.includes(tipoReq) ? [tipoReq] : [])
        : tiposValidos;
      if (!tipos.length) return res.status(400).json({ error: `tipo_cbte inválido (válidos: ${tiposValidos.join(", ")})` });
      const pvReq = parseInt(body.pv) || null;
      const desdeNro = parseInt(body.desde_nro) || null;

      // Puntos de venta: el pedido explícito manda; si no, TODOS los del CUIT
      // según AFIP (el cursor los trae cacheados para no re-consultar). Fallback
      // si FEParamGetPtosVenta falla o viene vacío: PV del cfg + 1..5.
      let pvs;
      if (pvReq) pvs = [pvReq];
      else if (Array.isArray(cursor?.pvs) && cursor.pvs.length) pvs = cursor.pvs.map(n => parseInt(n)).filter(Boolean);
      else {
        try { pvs = await getPtosVenta(token, sign, cuitNum, wsfe); } catch (_) { pvs = []; }
        if (!pvs.length) pvs = [...new Set([parseInt(cfg.punto_venta) || 0, 1, 2, 3, 4, 5].filter(Boolean))];
      }
      // Cursor que no matchea la lista actual (cambió pv/tipo pedido): ignorarlo
      if (cursor && (!pvs.includes(parseInt(cursor.pv)) || !tipos.includes(parseInt(cursor.tipo)))) cursor = null;

      // Lo ya guardado para este CUIT — una sola query, se indexa en memoria.
      // Registros muy viejos pueden no tener punto_venta: clave comodín "*" que
      // matchea cualquier PV, para no re-crear duplicados de esos.
      const compSnap = await compCol.where("cuit_emisor", "==", cuitParam).get();
      const existentes = new Set();
      compSnap.docs.forEach(d => {
        const c = d.data();
        existentes.add(`${parseInt(c.tipo_cbte)}|${parseInt(c.punto_venta) || "*"}|${parseInt(c.nro)}`);
      });
      // NC ya registradas (no re-crearlas) + facturas anuladas con NC (no
      // volver a mostrarlas en Registros)
      const ncExist = new Set();
      const anuladas = new Set();
      try {
        const ncSnap = await db.collection("users").doc(uid).collection("arca_notas_credito").get();
        ncSnap.docs.forEach(d => {
          const c = d.data();
          const ncCuit = String(c.cuit || "").replace(/\D/g, "");
          if (ncCuit && ncCuit !== cuitParam) return;
          if (c.comprobante) ncExist.add(`${parseInt(c.tipo)}|${parseInt(c.punto_venta) || "*"}|${parseInt(c.comprobante)}`);
          const fo = c.factura_origen;
          if (fo?.comprobante) anuladas.add(`${parseInt(fo.tipo)}|${parseInt(fo.punto_venta) || "*"}|${parseInt(fo.comprobante)}`);
        });
      } catch (_) {}
      const tiene = (set, tipo, pv, nro) => set.has(`${tipo}|${pv}|${nro}`) || set.has(`${tipo}|*|${nro}`);

      const MAX_LOOKUPS = 200;              // consultas a AFIP por corrida
      const DEADLINE = Date.now() + 90000;  // margen contra el maxDuration de 120s
      const SCAN_MAX = 2000;                // números revisados por PV/tipo
      let lookups = 0, recuperados = 0, pendientes = false, nextCursor = null;
      const porPv = {};
      const detalle = [];
      // Retomando: saltear los pares (pv,tipo) anteriores al del cursor
      let resuming = !!cursor;

      outer:
      for (const pv of pvs) {
        for (const tipoCbte of tipos) {
          if (resuming) {
            if (pv !== parseInt(cursor.pv) || tipoCbte !== parseInt(cursor.tipo)) continue;
            resuming = false; // este es el par donde quedó la corrida anterior
          }
          if (lookups >= MAX_LOOKUPS || Date.now() > DEADLINE) {
            pendientes = true; nextCursor = { pv, tipo: tipoCbte, nro: null, pvs };
            break outer;
          }
          let ultimo;
          lookups++;
          try { ultimo = await getUltimoCbte(token, sign, cuitNum, pv, tipoCbte, wsfe); }
          catch (e) { detalle.push({ pv, tipo_cbte: tipoCbte, error: e.message }); continue; }
          if (!ultimo) continue; // nada emitido nunca en este PV/tipo

          let start = ultimo;
          if (cursor && parseInt(cursor.pv) === pv && parseInt(cursor.tipo) === tipoCbte && parseInt(cursor.nro)) {
            start = Math.min(parseInt(cursor.nro), ultimo);
          } else if (desdeNro && tipoReq && pvReq) {
            start = Math.min(desdeNro, ultimo);
          }
          const floor = Math.max(1, ultimo - SCAN_MAX + 1);
          const esNC = NC_TIPOS.has(tipoCbte);
          let recTipo = 0, corte = null;

          for (let nro = start; nro >= floor; nro--) {
            if (esNC ? tiene(ncExist, tipoCbte, pv, nro)
                     : (tiene(existentes, tipoCbte, pv, nro) || tiene(anuladas, tipoCbte, pv, nro))) continue;
            if (lookups >= MAX_LOOKUPS || Date.now() > DEADLINE) {
              pendientes = true; corte = nro; nextCursor = { pv, tipo: tipoCbte, nro, pvs };
              break;
            }
            lookups++;
            const afip = await consultarComprobanteCompleto(token, sign, cuitNum, pv, tipoCbte, nro, wsfe);
            if (afip === null) continue; // AFIP tampoco lo tiene: hueco real, seguir
            if (afip.error) { detalle.push({ pv, tipo_cbte: tipoCbte, nro, error: afip.error }); continue; }

            const letra = (tipoCbte === 1 || tipoCbte === 3) ? "A" : (tipoCbte === 6 || tipoCbte === 8) ? "B" : "C";
            const fIso = `${afip.fecha.slice(0, 4)}-${afip.fecha.slice(4, 6)}-${afip.fecha.slice(6, 8)}`;
            try {
              if (esNC) {
                // NC recuperada → a su colección propia (sin factura_origen:
                // AFIP no informa qué factura anulaba)
                const docId = `${cuitParam}_nc_${pv}_${tipoCbte}_${String(nro).padStart(8, "0")}`;
                // create() falla si el doc ya existe → imposible pisar un registro real
                await db.collection("users").doc(uid).collection("arca_notas_credito").doc(docId).create({
                  cuit: cuitParam,
                  tipo: tipoCbte,
                  letra,
                  punto_venta: pv,
                  comprobante: nro,
                  cae: afip.cae,
                  cae_vto: afip.cae_vto,
                  total: afip.total,
                  doc_tipo: afip.doc_tipo,
                  doc_nro: afip.doc_nro,
                  // Mediodía ART del día del comprobante
                  fecha: `${fIso}T15:00:00.000Z`,
                  pdf_b64: null,
                  recuperado_afip: true,
                  recuperado_at: new Date().toISOString(),
                });
                ncExist.add(`${tipoCbte}|${pv}|${nro}`);
              } else {
                const docId = `${cuitParam}_${pv}_${tipoCbte}_${String(nro).padStart(8, "0")}`;
                // create() falla si el doc ya existe → imposible pisar un registro real
                await compCol.doc(docId).create({
                  cuit_emisor: cuitParam,
                  tipo_cbte: tipoCbte,
                  letra,
                  nro,
                  punto_venta: pv,
                  exento: !!afip.exento,
                  fecha_str: `${fIso.slice(8, 10)}/${fIso.slice(5, 7)}/${fIso.slice(0, 4)}`,
                  fecha_cbte: fIso,
                  // Mediodía ART del día del comprobante: en Registros agrupa por día
                  emitido_at: `${fIso}T15:00:00.000Z`,
                  cae: afip.cae,
                  cae_vto: afip.cae_vto,
                  cliente: "",
                  doc_tipo: afip.doc_tipo,
                  doc_nro: afip.doc_nro,
                  total: afip.total,
                  // Factura C: WSFE no discrimina neto → neto = total
                  neto: (tipoCbte === 11 && !afip.neto) ? afip.total : afip.neto,
                  iva: afip.iva,
                  orden_id: null,
                  items: [],
                  domicilio: "",
                  ml_uploaded: false,
                  recuperado_afip: true,
                  recuperado_at: new Date().toISOString(),
                });
                existentes.add(`${tipoCbte}|${pv}|${nro}`);
              }
              recuperados++; recTipo++;
              const pk = `${pv}_${tipoCbte}`;
              porPv[pk] = (porPv[pk] || 0) + 1;
            } catch (e) {
              // ALREADY_EXISTS (carrera con otra corrida) u otro fallo: no cuenta
              if (!/already.?exists/i.test(e.message || "")) detalle.push({ pv, tipo_cbte: tipoCbte, nro, error: e.message });
            }
          }
          detalle.push({ pv, tipo_cbte: tipoCbte, ultimo, recuperados: recTipo, ...(corte ? { pendiente_desde: corte } : {}) });
          if (pendientes) break outer;
        }
      }

      console.log(`[arca resync] uid=${uid} cuit=${cuitParam} pvs=${pvs.join(",")} tipos=${tipos.join(",")} consultas=${lookups} recuperados=${recuperados} migrados=${migrados} pendientes=${pendientes}${nextCursor ? ` cursor=${nextCursor.pv}/${nextCursor.tipo}/${nextCursor.nro}` : ""}`);
      return res.json({ ok: true, pvs, tipos, consultados: lookups, recuperados, migrados, pendientes, cursor: nextCursor, porPv, detalle });
    }

    return res.status(404).json({ error: `Acción desconocida: ${action}` });

  } catch (e) {
    console.error("[arca]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
