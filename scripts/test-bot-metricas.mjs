// Test mínimo de GET /api/bot/metricas (solo lectura).
// Uso: BOT_API_KEY=... node scripts/test-bot-metricas.mjs [base] [cliente_id]
const base = process.argv[2] || "https://www.growithapp.com";
const cliente = process.argv[3] || "t_mvmbo0oa3a75ni";
const url = `${base}/api/bot/metricas?cliente_id=${cliente}&ventana_horas=24`;
let fallas = 0;
const ok = (c, m) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) fallas++; };
const r1 = await fetch(url);
ok(r1.status === 401, `sin clave → 401 (dio ${r1.status})`);
const r2 = await fetch(url, { headers: { "X-Bot-Key": "clave-incorrecta-clave-incorrecta-xx" } });
ok(r2.status === 401, `clave incorrecta → 401 (dio ${r2.status})`);
if (process.env.BOT_API_KEY) {
  const t0 = Date.now();
  const r3 = await fetch(url, { headers: { "X-Bot-Key": process.env.BOT_API_KEY } });
  const j = await r3.json().catch(() => ({}));
  ok(r3.status === 200, `con clave → 200 (dio ${r3.status}, ${Date.now() - t0} ms)`);
  for (const k of ["generado_utc", "cliente_id", "ventana", "totales", "campanas", "por_hora", "ventas_sin_utm"]) ok(k in j, `trae "${k}"`);
  for (const k of ["gasto", "facturacion", "ventas", "roas", "cpa", "cpa_break_even", "break_even_roas"]) ok(j.totales && k in j.totales, `totales.${k}`);
  const c = j.campanas?.[0]; if (c) ok(["campaign_id", "conjuntos"].every(k => k in c) && (!c.conjuntos[0] || "anuncios" in c.conjuntos[0]), "campaña → conjuntos → anuncios");
} else console.log("(sin BOT_API_KEY en el entorno: se saltea la prueba con clave)");
process.exit(fallas ? 1 : 0);
