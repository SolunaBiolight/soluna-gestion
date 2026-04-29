// api/process-sku.js
// Zonas calculadas con medición real del PDF Andreani (196x298pt):
//
// ZONA 1: entre "IMPORTANTE" y QR inferiores
//   x=27..145, y_from_bot=43..64  → 21pt altura ≈ 3 líneas @6pt
//
// ZONA 2: entre "Sucursal de Rendición" y código de barras
//   x=27..145, y_from_bot=108..140  → 32pt altura ≈ 5 líneas @6pt
//
// ZONA 3: si sobran, zona más ancha encima del código de barras
//   x=27..140, y_from_bot=140..160  → 20pt pero puede rozar barcode
//   → usar solo si faltan líneas, con texto más pequeño
//
// Total garantizado: ~8 líneas a fontSize 4-5pt
// Para pedidos con muchos SKU: reducir fontSize automáticamente

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

function drawSkusOnPage(page, skuLines, baseFontSize, font) {
  const { width: W, height: H } = page.getSize();

  // Escalar coordenadas si la página no es 196x298
  const scaleX = W / 196;
  const scaleY = H / 298;

  // ZONA 1: franja entre "IMPORTANTE" y QR inferiores
  // y_from_bot 43..64 → y_pdf = 43*scaleY .. 64*scaleY
  const z1 = { x1: 27*scaleX, x2: 145*scaleX, yBot: 43*scaleY, yTop: 64*scaleY };

  // ZONA 2: franja entre Sucursal Rendición y barcode
  // y_from_bot 108..140
  const z2 = { x1: 27*scaleX, x2: 145*scaleX, yBot: 108*scaleY, yTop: 140*scaleY };

  // ZONA 3 (col derecha de zona 2): si hay muchos SKU
  // x=145..188, y_from_bot 43..140 — zona derecha libre (no hay texto allí)
  const z3 = { x1: 147*scaleX, x2: 188*scaleX, yBot: 43*scaleY, yTop: 140*scaleY };

  // Calcular cuántas líneas caben en cada zona con un fontSize dado
  const linesIn = (zone, fs) => Math.max(0, Math.floor((zone.yTop - zone.yBot) / (fs + 1.5)));

  // Ajustar fontSize automáticamente si no entran todos en las zonas 1+2+3
  let fs = baseFontSize;
  const totalCap = () => linesIn(z1, fs) + linesIn(z2, fs) + linesIn(z3, fs);
  while (totalCap() < skuLines.length && fs > 2.5) {
    fs -= 0.5;
  }

  // Distribuir líneas
  const cap1 = linesIn(z1, fs);
  const cap2 = linesIn(z2, fs);
  const cap3 = linesIn(z3, fs);

  const batch1 = skuLines.slice(0, cap1);
  const batch2 = skuLines.slice(cap1, cap1 + cap2);
  const batch3 = skuLines.slice(cap1 + cap2, cap1 + cap2 + cap3);

  // Dibujar en cada zona
  const draw = (lines, zone) => {
    if (!lines.length) return;
    const colW = zone.x2 - zone.x1;
    const maxCh = Math.max(4, Math.floor(colW / (fs * 0.58)));
    let y = zone.yBot;
    for (const line of lines) {
      const safe = line.length > maxCh ? line.slice(0, maxCh - 1) + '\u2026' : line;
      page.drawText(safe, { x: zone.x1, y, size: fs, font, color: rgb(0, 0, 0) });
      y += fs + 1.5;
    }
  };

  draw(batch1, z1);
  draw(batch2, z2);
  draw(batch3, z3);
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
    const fontSize = parseFloat(cfg.fontSize) || 4;
    const pageResults = [];

    for (let i = 0; i < pages.length; i++) {
      const pageNum = i + 1;
      const page = pages[i];
      const entry = Object.entries(skuMap).find(([, v]) => v.page === pageNum);

      if (!entry || !entry[1].found || !entry[1].skus?.length) {
        pageResults.push({ pageIdx: i, pageNum, pedido: entry?.[0], hasSkus: false });
        continue;
      }

      const [pedidoNum, info] = entry;
      drawSkusOnPage(page, info.skus, fontSize, font);
      pageResults.push({ pageIdx: i, pageNum, pedido: pedidoNum, hasSkus: true, skus: info.skus });
    }

    // Reordenar si se pidió
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

    // Página resumen
    const skuTotals = {};
    pageResults.filter(r => r.hasSkus).forEach(r => {
      r.skus.forEach(s => {
        const m = s.match(/^(.+?)\s*\(x(\d+)\)$/);
        if (m) { skuTotals[m[1].trim()] = (skuTotals[m[1].trim()] || 0) + (parseInt(m[2]) || 1); }
        else { skuTotals[s] = (skuTotals[s] || 0) + 1; }
      });
    });

    if (Object.keys(skuTotals).length > 0) {
      const sp = finalDoc.addPage([595, 842]);
      const { height: sh } = sp.getSize();
      const tf = await finalDoc.embedFont(StandardFonts.HelveticaBold);
      const bf = await finalDoc.embedFont(StandardFonts.Helvetica);
      const now = new Date().toLocaleString('es-AR');
      sp.drawText('RESUMEN SKU DESPACHADOS', { x: 50, y: sh-60, size: 16, font: tf, color: rgb(0,0,0) });
      sp.drawText(`Fecha: ${now}  |  ${pages.length} páginas  |  ${pageResults.filter(r=>r.hasSkus).length} procesadas`, { x: 50, y: sh-85, size: 10, font: bf, color: rgb(0.3,0.3,0.3) });
      sp.drawText('DETALLE:', { x: 50, y: sh-120, size: 12, font: tf, color: rgb(0,0,0) });
      let ly = sh-145;
      for (const [sku, qty] of Object.entries(skuTotals).sort((a,b)=>a[0].localeCompare(b[0]))) {
        sp.drawText(`${sku}  →  ${qty} u`, { x: 60, y: ly, size: 10, font: bf, color: rgb(0,0,0) });
        ly -= 18;
        if (ly < 60) break;
      }
    }

    const pdfBytes = await finalDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rotulos-con-sku-${Date.now()}.pdf"`);
    res.setHeader('X-Results', JSON.stringify(pageResults.map(r=>({ page: r.pageNum, pedido: r.pedido, status: r.hasSkus?'ok':'sin_sku' }))));
    res.send(Buffer.from(pdfBytes));

  } catch (e) {
    console.error('[process-sku]', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
}
