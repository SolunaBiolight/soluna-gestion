// api/process-sku.js
// Zona medida del PDF real Andreani (196x298pt):
//
// La UNICA zona libre entre los dos QR codes inferiores:
//   - QR izq: x=9.7-26.1,  y_from_bot=25.6-41.9
//   - QR der: x=169.7-186, y_from_bot=25.6-41.9
//   - Texto N° seguimiento: x=44.7-151.3, y_from_bot=30.2-37.4
//   - ZONA LIBRE: x=26..170, y_from_bot=0..25 (debajo de los QR)
//     pero ahi esta "vacio" - es el margen inferior
//
// Mirando las fotos del cliente: los SKU van en el espacio
// entre los dos QR codes a la altura de ellos:
//   x=26..169, y_from_bot=26..42
// Ese espacio tiene el texto "N° de seguimiento" en el centro
// pero los extremos (x=26..44 y x=151..169) estan libres.
//
// En la foto correcta del cliente, los SKU aparecen
// ENTRE los QR codes a esa altura. Ancho disponible: x=26..169
// Sin el texto de seguimiento (x=44..151) quedan dos franjas:
//   Franja izq: x=26..43, y=26..42 (muy angosta, 17pt)
//   Franja der: x=152..169, y=26..42 (muy angosta, 17pt)
//   Centro sobre el texto: los SKU VAN ENCIMA del texto de seguimiento
//     pero en la foto del cliente se ve que si van ahi — el texto
//     de seguimiento es solo una referencia, los SKU van sobre el
//
// SOLUCION FINAL: colocar los SKU en la franja central
// y_from_bot=26..42, x=26..170, ENCIMA del texto de seguimiento
// (que es redundante con el QR). Si no entran en horizontal,
// usar multiples columnas.

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

