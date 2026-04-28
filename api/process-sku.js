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

    if (nameMatch) {
      parts.push({ name: nameMatch[1], filename: filenameMatch?.[1] || null, data });
    }
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

    // skuMap: { "pedidoNum": { page: N (1-based), skus: [...], found: bool } }
    const skuMap = skuMapRaw ? JSON.parse(skuMapRaw) : {};

    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const pages = pdfDoc.getPages();

    const x = parseFloat(cfg.x) || 10;
    const yFromBottom = parseFloat(cfg.y) || 10;
    const fontSize = parseFloat(cfg.fontSize) || 4;

    // Paso 1: insertar SKUs en cada página según su número original
    const pageResults = [];

    for (let i = 0; i < pages.length; i++) {
      const pageNum = i + 1; // número de página 1-based
      const page = pages[i];
      const { width, height } = page.getSize();

      // Buscar en el skuMap la entrada que corresponde a esta página
      const entry = Object.entries(skuMap).find(([, v]) => v.page === pageNum);

      if (!entry || !entry[1].found || !entry[1].skus?.length) {
        pageResults.push({ pageIdx: i, pageNum, pedido: entry?.[0], hasSkus: false });
        continue;
      }

      const [pedidoNum, info] = entry;
      const skuLines = info.skus;

      // Calcular cuántas líneas entran en columna izquierda
      const lineHeight = fontSize + 1.5;
      const maxLinesPerCol = Math.floor((height * 0.22) / lineHeight); // usar ~22% inferior de la página
      const col2X = width * 0.52; // columna derecha: mitad derecha de la etiqueta

      let currentY = yFromBottom;
      let col2Y = yFromBottom;
      let useCol2 = false;

      for (let li = 0; li < skuLines.length; li++) {
        const line = skuLines[li];
        // Si la línea no entra en col 1, pasar a col 2
        if (!useCol2 && li >= maxLinesPerCol) useCol2 = true;
        const drawX = useCol2 ? col2X : x;
        const drawY = useCol2 ? col2Y : currentY;
        page.drawText(line, {
          x: drawX,
          y: drawY,
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
        });
        if (useCol2) col2Y += lineHeight;
        else currentY += lineHeight;
      }

      pageResults.push({ pageIdx: i, pageNum, pedido: pedidoNum, hasSkus: true, skus: skuLines });
    }

    // Paso 2: reordenar páginas si se pidió
    let finalDoc = pdfDoc;

    if (cfg.sortBy !== 'sin' && cfg.pageOrder && Array.isArray(cfg.pageOrder)) {
      // El frontend ya calculó el orden correcto — solo necesitamos reordenar
      const newDoc = await PDFDocument.create();
      const validOrder = cfg.pageOrder.filter(idx => idx >= 0 && idx < pages.length);

      // Páginas con SKU ordenadas + páginas sin SKU al final
      const withSku = validOrder.filter(idx => pageResults.find(r => r.pageIdx === idx)?.hasSkus);
      const withoutSku = validOrder.filter(idx => !withSku.includes(idx));
      const finalOrder = [...withSku, ...withoutSku];

      for (const idx of finalOrder) {
        const [copied] = await newDoc.copyPages(pdfDoc, [idx]);
        newDoc.addPage(copied);
      }
      finalDoc = newDoc;
    }

    // Paso 3: agregar página de resumen final
    const skuTotals = {};
    pageResults.filter(r => r.hasSkus).forEach(r => {
      r.skus.forEach(s => {
        // Parsear "AMARILLO-NN (x4)" → key: "AMARILLO-NN", qty: 4
        const match = s.match(/^(.+?)\s*\(x(\d+)\)$/);
        if (match) {
          const key = match[1].trim();
          const qty = parseInt(match[2]) || 1;
          skuTotals[key] = (skuTotals[key] || 0) + qty;
        } else {
          skuTotals[s] = (skuTotals[s] || 0) + 1;
        }
      });
    });

    if (Object.keys(skuTotals).length > 0) {
      const summaryPage = finalDoc.addPage([595, 842]); // A4
      const { width: sw, height: sh } = summaryPage.getSize();
      const titleFont = await finalDoc.embedFont(StandardFonts.HelveticaBold);
      const bodyFont = await finalDoc.embedFont(StandardFonts.Helvetica);

      const now = new Date().toLocaleString('es-AR');
      summaryPage.drawText('RESUMEN DE SKU DESPACHADOS', { x: 50, y: sh - 60, size: 16, font: titleFont, color: rgb(0,0,0) });
      summaryPage.drawText(`Fecha: ${now}`, { x: 50, y: sh - 85, size: 10, font: bodyFont, color: rgb(0.3,0.3,0.3) });
      summaryPage.drawText(`Total de páginas: ${pages.length}`, { x: 50, y: sh - 100, size: 10, font: bodyFont, color: rgb(0.3,0.3,0.3) });
      summaryPage.drawText(`Procesadas exitosamente: ${pageResults.filter(r=>r.hasSkus).length}`, { x: 50, y: sh - 115, size: 10, font: bodyFont, color: rgb(0.3,0.3,0.3) });

      summaryPage.drawText('DETALLE DE SKU DESPACHADOS:', { x: 50, y: sh - 150, size: 12, font: titleFont, color: rgb(0,0,0) });

      let lineY = sh - 175;
      const sorted = Object.entries(skuTotals).sort((a,b) => a[0].localeCompare(b[0]));
      for (const [sku, qty] of sorted) {
        summaryPage.drawText(`${sku}: CANTIDAD TOTAL: ${qty}`, { x: 60, y: lineY, size: 10, font: bodyFont, color: rgb(0,0,0) });
        lineY -= 18;
        if (lineY < 60) break;
      }
    }

    const pdfBytes = await finalDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rotulos-con-sku-${Date.now()}.pdf"`);
    res.setHeader('X-Results', JSON.stringify(pageResults.map(r => ({
      page: r.pageNum, pedido: r.pedido, status: r.hasSkus ? 'ok' : 'sin_sku'
    }))));
    res.send(Buffer.from(pdfBytes));

  } catch (e) {
    console.error('[process-sku]', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
}
