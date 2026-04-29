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

    const skuMap = skuMapRaw ? JSON.parse(skuMapRaw) : {};

    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const pages = pdfDoc.getPages();

    const fontSize = parseFloat(cfg.fontSize) || 4;
    const lineHeight = fontSize + 2;

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

      // ── Zonas seguras ──────────────────────────────────────────────
      // Las etiquetas Andreani tienen QR codes en las esquinas inferiores
      // (izquierda y derecha) y texto "N° de seguimiento" al pie.
      // Zona segura: franja central inferior, entre los dos QR.
      //
      // Andreani label dimensions aprox:
      //   - QR inferior izquierdo: x=0..~55pt, y=0..~55pt
      //   - QR inferior derecho:   x=width-55..width, y=0..~55pt
      //   - Texto "N° de seguimiento": y~10pt
      //
      // Estrategia de columnas:
      //   Col A: zona central inferior  (entre los dos QR, y=15..55, x=60..width-60)
      //   Col B: zona media izquierda   (y=55..120, x=5..width/2-5)
      //   Col C: zona media derecha     (y=55..120, x=width/2+5..width-5)
      //
      // Todas las zonas garantizan que el texto sea visible.

      const QR_SIZE = 58;        // tamaño estimado del QR en puntos
      const MARGIN = 5;

      // Zona A: franja entre los dos QR codes (abajo, centro)
      const zoneA = {
        xStart: QR_SIZE + MARGIN,
        xEnd:   width - QR_SIZE - MARGIN,
        yStart: MARGIN + 12,     // sobre el texto "N° seguimiento"
        yEnd:   QR_SIZE - MARGIN,
      };

      // Zona B: mitad izquierda media (sobre el QR izquierdo)
      const zoneB = {
        xStart: MARGIN,
        xEnd:   width / 2 - MARGIN,
        yStart: MARGIN,
        yEnd:   height * 0.32,   // hasta ~32% inferior (zona segura sin texto impreso)
      };

      // Zona C: mitad derecha media (sobre el QR derecho)
      const zoneC = {
        xStart: width / 2 + MARGIN,
        xEnd:   width - MARGIN,
        yStart: MARGIN,
        yEnd:   height * 0.32,
      };

      // Calcular cuántas líneas caben en cada zona
      const linesInZone = (zone) => {
        const zoneHeight = zone.yEnd - zone.yStart;
        return Math.max(1, Math.floor(zoneHeight / lineHeight));
      };

      const capsA = linesInZone(zoneA);
      const capsB = linesInZone(zoneB);
      const capsC = linesInZone(zoneC);

      // Distribuir líneas en zonas
      const colA = skuLines.slice(0, capsA);
      const colB = skuLines.slice(capsA, capsA + capsB);
      const colC = skuLines.slice(capsA + capsB, capsA + capsB + capsC);
      // Si todavía sobran, agregarlos a col B/C con font más chico (fallback)
      const overflow = skuLines.slice(capsA + capsB + capsC);

      // Función para dibujar una columna
      const drawCol = (lines, zone, fSize) => {
        if (!lines.length) return;
        const colWidth = zone.xEnd - zone.xStart;
        const maxChars = Math.max(5, Math.floor(colWidth / (fSize * 0.55)));
        let y = zone.yStart;
        for (const line of lines) {
          const safeLine = line.length > maxChars
            ? line.slice(0, maxChars - 1) + '\u2026'
            : line;
          page.drawText(safeLine, {
            x: zone.xStart,
            y,
            size: fSize,
            font,
            color: rgb(0, 0, 0),
          });
          y += fSize + 2;
        }
      };

      drawCol(colA, zoneA, fontSize);
      drawCol(colB, zoneB, fontSize);
      drawCol(colC, zoneC, fontSize);

      // Overflow: reducir font y reintentar en zona B
      if (overflow.length > 0) {
        const smallFont = Math.max(2.5, fontSize - 1);
        drawCol(overflow, {
          xStart: zoneB.xStart,
          xEnd: zoneC.xEnd,
          yStart: zoneB.yEnd + 2,
          yEnd: zoneB.yEnd + 2 + overflow.length * (smallFont + 2),
        }, smallFont);
      }

      pageResults.push({ pageIdx: i, pageNum, pedido: pedidoNum, hasSkus: true, skus: skuLines });
    }

    // Paso 2: reordenar páginas si se pidió
    let finalDoc = pdfDoc;

    if (cfg.sortBy !== 'sin' && cfg.pageOrder && Array.isArray(cfg.pageOrder)) {
      const newDoc = await PDFDocument.create();
      const validOrder = cfg.pageOrder.filter(idx => idx >= 0 && idx < pages.length);
      const withSku = validOrder.filter(idx => pageResults.find(r => r.pageIdx === idx)?.hasSkus);
      const withoutSku = validOrder.filter(idx => !withSku.includes(idx));
      const finalOrder = [...withSku, ...withoutSku];
      for (const idx of finalOrder) {
        const [copied] = await newDoc.copyPages(pdfDoc, [idx]);
        newDoc.addPage(copied);
      }
      finalDoc = newDoc;
    }

    // Paso 3: página de resumen
    const skuTotals = {};
    pageResults.filter(r => r.hasSkus).forEach(r => {
      r.skus.forEach(s => {
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
      const summaryPage = finalDoc.addPage([595, 842]);
      const { width: sw, height: sh } = summaryPage.getSize();
      const titleFont = await finalDoc.embedFont(StandardFonts.HelveticaBold);
      const bodyFont  = await finalDoc.embedFont(StandardFonts.Helvetica);

      const now = new Date().toLocaleString('es-AR');
      summaryPage.drawText('RESUMEN DE SKU DESPACHADOS', { x: 50, y: sh - 60, size: 16, font: titleFont, color: rgb(0,0,0) });
      summaryPage.drawText(`Fecha: ${now}`, { x: 50, y: sh - 85, size: 10, font: bodyFont, color: rgb(0.3,0.3,0.3) });
      summaryPage.drawText(`Total de páginas: ${pages.length}`, { x: 50, y: sh - 100, size: 10, font: bodyFont, color: rgb(0.3,0.3,0.3) });
      summaryPage.drawText(`Procesadas: ${pageResults.filter(r=>r.hasSkus).length}`, { x: 50, y: sh - 115, size: 10, font: bodyFont, color: rgb(0.3,0.3,0.3) });
      summaryPage.drawText('DETALLE:', { x: 50, y: sh - 150, size: 12, font: titleFont, color: rgb(0,0,0) });

      let lineY = sh - 175;
      const sorted = Object.entries(skuTotals).sort((a,b) => a[0].localeCompare(b[0]));
      for (const [sku, qty] of sorted) {
        summaryPage.drawText(`${sku}: ${qty}u`, { x: 60, y: lineY, size: 10, font: bodyFont, color: rgb(0,0,0) });
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
