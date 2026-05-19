// api/arca.js
// ARCA (ex-AFIP) — Facturación electrónica para Growith
// Soporta: parseo XLSX de ML / CSV de Shopify, emisión WSAA+WSFE, generación PDF, descarga ZIP
//
// Dependencias npm: node-forge (firma CMS), xlsx (parseo), pdf-lib (PDF), jszip (ZIP)
// Instalá: npm install node-forge xlsx pdf-lib jszip

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { XMLParser } from "fast-xml-parser";
import { getValidMLToken } from "./integrations.js";

// Filtra valores basura ("?", "-", "—", "S/N", "N/A", "null", undefined) y arma una dirección legible.
function cleanAddr(parts) {
  const invalid = new Set(["", "?", "-", "—", "S/N", "s/n", "N/A", "n/a", "null", "undefined"]);
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
  // 1) Campos donde puede venir el doc según configuración del checkout
  const candidates = [
    o.billing_address?.company,
    o.shipping_address?.company,
    o.customer?.note,
    o.note_attributes?.find(a => /(dni|cuit|cuil|tax)/i.test(a?.name||""))?.value,
  ];
  for (const c of candidates) {
    const clean = String(c || "").replace(/[.\-\s]/g, "");
    if (/^\d{7,11}$/.test(clean)) return clean;
  }
  // 2) Fallback: regex sobre la nota completa del pedido
  const noteText = String(o.note || "");
  if (noteText) {
    const m = noteText.match(/\b(\d{7,11})\b/);
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

async function arcaFetch(url, opts = {}) {
  const { fetch: undiciFetch } = await import("undici");
  const dispatcher = await getArcaDispatcher();
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 45000);
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
    return { token: tokenMatch[1].trim(), sign: signMatch[1].trim() };
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

// ─── Llamada WSFE ──────────────────────────────────────

async function wsfeCall(action, bodyXml, wsfeUrl) {
  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <soapenv:Body>
    <ar:${action}>
      ${bodyXml}
    </ar:${action}>
  </soapenv:Body>
</soapenv:Envelope>`;

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
      });
    } catch (e) {
      if (intento < 2) { await new Promise(res => setTimeout(res, (intento + 1) * 3000)); continue; }
      const cause = e.cause?.code || e.cause?.message || "";
      if (e.name === "AbortError") throw new Error("WSFE no respondió en 45 segundos. Probá de nuevo.");
      throw new Error(`No se pudo conectar con WSFE: ${e.message}${cause ? " — " + cause : ""}`);
    }
    const text = await r.text();
    if (r.ok) return text;
    if (r.status === 500 && intento < 2) {
      await new Promise(res => setTimeout(res, (intento + 1) * 3000));
      continue;
    }
    throw new Error(`WSFE HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
}

function authXml(token, sign, cuitNum) {
  return `<ar:Auth>
    <ar:Token>${token}</ar:Token>
    <ar:Sign>${sign}</ar:Sign>
    <ar:Cuit>${cuitNum}</ar:Cuit>
  </ar:Auth>`;
}

async function getUltimoCbte(token, sign, cuitNum, puntoVenta, tipoCbte, wsfeUrl) {
  const body = `${authXml(token, sign, cuitNum)}
    <ar:PtoVta>${puntoVenta}</ar:PtoVta>
    <ar:CbteTipo>${tipoCbte}</ar:CbteTipo>`;
  const xml = await wsfeCall("FECompUltimoAutorizado", body, wsfeUrl);
  const m = xml.match(/<CbteNro>(\d+)<\/CbteNro>/);
  return m ? parseInt(m[1]) : 0;
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

// Chequea si una fecha YYYYMMDD está dentro de los 10 días corridos hacia atrás desde hoy
// (límite de ARCA WSFE para emitir comprobantes con fecha retroactiva).
function dentroDe10DiasCorridos(yyyymmdd) {
  const y = parseInt(yyyymmdd.slice(0, 4));
  const m = parseInt(yyyymmdd.slice(4, 6));
  const d = parseInt(yyyymmdd.slice(6, 8));
  const target = new Date(Date.UTC(y, m - 1, d));
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const diffMs = today.getTime() - target.getTime();
  const diffDays = diffMs / (24 * 60 * 60 * 1000);
  return diffDays >= 0 && diffDays <= 10;
}

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
  // Factura B (6/7/8) con CUIT: tipicamente Monotributista o Exento — usamos Monotributo (mayoría e-commerce)
  if ((tipoCbte === 6 || tipoCbte === 7 || tipoCbte === 8) && docTipoClas === "CUIT") return 6;
  // Factura C (11/12/13) con CUIT: receptor probablemente Resp. Inscripto que compra a monotributo
  if ((tipoCbte === 11 || tipoCbte === 12 || tipoCbte === 13) && docTipoClas === "CUIT") return 1;
  // Cualquier otro caso: Consumidor Final
  return 5;
}

async function facturar(token, sign, cuitNum, puntoVenta, cbteNro, orden, tipoCbte, wsfeUrl, monotributo = false, fechaImputacion = null) {
  const total = orden.total;
  const fecha = fechaImputacion || new Date().toISOString().slice(0, 10).replace(/-/g, "");

  const docTipoClas = orden.doc_tipo;
  let tipoDoc, nroDoc, neto, iva;

  if (monotributo) {
    tipoCbte = 11;
    tipoDoc = docTipoClas === "CUIT" ? 80 : docTipoClas === "DNI" ? 96 : 99;
    nroDoc = orden.doc_nro || orden.dni || 0;
    neto = total; iva = 0;
  } else {
    neto = Math.round((total / 1.21) * 100) / 100;
    iva = Math.round((total - neto) * 100) / 100;
    if (docTipoClas === "CUIT") { tipoDoc = 80; nroDoc = orden.doc_nro || orden.dni; }
    else if (docTipoClas === "DNI") { tipoDoc = 96; nroDoc = orden.doc_nro || orden.dni; }
    else { tipoDoc = 99; nroDoc = 0; }
  }

  const condIva = condicionIvaReceptor(tipoCbte, docTipoClas);

  const ivaXml = (!monotributo && iva > 0) ? `
    <ar:Iva>
      <ar:AlicIva>
        <ar:Id>5</ar:Id>
        <ar:BaseImp>${neto}</ar:BaseImp>
        <ar:Importe>${iva}</ar:Importe>
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
          <ar:ImpTotal>${total}</ar:ImpTotal>
          <ar:ImpTotConc>0</ar:ImpTotConc>
          <ar:ImpNeto>${neto}</ar:ImpNeto>
          <ar:ImpOpEx>0</ar:ImpOpEx>
          <ar:ImpTrib>0</ar:ImpTrib>
          <ar:ImpIVA>${iva}</ar:ImpIVA>
          <ar:MonId>PES</ar:MonId>
          <ar:MonCotiz>1</ar:MonCotiz>
          <ar:CondicionIVAReceptorId>${condIva}</ar:CondicionIVAReceptorId>
          ${ivaXml}
        </ar:FECAEDetRequest>
      </ar:FeDetReq>
    </ar:FeCAEReq>`;

  const xml = await wsfeCall("FECAESolicitar", body, wsfeUrl);
  const caeM = xml.match(/<CAE>(\d+)<\/CAE>/);
  const vtoM = xml.match(/<CAEFchVto>(\d{8})<\/CAEFchVto>/);
  const resM = xml.match(/<Resultado>([AR])<\/Resultado>/);
  const obsM = [...xml.matchAll(/<Msg>([\s\S]*?)<\/Msg>/g)].map(m => m[1]).join(" ");

  const cae = caeM?.[1] || null;
  let caeVto = vtoM?.[1] || null;
  if (caeVto) caeVto = `${caeVto.slice(6)}/${caeVto.slice(4, 6)}/${caeVto.slice(0, 4)}`;

  return { cae, cae_vto: caeVto, resultado: resM?.[1] || null, obs: obsM.trim() };
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

  const fecha = factData.fecha_iso || new Date().toISOString().slice(0, 10);
  const cuitNum = parseInt(String(config.cuit).replace(/\D/g, ""));
  const docTipoCode = factData.doc_tipo === "CUIT" ? 80 : factData.doc_tipo === "DNI" ? 96 : 99;
  const docNroNum = parseInt(String(factData.doc_nro || "0").replace(/\D/g, "")) || 0;

  const payload = {
    ver: 1,
    fecha,
    cuit: cuitNum,
    ptoVta: parseInt(config.punto_venta) || 1,
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

  const { cuit, razon_social, nombre_fantasia, domicilio, punto_venta, condicion_fiscal, ingresos_brutos } = config;
  const isMonotributo = condicion_fiscal === "MONOTRIBUTO";
  const letra = factData.letra;
  const total = factData.total;
  const neto = isMonotributo ? total : Math.round((total / 1.21) * 100) / 100;
  const iva21 = isMonotributo ? 0 : Math.round((total - neto) * 100) / 100;

  // Generar QR una vez (mismo para las 3 copias)
  let qrImage = null;
  try {
    const qrBuffer = await generarQrArca(factData, config);
    qrImage = await pdfDoc.embedPng(qrBuffer);
  } catch (e) {
    console.error("[pdf] no se pudo generar QR:", e.message);
  }

  // Sanitiza texto para Helvetica (WinAnsi): caracteres fuera del rango se reemplazan
  const safe = (s) => String(s || "").replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");

  const drawPage = async (copyLabel) => {
    const page = pdfDoc.addPage([595, 842]);
    const { width: W, height: H } = page.getSize();
    const MX = 36;
    const UW = W - MX * 2;
    const MID = MX + UW / 2;

    const COL_BLACK = rgb(0, 0, 0);
    const COL_GREY = rgb(0.4, 0.4, 0.4);
    const COL_LINE = rgb(0.7, 0.7, 0.7);
    const COL_HEAD_BG = rgb(0.95, 0.95, 0.95);
    const COL_ACCENT = rgb(0.0, 0.0, 0.0);

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
    const line = (x1, y1, x2, y2, color = COL_LINE) => page.drawLine({
      start: { x: x1, y: H - y1 }, end: { x: x2, y: H - y2 },
      thickness: 0.6, color,
    });

    // ─────── HEADER ───────
    // Tres zonas: emisor (izq) | letra (centro) | datos factura (der)
    const HY = 40, HH = 80;
    const LW = 50; // ancho recuadro letra
    const halfW = (UW - LW) / 2;
    rect(MX, HY, halfW, HH);
    rect(MX + halfW, HY, LW, HH, { fill: rgb(0.98, 0.98, 0.98) });
    rect(MX + halfW + LW, HY, halfW, HH);

    // Letra grande en el centro
    draw(letra, MX + halfW + LW / 2, HY + 38, 38, true, "center");
    const cod = letra === "A" ? "01" : letra === "B" ? "06" : "11";
    draw("COD. " + cod, MX + halfW + LW / 2, HY + 60, 7, false, "center", COL_GREY);

    // Emisor (izquierda)
    draw(nombre_fantasia || razon_social, MX + 8, HY + 14, 12, true);
    draw("Razón Social: " + razon_social, MX + 8, HY + 28, 7);
    draw("Domicilio Comercial: " + (domicilio || "—"), MX + 8, HY + 39, 7);
    draw("Condición frente al IVA: " + (isMonotributo ? "Responsable Monotributo" : "IVA Responsable Inscripto"), MX + 8, HY + 50, 7);
    if (ingresos_brutos) draw("Ingresos Brutos: " + ingresos_brutos, MX + 8, HY + 61, 7);
    draw("Fecha Inicio Actividades: " + (config.fecha_inicio || "—"), MX + 8, HY + 72, 7);

    // Datos factura (derecha)
    const RX = MX + halfW + LW + 8;
    draw("FACTURA " + letra, RX, HY + 14, 14, true);
    draw("Punto de Venta: " + String(punto_venta).padStart(5, "0") + "    Comp. Nro: " + String(factData.comprobante).padStart(8, "0"), RX, HY + 28, 7);
    draw("Fecha de Emisión: " + factData.fecha, RX, HY + 39, 7);
    draw("CUIT: " + cuit, RX, HY + 50, 7);

    // ─────── DATOS RECEPTOR ───────
    const RY = HY + HH + 12;
    rect(MX, RY, UW, 36);
    const docTipo = factData.doc_tipo;
    const docNro = factData.doc_nro || "";
    const condIVA = docTipo === "CUIT" ? "IVA Responsable Inscripto" : "Consumidor Final";
    const docLabel = docTipo === "CUIT" ? "CUIT" : docTipo === "DNI" ? "DNI" : "";
    const clienteName = factData.cliente || "Consumidor Final";

    if (docLabel && docNro) {
      draw(docLabel + ": " + docNro, MX + 8, RY + 11, 8, true);
      draw("Apellido y Nombre / Razón Social: " + clienteName, MID + 8, RY + 11, 7);
    } else {
      draw("Apellido y Nombre / Razón Social: " + clienteName, MX + 8, RY + 11, 8, true);
    }
    draw("Condición frente al IVA: " + condIVA, MX + 8, RY + 22, 7);
    draw("Domicilio: " + (factData.domicilio || "—"), MID + 8, RY + 22, 7);
    draw("Condición de venta: Contado", MX + 8, RY + 32, 7);

    // ─────── TABLA ITEMS ───────
    const TY = RY + 50;
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

    // Header fila
    let cx = MX;
    const headRowH = 14;
    for (let i = 0; i < scaledCols.length; i++) {
      page.drawRectangle({
        x: cx, y: H - TY - headRowH, width: scaledCols[i], height: headRowH,
        color: COL_HEAD_BG, borderColor: COL_BLACK, borderWidth: 0.4,
      });
      // Producto / Servicio (col 0) = left, Cant/U.Medida (1,2) = center, el resto (precios) = right
      const align = i === 0 ? "left" : i >= 3 ? "right" : "center";
      const xPos = align === "right" ? cx + scaledCols[i] - 4 : align === "center" ? cx + scaledCols[i] / 2 : cx + 4;
      draw(hdrs[i], xPos, TY + 9, 7, true, align);
      cx += scaledCols[i];
    }

    // Filas de items
    let iy = TY + headRowH;
    const items = factData.items || [];
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const precioBruto = item.precio || 0;
      const precioUnit = isMonotributo ? precioBruto : Math.round((precioBruto / 1.21) * 100) / 100;
      const subtotal = Math.round(item.cantidad * precioUnit * 100) / 100;
      const bonif = item.descuento_item > 0 ? Math.round((item.descuento_item / (item.cantidad * item.precio)) * 10000) / 100 : 0;
      const nombreItem = (item.nombre || "Producto").length > 60 ? (item.nombre || "Producto").slice(0, 60) + "…" : (item.nombre || "Producto");
      const cellData = [
        nombreItem,
        String(item.cantidad),
        "unidades",
        precioUnit.toFixed(2),
        bonif > 0 ? bonif.toFixed(2) : "0,00",
        subtotal.toFixed(2),
        ...(showIVA ? ["21,00%"] : []),
      ];

      const rowH = 12;
      let cx2 = MX;
      for (let i = 0; i < scaledCols.length; i++) {
        rect(cx2, iy, scaledCols[i], rowH, { borderWidth: 0.3 });
        const align = i === 0 ? "left" : i >= 3 ? "right" : "center";
        const xPos = align === "right" ? cx2 + scaledCols[i] - 4 : align === "center" ? cx2 + scaledCols[i] / 2 : cx2 + 4;
        draw(cellData[i], xPos, iy + 8, 7, false, align);
        cx2 += scaledCols[i];
      }
      iy += rowH;
    }

    // Filler para que la tabla tenga altura mínima
    const minRows = 4;
    for (let i = items.length; i < minRows; i++) {
      let cx2 = MX;
      for (const c of scaledCols) { rect(cx2, iy, c, 12, { borderWidth: 0.3 }); cx2 += c; }
      iy += 12;
    }

    // ─────── TOTALES ───────
    const totY = iy + 16;
    rect(MX, totY, UW, 70);
    // Importes a la derecha
    const labelX = MX + UW - 130;
    const valX = MX + UW - 12;
    let ty2 = totY + 12;
    if (showIVA) {
      const rows = [
        ["Subtotal:", "$ " + neto.toFixed(2)],
        ["Importe Neto Gravado:", "$ " + neto.toFixed(2)],
        ["IVA 21%:", "$ " + iva21.toFixed(2)],
      ];
      for (const [l, v] of rows) {
        draw(l, labelX, ty2, 8, false, "right");
        draw(v, valX, ty2, 8, false, "right");
        ty2 += 12;
      }
    } else {
      draw("Subtotal:", labelX, ty2, 8, false, "right");
      draw("$ " + total.toFixed(2), valX, ty2, 8, false, "right");
      ty2 += 12;
    }
    // Línea separadora de total
    line(MX + UW - 200, ty2 + 2, MX + UW - 8, ty2 + 2, COL_BLACK);
    draw("Importe Total:", labelX, ty2 + 16, 11, true, "right");
    draw("$ " + total.toFixed(2), valX, ty2 + 16, 12, true, "right");

    // ─────── CAE / AUTORIZACIÓN + QR ARCA ───────
    const caeY = totY + 86;
    const qrSize = 75;
    rect(MX, caeY, UW, qrSize + 8, { fill: rgb(0.97, 0.97, 0.97) });

    // QR a la izquierda
    if (qrImage) {
      page.drawImage(qrImage, {
        x: MX + 8, y: H - caeY - qrSize - 4, width: qrSize, height: qrSize,
      });
    }

    // Texto del medio
    const midX = MX + qrSize + 22;
    draw("Comprobante Autorizado", midX, caeY + 14, 9, true);
    draw("AGENCIA DE RECAUDACIÓN Y CONTROL ADUANERO (ARCA)", midX, caeY + 26, 7, false, "left", COL_GREY);

    // CAE a la derecha
    draw("CAE N°:", MX + UW - 130, caeY + 14, 8, true, "left");
    draw(factData.cae || "—", MX + UW - 8, caeY + 14, 9, true, "right");
    draw("Fecha de Vto. CAE:", MX + UW - 130, caeY + 26, 7, false, "left");
    draw(factData.cae_vto || "—", MX + UW - 8, caeY + 26, 7, false, "right");

    // ─────── COPIA + FOOTER GROWITH ───────
    draw(copyLabel, MX, H - 50, 7, true, "left", COL_GREY);
    draw("Página 1 de 1", MX + UW, H - 50, 7, false, "right", COL_GREY);

    // Línea separadora antes del footer
    line(MX, H - 38, MX + UW, H - 38, COL_LINE);
    draw("Documento emitido por Growith — growithapp.com", MX + UW / 2, H - 28, 7, false, "center", COL_GREY);
  };

  for (const copy of ["ORIGINAL", "DUPLICADO", "TRIPLICADO"]) {
    await drawPage(copy);
  }

  return pdfDoc.save();
}

// ─── Helpers Firestore para config CUIT ───────────────

async function loadCuitConfig(db, uid, cuit) {
  const snap = await db.collection("users").doc(uid).collection("arca_cuits").doc(String(cuit)).get();
  return snap.exists ? snap.data() : null;
}
async function saveCuitConfig(db, uid, cuit, data) {
  await db.collection("users").doc(uid).collection("arca_cuits").doc(String(cuit)).set(data, { merge: true });
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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { action, uid, cuit } = req.query;
  if (!uid) return res.status(401).json({ error: "Falta uid" });

  const db = initAdmin();

  try {
    // ── CUITS: listar ──────────────────────────────────

    if (action === "list_cuits" && req.method === "GET") {
      const cuits = await listCuits(db, uid);
      return res.json({ cuits: cuits.map(c => ({ ...c, cert_pem: undefined, key_pem: undefined, has_cert: Boolean(c.cert_pem), has_key: Boolean(c.key_pem) })) });
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
      if (data.cert_pem) updated.cert_pem = data.cert_pem;
      if (data.key_pem) updated.key_pem = data.key_pem;

      await saveCuitConfig(db, uid, cuitNum, updated);
      return res.json({ ok: true, cuit: cuitNum, has_cert: Boolean(updated.cert_pem), has_key: Boolean(updated.key_pem) });
    }

    // ── CUITS: test conexión ───────────────────────────

    if (action === "test_cuit" && req.method === "POST") {
      if (!cuit) return res.status(400).json({ error: "Falta cuit" });
      const cfg = await loadCuitConfig(db, uid, cuit);
      if (!cfg?.cert_pem || !cfg?.key_pem) return res.status(400).json({ error: "Falta certificado o clave" });

      const { wsaa, wsfe } = arcaUrls(cfg.arca_prod);
      const cms = await firmarTRA(cfg.cert_pem, cfg.key_pem, cfg.arca_prod);
      const { token, sign } = await loginWSAA(cms, wsaa);
      const ultimoB = await getUltimoCbte(token, sign, parseInt(cfg.cuit), cfg.punto_venta, 6, wsfe);

      await saveCuitConfig(db, uid, cuit, { ...cfg, last_test: { ok: true, ts: new Date().toISOString(), ultimo_b: ultimoB } });
      return res.json({ ok: true, msg: "Conexión OK", ultimo_b: ultimoB });
    }

    // ── CUITS: eliminar ────────────────────────────────

    if (action === "delete_cuit" && req.method === "DELETE") {
      if (!cuit) return res.status(400).json({ error: "Falta cuit" });
      await db.collection("users").doc(uid).collection("arca_cuits").doc(String(cuit)).delete();
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
        if (!data.emitido_at || data.emitido_at < monthStart || data.emitido_at >= monthEnd) continue;
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

    // ── EMITIR facturas ────────────────────────────────

    if (action === "emit" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString());
      const { cuit: cuitEmit, ordenes, product_map, mes_imputacion } = body;
      if (!cuitEmit || !ordenes) return res.status(400).json({ error: "Faltan cuit u ordenes" });

      // Resolver fecha de imputación. "anterior" = último día hábil del mes pasado.
      let fechaImputacion = null;
      if (mes_imputacion === "anterior") {
        fechaImputacion = ultimoDiaHabilMesAnterior();
        if (!dentroDe10DiasCorridos(fechaImputacion)) {
          return res.status(400).json({
            error: `No se puede imputar al mes anterior: la fecha calculada (${fechaImputacion.slice(6,8)}/${fechaImputacion.slice(4,6)}/${fechaImputacion.slice(0,4)}) está fuera del rango de 10 días corridos que permite ARCA. Solo es posible los primeros días hábiles de cada mes.`
          });
        }
      }

      const cfg = await loadCuitConfig(db, uid, cuitEmit);
      if (!cfg?.cert_pem || !cfg?.key_pem) return res.status(400).json({ error: "Falta certificado o clave para ese CUIT" });

      const isMonotributo = cfg.condicion_fiscal === "MONOTRIBUTO";
      const { wsaa, wsfe } = arcaUrls(cfg.arca_prod);

      // Autenticar
      const cms = await firmarTRA(cfg.cert_pem, cfg.key_pem, cfg.arca_prod);
      const { token, sign } = await loginWSAA(cms, wsaa);

      // Numeradores
      const cuitNum = parseInt(cfg.cuit);
      const pv = cfg.punto_venta;
      let cbteA = isMonotributo ? 0 : (await getUltimoCbte(token, sign, cuitNum, pv, 1, wsfe)) + 1;
      let cbteB = isMonotributo ? 0 : (await getUltimoCbte(token, sign, cuitNum, pv, 6, wsfe)) + 1;
      let cbteC = isMonotributo ? (await getUltimoCbte(token, sign, cuitNum, pv, 11, wsfe)) + 1 : 0;

      const resultados = [];
      const pdfs = []; // { nombre, bytes }

      for (const [orderId, orden] of Object.entries(ordenes)) {
        // Aplicar mapeo de productos
        if (product_map) {
          for (const item of orden.items) {
            if (product_map[item.nombre_original]) item.nombre = product_map[item.nombre_original];
          }
        }

        let result, letra, tipoCbte, cbteNro;

        if (isMonotributo) {
          result = await facturar(token, sign, cuitNum, pv, cbteC, orden, 11, wsfe, true, fechaImputacion);
          letra = "C"; tipoCbte = 11; cbteNro = cbteC;
        } else {
          const tieneCuit = orden.doc_tipo === "CUIT";
          if (tieneCuit) {
            result = await facturar(token, sign, cuitNum, pv, cbteA, orden, 1, wsfe, false, fechaImputacion);
            if (result.cae) { letra = "A"; tipoCbte = 1; cbteNro = cbteA; }
            else {
              // Fallback a B
              result = await facturar(token, sign, cuitNum, pv, cbteB, orden, 6, wsfe, false, fechaImputacion);
              letra = "B"; tipoCbte = 6; cbteNro = cbteB;
            }
          } else {
            result = await facturar(token, sign, cuitNum, pv, cbteB, orden, 6, wsfe, false, fechaImputacion);
            letra = "B"; tipoCbte = 6; cbteNro = cbteB;
          }
        }

        if (result.cae) {
          // Generar PDF
          const fechaIso = new Date().toISOString().slice(0, 10);
          const factData = {
            comprobante: cbteNro, cae: result.cae, cae_vto: result.cae_vto,
            fecha: new Date().toLocaleDateString("es-AR"),
            fecha_iso: fechaIso,
            cliente: orden.nombre || "Consumidor Final",
            doc_tipo: orden.doc_tipo, doc_nro: orden.doc_nro || "",
            letra, tipo_cbte: tipoCbte,
            domicilio: cleanAddr([orden.direccion, orden.ciudad, orden.provincia]),
            total: orden.total, items: orden.items,
          };
          const pdfBytes = await generarPDF(factData, cfg);
          const nombreCliente = (orden.nombre || "Consumidor_Final").replace(/[^a-zA-Z0-9 \-_]/g, "").trim();
          pdfs.push({ nombre: `F${letra} - ${nombreCliente} - ${String(cbteNro).padStart(8, "0")}.pdf`, bytes: Buffer.from(pdfBytes).toString("base64") });

          // ── Auto-adjuntar factura a venta de ML ─────────────
          // 1) Consultamos pack_id real de la orden (a veces es distinto al order_id)
          // 2) Subimos PDF al endpoint /packs/{pack_id}/fiscal_documents
          let ml_uploaded = false, ml_upload_error = null;
          if (orderId.startsWith("ML-")) {
            try {
              const ml = await getValidMLToken(db, uid);
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

              const upRes = await fetch(`https://api.mercadolibre.com/packs/${packId}/fiscal_documents`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${ml.accessToken}`,
                  "Content-Type": `multipart/form-data; boundary=${boundary}`,
                  "Content-Length": String(body.length),
                },
                body,
              });

              if (upRes.ok) {
                ml_uploaded = true;
              } else {
                const txt = await upRes.text().catch(() => "");
                ml_upload_error = `HTTP ${upRes.status}: ${txt.slice(0, 220)}`;
                console.error(`[ml-upload] ${orderId} pack=${packId}:`, ml_upload_error);
              }
            } catch (e) {
              ml_upload_error = e.message;
              console.error(`[ml-upload] ${orderId} error:`, e.message);
            }
          }

          resultados.push({ orden_id: orderId, ok: true, letra, comprobante: cbteNro, cae: result.cae, cae_vto: result.cae_vto, total: orden.total, ml_uploaded, ml_upload_error });

          // Persistir comprobante en Firestore para el dashboard
          try {
            const neto = isMonotributo ? orden.total : Math.round((orden.total / 1.21) * 100) / 100;
            const iva = isMonotributo ? 0 : Math.round((orden.total - neto) * 100) / 100;
            await db.collection("users").doc(uid).collection("arca_comprobantes")
              .doc(`${cuitEmit}_${tipoCbte}_${String(cbteNro).padStart(8, "0")}`).set({
                cuit_emisor: cuitEmit,
                tipo_cbte: tipoCbte,
                letra,
                nro: cbteNro,
                punto_venta: pv,
                fecha_str: factData.fecha,
                emitido_at: new Date().toISOString(),
                cae: result.cae,
                cae_vto: result.cae_vto,
                cliente: orden.nombre || "Consumidor Final",
                doc_tipo: orden.doc_tipo,
                doc_nro: orden.doc_nro || "",
                total: orden.total,
                neto,
                iva,
                orden_id: orderId,
                // Items reales para re-imprimir el PDF con el detalle correcto
                items: (orden.items || []).map(it => ({
                  nombre: it.nombre || it.nombre_original || "Producto",
                  cantidad: parseInt(it.cantidad) || 1,
                  precio: parseFloat(it.precio) || 0,
                  descuento_item: parseFloat(it.descuento_item) || 0,
                })),
                domicilio: cleanAddr([orden.direccion, orden.ciudad, orden.provincia]),
                ml_uploaded: ml_uploaded || false,
                ml_uploaded_at: ml_uploaded ? new Date().toISOString() : null,
              });
          } catch (e) {
            console.error("[arca] no se pudo guardar comprobante:", e.message);
          }

          if (letra === "A") cbteA++;
          else if (letra === "C") cbteC++;
          else cbteB++;
        } else {
          resultados.push({ orden_id: orderId, ok: false, obs: result.obs, total: orden.total });
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
            comprobante_ids: exitosos.map(r => `${cuitEmit}_${r.tipo_cbte || (isMonotributo ? 11 : (r.letra === "A" ? 1 : 6))}_${String(r.comprobante).padStart(8, "0")}`),
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

      return res.json({ ok: true, resultados, pdfs });
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

      const ml = await getValidMLToken(db, uid);
      if (!ml?.accessToken) return res.status(400).json({ error: "No hay cuenta ML conectada o el token expiró" });

      const snap = await db.collection("users").doc(uid).collection("arca_comprobantes")
        .where("cuit_emisor", "==", cuitParam).get();

      const pending = snap.docs
        .map(d => ({ ref: d.ref, ...d.data() }))
        .filter(c => c.orden_id?.startsWith("ML-") && !c.ml_uploaded);

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
            fecha: c.fecha_str, fecha_iso: c.emitido_at?.slice(0, 10),
            cliente: c.cliente || "Consumidor Final",
            doc_tipo: c.doc_tipo, doc_nro: c.doc_nro || "",
            letra: c.letra, tipo_cbte: c.tipo_cbte,
            domicilio: c.domicilio || "",
            total: c.total,
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

          const upRes = await fetch(`https://api.mercadolibre.com/packs/${packId}/fiscal_documents`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${ml.accessToken}`,
              "Content-Type": `multipart/form-data; boundary=${boundary}`,
              "Content-Length": String(reqBody.length),
            },
            body: reqBody,
          });

          if (upRes.ok) {
            await c.ref.set({ ml_uploaded: true, ml_uploaded_at: new Date().toISOString() }, { merge: true });
            uploaded++;
          } else {
            const txt = await upRes.text().catch(() => "");
            errors.push({ orden_id: c.orden_id, error: `HTTP ${upRes.status}: ${txt.slice(0, 180)}` });
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

      const comprobantes = snap.docs.map(d => d.data())
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
        current.comprobante_ids.push(`${c.cuit_emisor}_${c.tipo_cbte}_${String(c.nro).padStart(8, "0")}`);
        current.resumen.push({
          orden_id: c.orden_id || ("N° " + c.nro),
          letra: c.letra,
          comprobante: c.nro,
          cae: c.cae,
          total: c.total || 0,
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
          fecha_iso: c.emitido_at?.slice(0, 10),
          cliente: c.cliente || "Consumidor Final",
          doc_tipo: c.doc_tipo,
          doc_nro: c.doc_nro || "",
          letra: c.letra,
          tipo_cbte: c.tipo_cbte,
          domicilio: c.domicilio || "",
          total: c.total,
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

      // Rango de fechas
      let sinceDate, untilDate;
      if (req.query.since) {
        sinceDate = String(req.query.since).slice(0, 10);
        untilDate = req.query.until ? String(req.query.until).slice(0, 10) : new Date().toISOString().slice(0, 10);
      } else {
        const days = Math.min(parseInt(req.query.days) || 7, 365);
        sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        untilDate = new Date().toISOString().slice(0, 10);
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
        if (data.orden_id) billedMap.set(data.orden_id, { letra: data.letra, nro: data.nro, emitido_at: data.emitido_at });
      }

      const connections = [];
      const ordenes = {};

      // ─── Tienda Nube ───
      const tnStore = stores.find(s => s.type === "tiendanube");
      if (tnStore?.accessToken && tnStore?.storeId) {
        connections.push({ platform: "tiendanube", name: tnStore.storeName || "Tienda Nube", connected: true });
        const headers = {
          "Authentication": `bearer ${tnStore.accessToken}`,
          "User-Agent": "GrowithApp (soluna.biolight@gmail.com)",
        };
        const allTN = [];
        for (let page = 1; page <= 5; page++) {
          let tnUrl = `https://api.tiendanube.com/v1/${tnStore.storeId}/orders?per_page=200&page=${page}&payment_status=paid&created_at_min=${sinceDate}&created_at_max=${untilDate}T23:59:59`;
          const tnRes = await fetch(tnUrl, { headers });
          if (!tnRes.ok) break;
          const batch = await tnRes.json();
          if (!Array.isArray(batch) || batch.length === 0) break;
          allTN.push(...batch);
          if (batch.length < 200) break;
        }
        for (const o of allTN) {
          const orderId = "TN-" + String(o.number || o.id);
          if ((o.status || "").toLowerCase() === "cancelled") continue;
          // Filtros estrictos de pago: solo pagadas, sin devoluciones
          const pStatus = (o.payment_status || "").toLowerCase();
          if (pStatus !== "paid") continue;
          const docRaw = extractTNDoc(o);
          const clas = clasificarDoc(docRaw);
          const customerName = `${o.customer?.first_name || ""} ${o.customer?.last_name || ""}`.trim()
            || o.customer?.name || o.contact_name || "";
          const billed = billedMap.get(orderId);
          ordenes[orderId] = {
            _platform: "tiendanube",
            _platform_label: "TN",
            _order_number: String(o.number || o.id),
            _billed: !!billed,
            _billed_info: billed || null,
            nombre: customerName,
            email: o.customer?.email || o.contact_email || "",
            dni: docRaw, ...clas,
            total: parseFloat(o.total) || 0,
            subtotal: parseFloat(o.subtotal) || 0,
            descuento: parseFloat(o.discount) || 0,
            envio: parseFloat(o.shipping_cost_customer) || 0,
            estado_pago: "paid",
            fecha: o.paid_at || o.created_at || "",
            ciudad: o.shipping_address?.city || o.billing_city || "",
            provincia: o.shipping_address?.province || o.billing_province || "",
            direccion: o.shipping_address?.address || "",
            metodo_pago: o.payment_details?.method || "Pagado",
            items: (o.products || []).map(p => ({
              nombre: p.name || "Producto",
              nombre_original: p.name || "Producto",
              cantidad: parseInt(p.quantity) || 1,
              precio: parseFloat(p.price) || 0,
              descuento_item: 0,
            })),
          };
        }
      }

      // ─── Shopify ───
      const shStore = stores.find(s => s.type === "shopify");
      if (shStore?.accessToken && shStore?.shop) {
        connections.push({ platform: "shopify", name: shStore.storeName || shStore.shop, connected: true });
        const allSH = [];
        // Shopify usa cursor pagination con Link header — para simplificar usamos page_info implícito vía date filters
        let pageInfoUrl = `https://${shStore.shop}/admin/api/2024-10/orders.json?status=any&financial_status=paid&limit=250&created_at_min=${sinceDate}T00:00:00&created_at_max=${untilDate}T23:59:59`;
        for (let i = 0; i < 4; i++) {
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
        for (const o of allSH) {
          const orderId = "SH-" + (o.name || String(o.order_number || o.id));
          if (o.cancelled_at) continue;
          // Filtros estrictos: solo pagadas (no pending, refunded, voided)
          if ((o.financial_status || "").toLowerCase() !== "paid") continue;
          // Shopify: extrae DNI/CUIT del campo "Empresa" (renombrado a "DNI o CUIT") o nota.
          // Si es CUIT válido de 11 dígitos → Factura A. Si es DNI (7-8 dígitos) → Factura B.
          const docRaw = extractShopifyDoc(o);
          const clas = clasificarDoc(docRaw);
          const customerName = `${o.customer?.first_name || ""} ${o.customer?.last_name || ""}`.trim()
            || o.billing_address?.name || o.shipping_address?.name || "";
          const billed = billedMap.get(orderId);
          ordenes[orderId] = {
            _platform: "shopify",
            _platform_label: "SH",
            _order_number: o.name || String(o.order_number || o.id),
            _billed: !!billed,
            _billed_info: billed || null,
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
            direccion: o.billing_address?.address1 || o.shipping_address?.address1 || "",
            metodo_pago: o.payment_gateway_names?.join(", ") || "Pagado",
            items: (o.line_items || []).map(li => ({
              nombre: li.title || "Producto",
              nombre_original: li.title || "Producto",
              cantidad: parseInt(li.quantity) || 1,
              precio: parseFloat(li.price) || 0,
              descuento_item: 0,
            })),
          };
        }
      }

      // ─── Mercado Libre ───
      const mlStore = stores.find(s => s.type === "mercadolibre");
      if (mlStore?.userId) {
        connections.push({ platform: "mercadolibre", name: mlStore.nickname || `ML #${mlStore.userId}`, connected: true });
        try {
          const { accessToken, userId } = await getValidMLToken(db, uid) || {};
          if (accessToken) {
            const allML = [];
            for (let offset = 0; offset < 500; offset += 50) {
              const url = `https://api.mercadolibre.com/orders/search?seller=${userId}&order.status=paid&order.date_created.from=${sinceDate}T00:00:00.000-00:00&order.date_created.to=${untilDate}T23:59:59.999-00:00&limit=50&offset=${offset}&sort=date_desc`;
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
            const CHUNK = 5;
            for (let i = 0; i < mlPaid.length; i += CHUNK) {
              const chunk = mlPaid.slice(i, i + CHUNK);
              await Promise.all(chunk.map(async (o) => {
                try {
                  const r = await fetch(`https://api.mercadolibre.com/orders/${o.id}/billing_info`, {
                    headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "GrowithApp (soluna.biolight@gmail.com)" },
                  });
                  if (r.ok) {
                    const data = await r.json();
                    // Probar varios paths que ML usa según versión del endpoint
                    billingByOrderId[o.id] = data.buyer?.billing_info || data.billing_info || (data.doc_number ? data : null);
                    billingOk++;
                  } else {
                    billingErr++;
                    if (billingErr <= 3) {
                      const txt = await r.text().catch(() => "");
                      console.error(`[ml-billing] ${o.id} status=${r.status}: ${txt.slice(0, 200)}`);
                    }
                  }
                } catch (e) {
                  billingErr++;
                  if (billingErr <= 3) console.error(`[ml-billing] ${o.id} error: ${e.message}`);
                }
              }));
            }
            if (billingErr > 0) console.warn(`[ml-billing] ${billingErr}/${mlPaid.length} fallaron (ok=${billingOk})`);

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
              const billed = billedMap.get(orderId);

              ordenes[orderId] = {
                _platform: "mercadolibre",
                _platform_label: "ML",
                _order_number: String(o.id),
                _billed: !!billed,
                _billed_info: billed || null,
                nombre: customerName,
                email: buyer.email || "",
                dni: docRaw, ...clas,
                total: parseFloat(o.total_amount) || 0,
                subtotal: parseFloat(o.total_amount) || 0,
                descuento: 0,
                envio: parseFloat(o.shipping?.cost) || 0,
                estado_pago: "paid",
                fecha: o.date_closed || o.date_created || "",
                ciudad: shipAddr.city?.name || "",
                provincia: shipAddr.state?.name || "",
                direccion: [shipAddr.street_name, shipAddr.street_number].filter(Boolean).join(" "),
                metodo_pago: "Mercado Pago",
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
      }

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

      return res.json({
        connections,
        total_pending: Object.keys(ordenadas).length,
        ordenes: ordenadas,
      });
    }

    // ── TN: traer órdenes pendientes de facturar (legacy, mantener compat) ──

    if (action === "tn_pending_orders" && req.method === "GET") {
      const cuitParam = String(req.query.cuit || "").replace(/\D/g, "");
      if (!cuitParam) return res.status(400).json({ error: "Falta cuit" });

      // Rango de fechas: usa `since` y `until` si vienen, sino calcula desde `days`
      let sinceDate, untilDate;
      if (req.query.since) {
        sinceDate = String(req.query.since).slice(0, 10);
        untilDate = req.query.until ? String(req.query.until).slice(0, 10) : new Date().toISOString().slice(0, 10);
      } else {
        const days = Math.min(parseInt(req.query.days) || 7, 365);
        sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        untilDate = null;
      }

      // 1) Leer la store TN del user
      const userSnap = await db.collection("users").doc(uid).get();
      if (!userSnap.exists) return res.json({ connected: false });
      const tnStore = (userSnap.data().stores || []).find(s => s.type === "tiendanube");
      if (!tnStore?.accessToken || !tnStore?.storeId) return res.json({ connected: false });

      // 2) Traer órdenes pagas del período seleccionado
      const headers = {
        "Authentication": `bearer ${tnStore.accessToken}`,
        "User-Agent": "GrowithApp (soluna.biolight@gmail.com)",
      };
      const allOrders = [];
      for (let page = 1; page <= 5; page++) {
        let tnUrl = `https://api.tiendanube.com/v1/${tnStore.storeId}/orders?per_page=200&page=${page}&payment_status=paid&created_at_min=${sinceDate}`;
        if (untilDate) tnUrl += `&created_at_max=${untilDate}T23:59:59`;
        const tnRes = await fetch(tnUrl, { headers });
        if (!tnRes.ok) break;
        const batch = await tnRes.json();
        if (!Array.isArray(batch) || batch.length === 0) break;
        allOrders.push(...batch);
        if (batch.length < 200) break;
      }

      // 3) Filtrar las que ya están facturadas (cruzando con arca_comprobantes)
      const billedSnap = await db.collection("users").doc(uid).collection("arca_comprobantes")
        .where("cuit_emisor", "==", cuitParam).get();
      const billedIds = new Set(billedSnap.docs.map(d => d.data().orden_id).filter(Boolean));

      // 4) Normalizar al schema interno
      const ordenes = {};
      for (const o of allOrders) {
        const orderId = String(o.number || o.id);
        if (billedIds.has(orderId)) continue;
        // Skip canceladas
        if ((o.status || "").toLowerCase() === "cancelled") continue;

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
          direccion: o.shipping_address?.address || "",
          metodo_pago: o.payment_details?.method || (o.payment_status === "paid" ? "Pagado" : ""),
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
      // Inicio del mes en hora Argentina
      const argFmtD = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit" });
      const partsD = argFmtD.formatToParts(new Date());
      const argYearD = partsD.find(p => p.type === "year").value;
      const argMonthD = partsD.find(p => p.type === "month").value;
      const monthStart = `${argYearD}-${argMonthD}-01T03:00:00.000Z`;
      // Firestore "where in" limita a 30 valores — batchea si es necesario
      const dup = [];
      for (let i = 0; i < order_ids.length; i += 30) {
        const chunk = order_ids.slice(i, i + 30);
        const snap = await db.collection("users").doc(uid).collection("arca_comprobantes")
          .where("cuit_emisor", "==", cuitParam)
          .where("emitido_at", ">=", monthStart)
          .where("orden_id", "in", chunk)
          .get();
        snap.docs.forEach(d => dup.push({
          orden_id: d.data().orden_id,
          letra: d.data().letra,
          nro: d.data().nro,
          total: d.data().total,
        }));
      }
      return res.json({ duplicates: dup });
    }

    return res.status(404).json({ error: `Acción desconocida: ${action}` });

  } catch (e) {
    console.error("[arca]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
