// api/process-sku.js
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

    let pdfBuffer = null;
    let skuMapRaw = null;
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

    const fontSize = parseFloat(cfg.fontSize) || 4;
    const lineH = fontSize + 2;

    const pageResults = [];

    for (let i = 0; i < pages.length; i++) {
      const pageNum = i + 1;
      const page = pages[i];
      const { width, height } = page.getSize();

      const entry = Object.entries(skuMap).find(([, v]) => v.page === pageNum);
      if (!entry || !entry[1].found || !entry[1].skus?.length) {
        pageResults.push({ pageIdx: i, pageNum, pedido: entry?.[0], hasSkus: false });
        continue;
      }

      const [pedidoNum, info] = entry;
      const skuLines = info.skus;

      // ── Layout de la etiqueta Andreani ──────────────────────────────
      // Mirando el PDF real:
      //   - QR inferior izquierdo ocupa aprox x=0..55, y=0..55
      //   - QR inferior derecho ocupa aprox x=width-55..width, y=0..55
      //   - Entre los dos QR hay una franja central libre
      //   - Encima del QR derecho hay espacio libre (no hay texto impreso)
      //   - La zona izquierda media-baja también suele tener espacio
      //
      // Estrategia de columnas (de izquierda a derecha, de abajo hacia arriba):
      //
      //   Columna 1: entre QR izq y QR der (franja central inferior)
      //              x = 57..width-57, y = 12..52
      //              Caben pocas líneas (≈4-5 a fontSize 4pt)
      //
      //   Columna 2: encima del QR derecho (zona derecha libre)
      //              x = width-55..width-3, y = 55..height*0.35
      //              Caben muchas líneas verticalmente
      //
      //   Columna 3: encima del QR izquierdo (zona izquierda libre)
      //              x = 3..53, y = 55..height*0.35
      //
      // Si aún sobran: col 4 más arriba a la derecha, font ligeramente menor
      
      const QR = 57; // tamaño QR en puntos

      // Columna 1: franja central entre QR codes
      const col1 = { x: QR + 2, yBot: 12, yTop: QR - 4, w: width - 2*QR - 4 };
      // Columna 2: sobre QR derecho (zona derecha)
      const col2 = { x: width - QR + 2, yBot: QR + 2, yTop: height * 0.35, w: QR - 4 };
      // Columna 3: sobre QR izquierdo (zona izquierda)
      const col3 = { x: 2, yBot: QR + 2, yTop: height * 0.35, w: QR - 4 };
      // Columna 4: zona más alta a la derecha (si hay overflow)
      const col4 = { x: width - QR + 2, yBot: height * 0.35 + 2, yTop: height * 0.5, w: QR - 4 };

      const maxLinesCol = (col, fs) => Math.max(0, Math.floor((col.yTop - col.yBot) / (fs + 2)));
      const maxChars = (col, fs) => Math.max(4, Math.floor(col.w / (fs * 0.58)));

      const drawCol = (lines, col, fs) => {
        if (!lines.length) return;
        const mc = maxChars(col, fs);
        let y = col.yBot;
        for (const line of lines) {
          const safe = line.length > mc ? line.slice(0, mc - 1) + '\u2026' : line;
          page.drawText(safe, { x: col.x, y, size: fs, font, color: rgb(0, 0, 0) });
          y += fs + 2;
          if (y > col.yTop) break; // seguridad extra
        }
      };

      // Distribuir líneas entre columnas
      const cap1 = maxLinesCol(col1, fontSize);
      const cap2 = maxLinesCol(col2, fontSize);
      const cap3 = maxLinesCol(col3, fontSize);
      const cap4 = maxLinesCol(col4, fontSize);

      const batch1 = skuLines.slice(0, cap1);
      const batch2 = skuLines.slice(cap1, cap1 + cap2);
      const batch3 = skuLines.slice(cap1 + cap2, cap1 + cap2 + cap3);
      let remaining = skuLines.slice(cap1 + cap2 + cap3);

      drawCol(batch1, col1, fontSize);
      drawCol(batch2, col2, fontSize);
      drawCol(batch3, col3, fontSize);

      // Si aún sobran, usar col4 con font un poco más chico
      if (remaining.length > 0) {
        const smallFs = Math.max(2.5, fontSize - 0.5);
        const cap4s = maxLinesCol(col4, smallFs);
        drawCol(remaining.slice(0, cap4s), col4, smallFs);
        remaining = remaining.slice(cap4s);
      }

      // Último recurso: si aún sobran, escribir sobre la col2 con font muy chico
      if (remaining.length > 0) {
        const tinyFs = Math.max(2, fontSize - 1);
        drawCol(remaining, { ...col2, yBot: col2.yTop + 2, yTop: col2.yTop + remaining.length * (tinyFs + 2) + 2 }, tinyFs);
      }

      pageResults.push({ pageIdx: i, pageNum, pedido: pedidoNum, hasSkus: true, skus: skuLines });
    }

    // Paso 2: reordenar páginas
    let finalDoc = pdfDoc;
    if (cfg.sortBy !== 'sin' && cfg.pageOrder && Array.isArray(cfg.pageOrder)) {
      const newDoc = await PDFDocument.create();
      const validOrder = cfg.pageOrder.filter(idx => idx >= 0 && idx < pages.length);
      const withSku = validOrder.filter(idx => pageResults.find(r => r.pageIdx === idx)?.hasSkus);
      const withoutSku = validOrder.filter(idx => !withSku.includes(idx));
      for (const idx of [...withSku, ...withoutSku]) {
        const [copied] = await newDoc.copyPages(pdfDoc, [idx]);
        newDoc.addPage(copied);
      }
      finalDoc = newDoc;
    }

    // Paso 3: página resumen
    const skuTotals = {};
    pageResults.filter(r => r.hasSkus).forEach(r => {
      r.skus.forEach(s => {
        const match = s.match(/^(.+?)\s*\(x(\d+)\)$/);
        if (match) { skuTotals[match[1].trim()] = (skuTotals[match[1].trim()] || 0) + (parseInt(match[2]) || 1); }
        else { skuTotals[s] = (skuTotals[s] || 0) + 1; }
      });
    });

    if (Object.keys(skuTotals).length > 0) {
      const summaryPage = finalDoc.addPage([595, 842]);
      const { height: sh } = summaryPage.getSize();
      const titleFont = await finalDoc.embedFont(StandardFonts.HelveticaBold);
      const bodyFont  = await finalDoc.embedFont(StandardFonts.Helvetica);
      const now = new Date().toLocaleString('es-AR');
      summaryPage.drawText('RESUMEN DE SKU DESPACHADOS', { x: 50, y: sh - 60, size: 16, font: titleFont, color: rgb(0,0,0) });
      summaryPage.drawText(`Fecha: ${now}`, { x: 50, y: sh - 85, size: 10, font: bodyFont, color: rgb(0.3,0.3,0.3) });
      summaryPage.drawText(`Total: ${pages.length} páginas — ${pageResults.filter(r=>r.hasSkus).length} procesadas`, { x: 50, y: sh - 100, size: 10, font: bodyFont, color: rgb(0.3,0.3,0.3) });
      summaryPage.drawText('DETALLE:', { x: 50, y: sh - 130, size: 12, font: titleFont, color: rgb(0,0,0) });
      let lineY = sh - 155;
      for (const [sku, qty] of Object.entries(skuTotals).sort((a,b) => a[0].localeCompare(b[0]))) {
        summaryPage.drawText(`${sku}: ${qty} u`, { x: 60, y: lineY, size: 10, font: bodyFont, color: rgb(0,0,0) });
        lineY -= 18;
        if (lineY < 60) break;
      }
    }

    const pdfBytes = await finalDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rotulos-con-sku-${Date.now()}.pdf"`);
    res.setHeader('X-Results', JSON.stringify(pageResults.map(r => ({ page: r.pageNum, pedido: r.pedido, status: r.hasSkus ? 'ok' : 'sin_sku' }))));
    res.send(Buffer.from(pdfBytes));

  } catch (e) {
    console.error('[process-sku]', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
}
