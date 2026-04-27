// api/process-sku.js
// Recibe un PDF de rótulos Andreani + mapa de pedido→SKUs
// Inserta los SKUs en cada página del PDF y devuelve el PDF modificado

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = await readBody(req);

    // El body es multipart — parsear manualmente boundary
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) return res.status(400).json({ error: 'Missing boundary' });

    const boundary = '--' + boundaryMatch[1];
    const parts = splitMultipart(body, boundary);

    let pdfBuffer = null;
    let skuMapRaw = null;
    let config = { x: 10, y: 10, fontSize: 4, sortBy: 'sku' };

    for (const part of parts) {
      const { name, filename, data } = part;
      if (name === 'pdf' && filename) pdfBuffer = data;
      if (name === 'skuMap') skuMapRaw = data.toString('utf-8');
      if (name === 'config') {
        try { config = { ...config, ...JSON.parse(data.toString('utf-8')) }; } catch(_) {}
      }
    }

    if (!pdfBuffer) return res.status(400).json({ error: 'No PDF recibido' });

    // skuMap: { "1234": ["Rojo - M. Negro (x1)", "Amarillo - M. Transparente (x2)"], ... }
    const skuMap = skuMapRaw ? JSON.parse(skuMapRaw) : {};

    // Procesar el PDF
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const pages = pdfDoc.getPages();

    const resultados = [];

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const { width, height } = page.getSize();

      // Buscar el número de pedido en el skuMap
      // La página ya fue procesada por el frontend que envió el skuMap con los pedidos correctos
      const pageNum = i + 1;
      const pageEntry = Object.entries(skuMap).find(([, v]) => v.page === pageNum);

      if (!pageEntry) {
        resultados.push({ page: pageNum, status: 'sin_pedido' });
        continue;
      }

      const [pedidoNum, info] = pageEntry;
      const skuLines = info.skus || [];

      if (skuLines.length === 0) {
        resultados.push({ page: pageNum, pedido: pedidoNum, status: 'sin_sku' });
        continue;
      }

      // Insertar SKUs en el PDF
      const x = parseFloat(config.x) || 10;
      const fontSize = parseFloat(config.fontSize) || 4;
      // Y desde arriba: convertir a coordenada pdf-lib (desde abajo)
      let yFromTop = parseFloat(config.y) || 10;
      let yPdfLib = height - yFromTop - fontSize;

      for (const line of skuLines) {
        page.drawText(line, {
          x,
          y: yPdfLib,
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
        });
        yPdfLib -= (fontSize + 1.5);
      }

      resultados.push({ page: pageNum, pedido: pedidoNum, status: 'ok', skus: skuLines });
    }

    // Ordenar páginas si se pidió
    if (config.sortBy === 'sku') {
      // Reordenar páginas por SKU del primer producto
      const pageOrder = resultados
        .filter(r => r.status === 'ok')
        .sort((a, b) => (a.skus[0] || '').localeCompare(b.skus[0] || ''));

      const sinSku = resultados.filter(r => r.status !== 'ok').map(r => r.page - 1);
      const indices = [...pageOrder.map(r => r.page - 1), ...sinSku];

      if (indices.length === pages.length) {
        const newPdf = await PDFDocument.create();
        for (const idx of indices) {
          const [copiedPage] = await newPdf.copyPages(pdfDoc, [idx]);
          newPdf.addPage(copiedPage);
        }
        const sortedBytes = await newPdf.save();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="rotulos-con-sku.pdf"');
        res.setHeader('X-Results', JSON.stringify(resultados));
        return res.send(Buffer.from(sortedBytes));
      }
    }

    const pdfBytes = await pdfDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="rotulos-con-sku.pdf"');
    res.setHeader('X-Results', JSON.stringify(resultados));
    res.send(Buffer.from(pdfBytes));

  } catch (e) {
    console.error('[process-sku]', e.message);
    res.status(500).json({ error: e.message });
  }
}

function splitMultipart(body, boundary) {
  const parts = [];
  const boundaryBuf = Buffer.from(boundary);
  let start = 0;

  while (true) {
    const idx = indexOfBuffer(body, boundaryBuf, start);
    if (idx === -1) break;
    const contentStart = idx + boundaryBuf.length + 2; // skip \r\n
    const nextIdx = indexOfBuffer(body, boundaryBuf, contentStart);
    if (nextIdx === -1) break;

    const partBuf = body.slice(contentStart, nextIdx - 2); // trim \r\n before next boundary
    const headerEnd = indexOfBuffer(partBuf, Buffer.from('\r\n\r\n'));
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

function indexOfBuffer(haystack, needle, start = 0) {
  for (let i = start; i <= haystack.length - needle.length; i++) {
    let found = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}
