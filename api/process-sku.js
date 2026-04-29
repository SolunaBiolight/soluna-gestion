// api/process-sku.js
// Zonas medidas del PDF real Andreani (196x298pt):
// Z1: y=43..64 desde abajo, x=27..145 (entre IMPORTANTE y QR inferiores)
// Z2: y=108..140 desde abajo, x=27..145 (entre Sucursal Rendicion y barcode)
// Z3: y=43..140 desde abajo, x=147..188 (franja derecha libre)

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

      // Escalar si la pagina no es exactamente 196x298
      const sx = W / 196;
      const sy = H / 298;

      // Definir las 3 zonas libres (en coordenadas y-desde-abajo del PDF real)
      // Convertir a y-desde-arriba para pdf-lib: y_pdflib = H - y_desde_abajo
      // pdf-lib dibuja con y=0 en la parte INFERIOR, asi que:
      // y_pdflib = y_desde_abajo (ya es desde abajo!)
      
      const zones = [
        // Z1: entre IMPORTANTE y QR inferiores
        { x: 27*sx, w: (145-27)*sx, yBot: 43*sy, yTop: 64*sy },
        // Z2: entre Sucursal Rendicion y barcode
        { x: 27*sx, w: (145-27)*sx, yBot: 108*sy, yTop: 140*sy },
        // Z3: franja derecha libre (ningún texto impreso ahi)
        { x: 147*sx, w: (188-147)*sx, yBot: 43*sy, yTop: 140*sy },
      ];

      // Calcular cuantas lineas caben en cada zona con un fontSize dado
      const linesInZone = (zone, fs) => {
        const lh = fs + 1.5;
        return Math.max(0, Math.floor((zone.yTop - zone.yBot) / lh));
      };

      // Ajustar fontSize si no entran todos (minimo 2.5pt)
      let fs = baseFontSize;
      const totalCap = (f) => zones.reduce((s, z) => s + linesInZone(z, f), 0);
      
      // Reducir font hasta que entren, pero no menos de 2.5
      if (totalCap(fs) < skuLines.length) {
        for (let tryFs = fs - 0.5; tryFs >= 2.5; tryFs -= 0.5) {
          if (totalCap(tryFs) >= skuLines.length) {
            fs = tryFs;
            break;
          }
          fs = tryFs; // usar el mas pequeno disponible si nada alcanza
        }
      }

      // Distribuir y dibujar
      let lineIdx = 0;
      for (const zone of zones) {
        if (lineIdx >= skuLines.length) break;
        const cap = linesInZone(zone, fs);
        const lh = fs + 1.5;
        const maxCh = Math.max(4, Math.floor(zone.w / (fs * 0.58)));
        
        for (let li = 0; li < cap && lineIdx < skuLines.length; li++) {
          const line = skuLines[lineIdx];
          const safe = line.length > maxCh ? line.slice(0, maxCh - 1) + '\u2026' : line;
          const y = zone.yBot + li * lh;
          page.drawText(safe, { x: zone.x, y, size: fs, font, color: rgb(0, 0, 0) });
          lineIdx++;
        }
      }

      pageResults.push({ pageIdx: i, pageNum, pedido: pedidoNum, hasSkus: true, skus: skuLines });
    }

    // Reordenar paginas si se pidio
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
    res.setHeader('X-Results', JSON.stringify(pageResults.map(r => ({ page: r.pageNum, pedido: r.pedido, status: r.hasSkus ? 'ok' : 'sin_sku' }))));
    res.send(Buffer.from(pdfBytes));

  } catch (e) {
    console.error('[process-sku]', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
}
