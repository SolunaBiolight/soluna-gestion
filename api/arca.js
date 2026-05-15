// api/arca.js
// ARCA (ex-AFIP) — Facturación electrónica para Growith
// Soporta: parseo XLSX de ML / CSV de Shopify, emisión WSAA+WSFE, generación PDF, descarga ZIP
//
// Dependencias npm: node-forge (firma CMS), xlsx (parseo), pdf-lib (PDF), jszip (ZIP)
// Instalá: npm install node-forge xlsx pdf-lib jszip

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { XMLParser } from "fast-xml-parser";

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

  const r = await fetch(wsaaUrl, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" },
    body: soap,
  });
  const text = await r.text();

  // Extraer token y sign del XML (puede venir con HTTP 200 o 500 si es fault)
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
    const r = await fetch(wsfeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: `http://ar.gov.afip.dif.FEV1/${action}`,
      },
      body: soap,
    });
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

async function facturar(token, sign, cuitNum, puntoVenta, cbteNro, orden, tipoCbte, wsfeUrl, monotributo = false) {
  const total = orden.total;
  const fecha = new Date().toISOString().slice(0, 10).replace(/-/g, "");

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

async function parsearCSV(buffer) {
  const text = buffer.toString("utf-8");
  const lines = text.split("\n");
  const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
  const ordenes = {};
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const vals = line.split(",").map(v => v.trim().replace(/^"|"$/g, ""));
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

// ─── Generación PDF con pdf-lib ────────────────────────

async function generarPDF(factData, config) {
  const { PDFDocument, rgb, StandardFonts } = await import("pdf-lib");

  const pdfDoc = await PDFDocument.create();
  const fontB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontR = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const { cuit, razon_social, nombre_fantasia, domicilio, punto_venta, condicion_fiscal } = config;
  const isMonotributo = condicion_fiscal === "MONOTRIBUTO";
  const letra = factData.letra;
  const total = factData.total;
  const neto = isMonotributo ? total : Math.round((total / 1.21) * 100) / 100;
  const iva21 = isMonotributo ? 0 : Math.round((total - neto) * 100) / 100;

  const drawPage = async (copyLabel) => {
    const page = pdfDoc.addPage([595, 842]);
    const { width: W, height: H } = page.getSize();
    const MX = 28, MY = 28;
    const UW = W - MX * 2;
    const MID = MX + UW / 2;

    const draw = (text, x, y, size, bold = false, align = "left") => {
      const font = bold ? fontB : fontR;
      const tw = font.widthOfTextAtSize(String(text), size);
      let rx = x;
      if (align === "center") rx = x - tw / 2;
      else if (align === "right") rx = x - tw;
      page.drawText(String(text), { x: rx, y: H - y, size, font, color: rgb(0, 0, 0) });
    };
    const rect = (x, y, w, h) => page.drawRectangle({ x, y: H - y - h, width: w, height: h, borderColor: rgb(0, 0, 0), borderWidth: 0.5, color: rgb(1, 1, 1) });
    const line = (x1, y1, x2, y2) => page.drawLine({ start: { x: x1, y: H - y1 }, end: { x: x2, y: H - y2 }, thickness: 0.5, color: rgb(0, 0, 0) });

    // COPIA
    draw(copyLabel, W / 2, 20, 9, true, "center");

    // Recuadro encabezado
    rect(MX, 25, UW / 2 - 15, 55);
    rect(MID + 15, 25, UW / 2 - 15, 55);
    rect(MID - 12, 25, 24, 24);

    // Letra grande
    draw(letra, MID, 44, 22, true, "center");
    draw(letra === "A" ? "COD. 01" : letra === "B" ? "COD. 06" : "COD. 11", MID, 50, 6, false, "center");

    // Emisor (izquierda)
    draw(nombre_fantasia || razon_social, MX + 4, 31, 10, true);
    draw(`Razón Social: ${razon_social}`, MX + 4, 41, 7);
    draw(`Domicilio: ${domicilio}`, MX + 4, 49, 7);
    draw(`Condición IVA: ${isMonotributo ? "Monotributista" : "IVA Responsable Inscripto"}`, MX + 4, 57, 7);

    // Factura (derecha)
    draw("FACTURA", W - MX - 4, 31, 13, true, "right");
    draw(`Pto. Venta: ${String(punto_venta).padStart(5, "0")}  Comp. Nro: ${String(factData.comprobante).padStart(8, "0")}`, MID + 18, 40, 7);
    draw(`Fecha de Emisión: ${factData.fecha}`, MID + 18, 48, 7);
    draw(`CUIT: ${cuit}`, MID + 18, 56, 7);
    draw(`Fecha Inicio Actividades: ${config.fecha_inicio || "01/01/2024"}`, MID + 18, 64, 7);

    // Receptor
    const ry = 84;
    rect(MX, ry, UW, 26);
    const docTipo = factData.doc_tipo;
    const docNro = factData.doc_nro || "";
    const condIVA = docTipo === "CUIT" ? "IVA Responsable Inscripto" : "Consumidor Final";
    const docLabel = docTipo === "CUIT" ? "CUIT" : docTipo === "DNI" ? "DNI" : "";
    if (docLabel && docNro) {
      draw(`${docLabel}: ${docNro}`, MX + 4, ry + 7, 8, true);
      draw(`Apellido/Razón Social: ${factData.cliente}`, MID + 4, ry + 7, 7);
    } else {
      draw("Consumidor Final", MX + 4, ry + 7, 8, true);
    }
    draw(`Condición IVA: ${condIVA}`, MX + 4, ry + 15, 7);
    draw(`Domicilio: ${factData.domicilio || ""}`, MID + 4, ry + 15, 7);
    draw("Condición de venta: Contado", MX + 4, ry + 23, 7);

    // Tabla items
    const ty = 115;
    const cols = [15, 60, 22, 22, 28, 15, 22, 16];
    const headers = ["Cód", "Producto / Servicio", "Cantidad", "Unidad", "Precio Unit.", "Bonif%", "Subtotal", "IVA"];
    rect(MX, ty, UW, 9);
    let cx = MX;
    for (let i = 0; i < cols.length; i++) {
      page.drawRectangle({ x: cx, y: H - ty - 9, width: cols[i], height: 9, color: rgb(0.9, 0.9, 0.9), borderColor: rgb(0, 0, 0), borderWidth: 0.3 });
      draw(headers[i], cx + 2, ty + 7, 6, true);
      cx += cols[i];
    }
    let iy = ty + 9;
    for (const item of (factData.items || [])) {
      const precioNeto = isMonotributo ? item.precio : Math.round((item.precio / 1.21) * 100) / 100;
      const subtotalNeto = Math.round(item.cantidad * precioNeto * 100) / 100;
      const bonif = item.descuento_item > 0 ? Math.round((item.descuento_item / (item.cantidad * item.precio)) * 10000) / 100 : 0;
      let cx2 = MX;
      const cellData = ["", item.nombre.slice(0, 40), String(item.cantidad), "unidades", precioNeto.toFixed(2), bonif > 0 ? bonif.toFixed(1) : "", subtotalNeto.toFixed(2), isMonotributo ? "—" : "21%"];
      for (let i = 0; i < cols.length; i++) {
        rect(cx2, iy, cols[i], 7);
        draw(cellData[i], i === 0 ? cx2 + 2 : i >= 4 ? cx2 + cols[i] - 2 : cx2 + 2, iy + 5.5, 6, false, i >= 4 ? "right" : "left");
        cx2 += cols[i];
      }
      iy += 7;
    }
    // Relleno si pocos items
    for (let i = factData.items.length; i < 3; i++) {
      let cx2 = MX;
      for (const c of cols) { rect(cx2, iy, c, 7); cx2 += c; }
      iy += 7;
    }

    // Totales
    const totY = iy + 6;
    rect(MX, totY, UW, 60);
    const rx2 = MID + 25, lw = 50, vw = 32;
    const totRows = [
      ["Importe Neto Gravado", neto.toFixed(2)],
      ["IVA 27%", "0,00"], ["IVA 21%", iva21.toFixed(2)],
      ["IVA 10,5%", "0,00"], ["IVA 5%", "0,00"], ["Imp. Internos", "0,00"],
    ];
    let ty2 = totY + 6;
    for (const [label, val] of totRows) {
      draw(`${label}: $`, rx2, ty2, 7, false, "right");
      draw(val, rx2 + vw, ty2, 7, false, "right");
      ty2 += 8;
    }
    draw("Importe Total: $", rx2, ty2 + 2, 8, true, "right");
    draw(total.toFixed(2), rx2 + vw, ty2 + 2, 8, true, "right");

    // CAE
    const pieY = totY + 66;
    draw(`CAE N°: ${factData.cae}`, W - MX - 4, pieY + 8, 9, true, "right");
    draw(`Fecha Vto. CAE: ${factData.cae_vto || ""}`, W - MX - 4, pieY + 18, 8, false, "right");
    draw("ARCA — AGENCIA DE RECAUDACIÓN Y CONTROL ADUANERO", MX + 4, pieY + 8, 7);
    draw("Comprobante Autorizado", MX + 4, pieY + 16, 7);
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
      const { cuit: cuitEmit, ordenes, product_map } = body;
      if (!cuitEmit || !ordenes) return res.status(400).json({ error: "Faltan cuit u ordenes" });

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
          result = await facturar(token, sign, cuitNum, pv, cbteC, orden, 11, wsfe, true);
          letra = "C"; tipoCbte = 11; cbteNro = cbteC;
        } else {
          const tieneCuit = orden.doc_tipo === "CUIT";
          if (tieneCuit) {
            result = await facturar(token, sign, cuitNum, pv, cbteA, orden, 1, wsfe, false);
            if (result.cae) { letra = "A"; tipoCbte = 1; cbteNro = cbteA; }
            else {
              // Fallback a B
              result = await facturar(token, sign, cuitNum, pv, cbteB, orden, 6, wsfe, false);
              letra = "B"; tipoCbte = 6; cbteNro = cbteB;
            }
          } else {
            result = await facturar(token, sign, cuitNum, pv, cbteB, orden, 6, wsfe, false);
            letra = "B"; tipoCbte = 6; cbteNro = cbteB;
          }
        }

        if (result.cae) {
          // Generar PDF
          const factData = {
            comprobante: cbteNro, cae: result.cae, cae_vto: result.cae_vto,
            fecha: new Date().toLocaleDateString("es-AR"),
            cliente: orden.nombre || "Consumidor Final",
            doc_tipo: orden.doc_tipo, doc_nro: orden.doc_nro || "",
            letra, tipo_cbte: tipoCbte,
            domicilio: [orden.ciudad, orden.provincia].filter(Boolean).join(", "),
            total: orden.total, items: orden.items,
          };
          const pdfBytes = await generarPDF(factData, cfg);
          const nombreCliente = (orden.nombre || "Consumidor_Final").replace(/[^a-zA-Z0-9 \-_]/g, "").trim();
          pdfs.push({ nombre: `F${letra} - ${nombreCliente} - ${String(cbteNro).padStart(8, "0")}.pdf`, bytes: Buffer.from(pdfBytes).toString("base64") });

          resultados.push({ orden_id: orderId, ok: true, letra, comprobante: cbteNro, cae: result.cae, cae_vto: result.cae_vto, total: orden.total });

          if (letra === "A") cbteA++;
          else if (letra === "C") cbteC++;
          else cbteB++;
        } else {
          resultados.push({ orden_id: orderId, ok: false, obs: result.obs, total: orden.total });
        }
      }

      return res.json({ ok: true, resultados, pdfs });
    }

    return res.status(404).json({ error: `Acción desconocida: ${action}` });

  } catch (e) {
    console.error("[arca]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
