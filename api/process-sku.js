// api/process-sku.js
// Los SKUs van al PIE de la pagina, debajo del contenido de la etiqueta,
// como texto libre. Segun el PDF correcto del cliente:
//   - y_from_bot = 8.8pt para el texto del SKU
//   - x = 9.7pt (margen izquierdo)
//   - Si hay multiples SKUs apilan hacia arriba (lineHeight ~6pt)
//   - Si no entran en una columna, abren columna a la derecha

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
    let cfg = { fontSize: 5, sortBy: 'sin', pageOrder: null };

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

    // Segun el PDF correcto:
    // - Pagina: 196x298pt
    // - SKU mas bajo: y_from_bot = 8.8pt, x = 9.7pt
    // - Cada linea adicional va 5.5pt mas arriba
    // - Si no entran en una columna (limite: no pasar los QR inferiores en y=26pt),
    //   abrir nueva columna a la derecha con x += colWidth
    const BASE_FONT = Math.max(3, parseFloat(cfg.fontSize) || 5);
    const MARGIN_X = 9.7;   // margen izquierdo (igual que el resto del texto)
    const START_Y = 9;       // y desde abajo para la primera linea
    const QR_Y = 26;         // los QR inferiores llegan hasta y=26 desde abajo
    const COL_WIDTH = 62;    // ancho de cada columna (~1/3 del ancho util)

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

      // Escalar si la pagina tiene diferente tamano
      const sx = W / 196;
      const sy = H / 298;

      const startY = START_Y * sy;
      const qrY = QR_Y * sy;
      const marginX = MARGIN_X * sx;
      const colWidth = COL_WIDTH * sx;
      const fs = BASE_FONT;
      const lh = fs + 1.5;

      // Calcular cuantas lineas caben en una columna
      // desde startY hasta qrY (sin pisar los QR)
      const maxRowsPerCol = Math.max(1, Math.floor((qrY - startY) / lh));

      // Distribuir en columnas
      let lineIdx = 0;
      let col = 0;
      const maxCols = Math.floor((W - marginX) / colWidth);

      while (lineIdx < skuLines.length && col < maxCols) {
        const colX = marginX + col * colWidth;
        const maxCh = Math.max(4, Math.floor(colWidth / (fs * 0.58)));

        for (let row = 0; row < maxRowsPerCol && lineIdx < skuLines.length; row++) {
          const line = skuLines[lineIdx];
          const safe = line.length > maxCh ? line.slice(0, maxCh - 1) + '\u2026' : line;
          // y aumenta hacia arriba en pdf-lib (y=0 es abajo)
          const y = startY + row * lh;
          page.drawText(safe, { x: colX, y, size: fs, font, color: rgb(0, 0, 0) });
          lineIdx++;
        }
        col++;
      }

      pageResults.push({ pageIdx: i, pageNum, pedido: pedidoNum, hasSkus: true, skus: skuLines });
    }

    // Reordenar paginas
    let finalDoc = pdfDoc;
    if (cfg.sortBy !== 'sin' && cfg.pageOrder && Array.isArray(cfg.pageOrder)) {
      const newDoc = await PDFDocument.create();
      const validOrder = cfg.pageOrder.filter(idx => idx >= 0 && idx < pages.length);
      const withSku = validOrder.filter(idx => {
        const r = pageResults.find(r => r.pageIdx === idx);
        return r && r.hasSkus;
      });
      const withoutSku = validOrder.filter(idx => !withSku.includes(idx));
      for (const idx of [...withSku, ...withoutSku]) {
        const [copied] = await newDoc.copyPages(pdfDoc, [idx]);
        newDoc.addPage(copied);
      }
      finalDoc = newDoc;
    }

    // Pagina de resumen
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
    res.setHeader('X-Results', JSON.stringify(pageResults.map(r => ({
      page: r.pageNum, pedido: r.pedido, status: r.hasSkus ? 'ok' : 'sin_sku'
    }))));
    res.send(Buffer.from(pdfBytes));

  } catch (e) {
    console.error('[process-sku]', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
}
