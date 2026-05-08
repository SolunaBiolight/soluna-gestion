// api/process-sku.js
// Escritura inteligente de SKUs en etiquetas Andreani.
// 
// Mediciones reales sobre PDF 196x298pt:
//   QR inferior: top=256.1, height=16.4 → ocupa y_from_bot 25.6..41.9
//   Texto "N° seguimiento" inferior: top=261.6 → y_from_bot=30.2
//   Texto IMPORTANTE (ultima linea): top=246.8 → y_from_bot=47.1
//   Margen inferior (bajo QR): y_from_bot 0..25.6 (25.6pt disponibles)
//
// Estrategia: escribir en el margen inferior (bajo los QR), escalando el
// font size automaticamente para que quepan todos los SKUs sin superponerse.
// Verificacion: si algun SKU no entra, escalar font o usar mas columnas.

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

// Calcula el layout optimo para N skus en una zona de W x H puntos
// Devuelve { fontSize, cols, rows, fits, lh }
function calcLayout(skuLines, zoneW, zoneH, maxFontSize = 6.5, minFontSize = 3.5) {
  const MAX_COLS = 3;

  for (let cols = 1; cols <= MAX_COLS; cols++) {
    const colW = zoneW / cols;

    for (let fs = maxFontSize; fs >= minFontSize; fs -= 0.25) {
      const lh = fs + 1.5;
      const rowsPerCol = Math.floor(zoneH / lh);
      const totalSlots = rowsPerCol * cols;
      const charWidth = fs * 0.62; // estimacion ancho caracter HelveticaBold

      // Verificar que cada linea entra en el ancho de columna
      const maxChars = Math.floor(colW / charWidth);
      const allFit = skuLines.every(l => l.length <= maxChars);

      if (allFit && totalSlots >= skuLines.length) {
        return { fontSize: fs, cols, rowsPerCol, fits: true, lh, colW };
      }
    }
  }

  // Fallback: fuente minima, maximas columnas
  const fs = minFontSize;
  const lh = fs + 1.5;
  const rowsPerCol = Math.max(1, Math.floor(zoneH / lh));
  const colW = zoneW / MAX_COLS;
  return { fontSize: fs, cols: MAX_COLS, rowsPerCol, fits: false, lh, colW };
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
    let cfg = { sortBy: 'sin', pageOrder: null };

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

    // Constantes medidas en PDF real Andreani 196x298pt
    // Zona de escritura: margen inferior, debajo de los QR codes
    // QR inferior: y_from_bot=25.6..41.9 → escribimos debajo en y_from_bot=0..24
    const ZONE_Y_START = 1.5;   // pt desde abajo — base de la primera linea
    const ZONE_HEIGHT = 23;     // pt disponibles (debajo del QR inferior)
    const ZONE_X_START = 9.7;   // margen izquierdo
    const ZONE_X_END_RATIO = 0.97; // usar hasta el 97% del ancho

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

      // Escalar coordenadas al tamaño real de la página
      const sx = W / 196;
      const sy = H / 298;

      const zoneYStart = ZONE_Y_START * sy;
      const zoneH = ZONE_HEIGHT * sy;
      const zoneXStart = ZONE_X_START * sx;
      const zoneW = (W * ZONE_X_END_RATIO) - zoneXStart;

      // Calcular layout óptimo automáticamente
      const layout = calcLayout(skuLines, zoneW, zoneH);

      // Distribuir y escribir SKUs
      let lineIdx = 0;
      let allWritten = true;

      for (let col = 0; col < layout.cols && lineIdx < skuLines.length; col++) {
        const colX = zoneXStart + col * layout.colW;

        for (let row = 0; row < layout.rowsPerCol && lineIdx < skuLines.length; row++) {
          const line = skuLines[lineIdx];
          // Truncar si aun no entra (no deberia pasar con el layout correcto)
          const maxCh = Math.floor(layout.colW / (layout.fontSize * 0.62));
          const safe = line.length > maxCh ? line.slice(0, maxCh - 1) + '\u2026' : line;

          // y crece hacia arriba en pdf-lib
          // fila 0 = mas baja (zoneYStart), fila N = mas alta
          const y = zoneYStart + row * layout.lh;

          page.drawText(safe, {
            x: colX,
            y,
            size: layout.fontSize,
            font,
            color: rgb(0, 0, 0),
          });
          lineIdx++;
        }
      }

      // Si no entraron todos, marcar para el reporte
      if (lineIdx < skuLines.length) allWritten = false;

      pageResults.push({
        pageIdx: i, pageNum, pedido: pedidoNum, hasSkus: true, skus: skuLines,
        layout: { cols: layout.cols, fontSize: Math.round(layout.fontSize * 10) / 10, fits: layout.fits },
        allWritten,
        skusMissed: allWritten ? 0 : skuLines.length - lineIdx,
      });
    }

    // Reordenar páginas si aplica
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

    // Página de resumen
    const skuTotals = {};
    const warnings = [];
    pageResults.filter(r => r.hasSkus).forEach(r => {
      if (!r.allWritten) {
        warnings.push(`Pág. ${r.pageNum} (Pedido #${r.pedido}): ${r.skusMissed} SKU(s) no escritos`);
      }
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
      sp.drawText(`Fecha: ${now}  |  ${pages.length} páginas  |  ${pageResults.filter(r=>r.hasSkus).length} procesadas`, { x: 50, y: sh-80, size: 9, font: bf, color: rgb(0.3,0.3,0.3) });

      // Advertencias si hubo SKUs que no entraron
      if (warnings.length > 0) {
        sp.drawText('⚠ ADVERTENCIAS:', { x: 50, y: sh-105, size: 11, font: tf, color: rgb(0.8,0.2,0.2) });
        let wy = sh-122;
        warnings.forEach(w => {
          sp.drawText(w, { x: 60, y: wy, size: 9, font: bf, color: rgb(0.8,0.2,0.2) });
          wy -= 14;
        });
      }

      sp.drawText('DETALLE:', { x: 50, y: sh-130 - (warnings.length * 14), size: 12, font: tf, color: rgb(0,0,0) });
      let ly = sh - 150 - (warnings.length * 14);
      const sorted = Object.entries(skuTotals).sort((a,b) => a[0].localeCompare(b[0]));
      for (const [sku, qty] of sorted) {
        sp.drawText(`${sku}  →  ${qty} u`, { x: 60, y: ly, size: 10, font: bf, color: rgb(0,0,0) });
        ly -= 18;
        if (ly < 60) break;
      }
    }

    const pdfBytes = await finalDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rotulos-con-sku-${Date.now()}.pdf"`);

    // Header con resultados para la app
    const resultsHeader = pageResults.map(r => ({
      page: r.pageNum,
      pedido: r.pedido,
      status: r.hasSkus ? 'ok' : 'sin_sku',
      fits: r.layout?.fits !== false,
      allWritten: r.allWritten !== false,
      skusMissed: r.skusMissed || 0,
    }));
    res.setHeader('X-Results', JSON.stringify(resultsHeader));

    res.send(Buffer.from(pdfBytes));

  } catch (e) {
    console.error('[process-sku]', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
}