export const config = { api: { bodyParser: false } };

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function splitMultipart(body, boundary) {
  const parts = [];
  const boundaryBuf = Buffer.from(boundary);
  function indexOf(buf, needle, start = 0) {
    for (let i = start; i <= buf.length - needle.length; i++) {
      let found = true;
      for (let j = 0; j < needle.length; j++) {
        if (buf[i + j] !== needle[j]) { found = false; break; }
      }
      if (found) return i;
    }
    return -1;
  }
  let start = 0;
  while (true) {
    const idx = indexOf(body, boundaryBuf, start);
    if (idx === -1) break;
    const contentStart = idx + boundaryBuf.length + 2;
    const nextIdx = indexOf(body, boundaryBuf, contentStart);
    if (nextIdx === -1) break;
    const partBuf = body.slice(contentStart, nextIdx - 2);
    const headerEnd = indexOf(partBuf, Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) { start = nextIdx; continue; }
    const headerStr = partBuf.slice(0, headerEnd).toString('utf-8');
    const data = partBuf.slice(headerEnd + 4);
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    if (nameMatch) parts.push({ name: nameMatch[1], filename: filenameMatch?.[1] || null, data });
    start = nextIdx;
  }
  return parts;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = await readBody(req);
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
    if (!boundaryMatch) return res.status(400).json({ error: 'Missing boundary' });

    const parts = splitMultipart(body, '--' + boundaryMatch[1]);
    let pdfBuffer = null, skuMapRaw = null;
    let cfg = { x: 10, y: 10, fontSize: 4, sortBy: 'sin', pageOrder: null };

    for (const part of parts) {
      if (part.name === 'pdf' && part.filename) pdfBuffer = part.data;
      if (part.name === 'skuMap') skuMapRaw = part.data.toString('utf-8');
      if (part.name === 'config') {
        try { cfg = { ...cfg, ...JSON.parse(part.data.toString('utf-8')) }; } catch(_) {}
      }
    }

    if (!pdfBuffer) return res.status(400).json({ error: 'No PDF recibido' });

    const skuMap = skuMapRaw ? JSON.parse(skuMapRaw) : {};
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const pages = pdfDoc.getPages();
    const baseFontSize = Math.max(2.5, parseFloat(cfg.fontSize) || 4);
    const pageResults = [];

    for (let i = 0; i < pages.length; i++) {
      const pageNum = i + 1;
      const page = pages[i];
      const { width: W, height: H } = page.getSize();

      const entry = Object.entries(skuMap).find(([, v]) => v.page === pageNum);
      if (!entry || !entry[1].found || !entry[1].skus || !entry[1].skus.length) {
        pageResults.push({ pageIdx: i, pageNum, pedido: entry ? entry[0] : null, hasSkus: false });
        continue;
      }

      const [pedidoNum, info] = entry;
      const skuLines = info.skus;

      // Escalar si el PDF tiene diferente tamano
      const sx = W / 196;
      const sy = H / 298;

      // ── ZONA PRINCIPAL ──────────────────────────────────────────────
      // Espacio entre los dos QR codes inferiores
      // QR izq termina en x=26, QR der empieza en x=170
      // Altura de los QR: y_from_bot=26..42
      // El texto "N° de seguimiento" esta en y=30..37 pero lo pisamos
      // porque es informacion redundante con el QR code
      //
      // Esta es la zona que el cliente muestra en su ejemplo correcto:
      // x=26..170 (144pt de ancho), y_from_bot=26..42 (16pt de alto)
      //
      // Con fontSize=4pt y lineHeight=5.5pt caben ~2 filas
      // Si hay mas SKU, agregar columnas verticales encima de esta zona
      // usando el espacio entre elementos (los gaps de ~5pt son chicos
      // pero multiples columnas pueden funcionar)

      // Zona 1: entre QR inferiores (la zona correcta del cliente)
      // y_from_bot 26..42, x=26..170
      const z1x = 26 * sx;
      const z1w = (170 - 26) * sx;  // 144pt
      const z1yBot = 26 * sy;
      const z1yTop = 42 * sy;        // 16pt altura

      // Zona 2: si no entran todos, usar columna izquierda desde z1 hacia arriba
      // Entre Rendicion (y=88-106) y barcode (y=142) hay 5.5pt libre
      // Entre barcode (y=180) y Peso/dim (y=186) hay 5.4pt
      // Vamos a usar multiples filas apiladas encima del espacio del QR
      // en el lado izquierdo (x=26..80) donde no hay texto debajo del barcode
      // Espacio izq bajo el barcode: x=26..80, y=26..140 (pero con texto entre medio)
      
      // En realidad, la mejor segunda zona es usar mas columnas en la franja
      // de los QR codes pero hacia arriba: y_from_bot=42..82 en el lado
      // izquierdo donde hay el texto "IMPORTANTE" (x=9..187, y=47..61) 
      // y "Sucursal Distribucion" (x=9..186, y=67..82) -- ocupan todo el ancho
      
      // Para mas de 2 filas: dividir la zona 1 en columnas
      // Col A: x=26..95, y=26..42 (70pt ancho)
      // Col B: x=96..170, y=26..42 (75pt ancho)
      // Y si aun sobran: col C mas arriba a la izq (x=26..95, y=42..55) 
      //   pero ahi esta el IMPORTANTE a y=47 -- riesgo
      // Mejor: reducir fontSize hasta que entren en z1

      const lh = (fs) => fs + 1.5;
      
      // Calcular fontSize optimo para que quepan en z1 con multiples columnas
      // Columnas en z1: cuantas caben?
      // Con col de 70pt y fontSize 4pt: ~70/(4*0.58) = ~30 chars, 2-3 palabras
      // Filas en z1 altura 16pt: floor(16/5.5) = 2 filas
      // Col A (70pt) * 2 filas + Col B (75pt) * 2 filas = 4 lineas totales
      
      // Si hay mas de 4 lineas: reducir font
      let fs = baseFontSize;
      
      // Calcular capacidad total con el font actual
      // Dividimos z1 en columnas de ~70pt cada una
      const colWidth = 70 * sx;
      const numCols = Math.floor(z1w / colWidth);
      const rowsPerCol = (f) => Math.max(1, Math.floor((z1yTop - z1yBot) / lh(f)));
      const totalCap = (f) => numCols * rowsPerCol(f);
      
      // Reducir fs si es necesario (max 5 intentos)
      for (let attempt = 0; attempt < 10 && totalCap(fs) < skuLines.length && fs > 2.5; attempt++) {
        fs -= 0.3;
      }
      fs = Math.max(2.5, fs);

      // Dibujar columnas en z1
      const rows = rowsPerCol(fs);
      let lineIdx = 0;
      
      for (let col = 0; col < numCols && lineIdx < skuLines.length; col++) {
        const xCol = z1x + col * colWidth;
        const maxCh = Math.max(4, Math.floor(colWidth / (fs * 0.58)));
        
        for (let row = 0; row < rows && lineIdx < skuLines.length; row++) {
          const line = skuLines[lineIdx];
          const safe = line.length > maxCh ? line.slice(0, maxCh - 1) + '\u2026' : line;
          const y = z1yBot + row * lh(fs);
          page.drawText(safe, { x: xCol, y, size: fs, font, color: rgb(0, 0, 0) });
          lineIdx++;
        }
      }

      // Si aun sobran (raro): escribir encima en zona superior izq
      // usando un font pequeño en x=26..80, y=42..47 (justo encima de los QR)
      if (lineIdx < skuLines.length) {
        const tinyFs = 2.5;
        const y2 = z1yTop + 1 * sy;
        const maxCh2 = Math.max(4, Math.floor((80 * sx) / (tinyFs * 0.58)));
        while (lineIdx < skuLines.length) {
          const line = skuLines[lineIdx];
          const safe = line.length > maxCh2 ? line.slice(0, maxCh2 - 1) + '\u2026' : line;
          page.drawText(safe, { x: z1x, y: y2 + (lineIdx - (numCols * rows)) * (tinyFs + 1), size: tinyFs, font, color: rgb(0.3, 0, 0) });
          lineIdx++;
        }
      }

      pageResults.push({ pageIdx: i, pageNum, pedido: pedidoNum, hasSkus: true, skus: skuLines });
    }

    // Reordenar paginas
    let finalDoc = pdfDoc;
    if (cfg.sortBy !== 'sin' && cfg.pageOrder && Array.isArray(cfg.pageOrder)) {
      const newDoc = await PDFDocument.create();
      const validOrder = cfg.pageOrder.filter(idx => idx >= 0 && idx < pages.length);
      const withSku = validOrder.filter(idx => pageResults.find(r => r.pageIdx === idx) && pageResults.find(r => r.pageIdx === idx).hasSkus);
      const withoutSku = validOrder.filter(idx => !withSku.includes(idx));
      for (const idx of [...withSku, ...withoutSku]) {
        const [copied] = await newDoc.copyPages(pdfDoc, [idx]);
        newDoc.addPage(copied);
      }
      finalDoc = newDoc;
    }

    // Pagina resumen
    const skuTotals = {};
    pageResults.filter(r => r.hasSkus).forEach(r => {
      r.skus.forEach(s => {
        const m = s.match(/^(.+?)\s*\(x(\d+)\)$/);
        if (m) {
          const key = m[1].trim();
          skuTotals[key] = (skuTotals[key] || 0) + (parseInt(m[2]) || 1);
        } else {
          skuTotals[s] = (skuTotals[s] || 0) + 1;
        }
      });
    });

    if (Object.keys(skuTotals).length > 0) {
      const sp = finalDoc.addPage([595, 842]);
      const { height: sh } = sp.getSize();
      const tf = await finalDoc.embedFont(StandardFonts.HelveticaBold);
      const bf = await finalDoc.embedFont(StandardFonts.Helvetica);
      const now = new Date().toLocaleString('es-AR');
      sp.drawText('RESUMEN SKU DESPACHADOS', { x: 50, y: sh-60, size: 16, font: tf, color: rgb(0,0,0) });
      sp.drawText('Fecha: ' + now + '  |  ' + pages.length + ' paginas  |  ' + pageResults.filter(r=>r.hasSkus).length + ' procesadas', { x: 50, y: sh-85, size: 10, font: bf, color: rgb(0.3,0.3,0.3) });
      sp.drawText('DETALLE:', { x: 50, y: sh-120, size: 12, font: tf, color: rgb(0,0,0) });
      let ly = sh - 145;
      const sorted = Object.entries(skuTotals).sort((a,b) => a[0].localeCompare(b[0]));
      for (const [sku, qty] of sorted) {
        sp.drawText(sku + '  ->  ' + qty + ' u', { x: 60, y: ly, size: 10, font: bf, color: rgb(0,0,0) });
        ly -= 18;
        if (ly < 60) break;
      }
    }

    const pdfBytes = await finalDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="rotulos-con-sku-' + Date.now() + '.pdf"');
    res.setHeader('X-Results', JSON.stringify(pageResults.map(r => ({ page: r.pageNum, pedido: r.pedido, status: r.hasSkus ? 'ok' : 'sin_sku' }))));
    res.send(Buffer.from(pdfBytes));

  } catch (e) {
    console.error('[process-sku]', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
}
