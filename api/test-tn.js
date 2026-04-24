// api/test-tn.js — endpoint temporal de debug, eliminar después
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const storeId = "6978415";
  const token = "71be8939bf409df5b98caa80e22d7227ad288f82";
  const headers = {
    'Authentication': `bearer ${token}`,
    'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)'
  };

  const tests = [
    // Test 1: sin filtros
    "orders?per_page=1",
    // Test 2: payment_status solo
    "orders?per_page=1&payment_status=paid",
    // Test 3: shipping_status solo
    "orders?per_page=1&shipping_status=unpacked",
    // Test 4: ambos
    "orders?per_page=1&payment_status=paid&shipping_status=unpacked",
    // Test 5: ver los campos reales de un pedido
    "orders?per_page=1&fields=id,number,payment_status,shipping_status,status",
  ];

  const results = {};
  for (const t of tests) {
    try {
      const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/${t}`, { headers });
      const data = await r.json();
      results[t] = {
        status: r.status,
        count: Array.isArray(data) ? data.length : null,
        sample: Array.isArray(data) && data[0] ? {
          payment_status: data[0].payment_status,
          shipping_status: data[0].shipping_status,
          status: data[0].status,
        } : data
      };
    } catch(e) {
      results[t] = { error: e.message };
    }
  }

  res.json(results);
}
