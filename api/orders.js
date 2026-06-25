import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getValidMLToken } from "./integrations.js";

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n").replace(/"/g, ""),
    }),
  });
  return getFirestore();
}

// ─── Rendimiento helpers (antiguo rendimiento.js) ────────────────────────
const META_V = "v21.0";
const META_BASE = `https://graph.facebook.com/${META_V}`;

async function metaGet(path, params, token) {
  const url = new URL(`${META_BASE}/${path}`);
  url.searchParams.set("access_token", token);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString());
  const j = await r.json();
  if (j.error) throw new Error(`Meta API: ${j.error.message}`);
  return j;
}

async function fetchMetaDailySpend(cfg, since, until, errRef) {
  if (!cfg?.access_token || !cfg.ad_account_id) return {};
  try {
    const res = await metaGet(`${cfg.ad_account_id}/insights`, {
      level: "account",
      fields: "spend,actions,action_values,purchase_roas,impressions,clicks,reach",
      "time_range[since]": since, "time_range[until]": until,
      time_increment: "1",
      action_attribution_windows: JSON.stringify(["1d_click","1d_view"]),
      limit: "90",
    }, cfg.access_token);
    const byDate = {};
    for (const row of (res.data || [])) {
      const date = row.date_start; if (!date) continue;
      byDate[date] = {
        spend: parseFloat(row.spend) || 0,
        roas: parseFloat((row.purchase_roas || [])[0]?.value) || 0,
        purchases: parseFloat((row.actions || []).find(a => a.action_type==="purchase")?.value || 0),
        purchaseVal: parseFloat((row.action_values || []).find(a => a.action_type==="purchase")?.value || 0),
        impressions: parseInt(row.impressions) || 0, clicks: parseInt(row.clicks) || 0, reach: parseInt(row.reach) || 0,
      };
    }
    return byDate;
  } catch(e) {
    console.error("Meta daily spend error:", e.message);
    if (errRef && /expired|invalid.*token|oauth|session|\b190\b|access token/i.test(e.message||"")) errRef.expired = true;
    return {};
  }
}

function buildRendRows(since, until, dailyRevenue, dailyOrders, metaDailySpend, commission) {
  const allDates = new Set([...Object.keys(dailyRevenue), ...Object.keys(dailyOrders), ...Object.keys(metaDailySpend)]);
  const start = new Date(since + "T12:00:00"); const end = new Date(until + "T12:00:00");
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) allDates.add(d.toISOString().slice(0,10));
  return [...allDates].sort().map(date => {
    const revenue = dailyRevenue[date] || 0; const orders = dailyOrders[date] || 0;
    const adSpend = metaDailySpend[date]?.spend || 0; const netRevenue = revenue * (1 - commission);
    const profit = netRevenue - adSpend; const roas = adSpend > 0 ? revenue / adSpend : 0;
    const trueRoas = adSpend > 0 ? netRevenue / adSpend : 0; const cpa = orders > 0 ? adSpend / orders : 0;
    return {
      Fecha: date, "Ordenes > $0": orders, Revenue: revenue, "Ad Spend": adSpend,
      "Net Revenue": parseFloat(netRevenue.toFixed(2)), Profit: parseFloat(profit.toFixed(2)),
      "Profit Margin": revenue > 0 ? parseFloat((profit/revenue).toFixed(6)) : 0,
      ROAS: parseFloat(roas.toFixed(4)), "True ROAS": parseFloat(trueRoas.toFixed(4)),
      CPA: parseFloat(cpa.toFixed(2)),
      _impressions: metaDailySpend[date]?.impressions || 0, _clicks: metaDailySpend[date]?.clicks || 0,
      _reach: metaDailySpend[date]?.reach || 0,
    };
  });
}

function computeRendTotals(rows) {
  const t = rows.reduce((acc, r) => ({
    orders: acc.orders + (r["Ordenes > $0"] || 0), revenue: acc.revenue + (r.Revenue || 0),
    adSpend: acc.adSpend + (r["Ad Spend"] || 0), netRevenue: acc.netRevenue + (r["Net Revenue"] || 0),
    profit: acc.profit + (r.Profit || 0), impressions: acc.impressions + (r._impressions || 0),
    clicks: acc.clicks + (r._clicks || 0),
  }), {orders:0,revenue:0,adSpend:0,netRevenue:0,profit:0,impressions:0,clicks:0});
  return { ...t, roas: t.adSpend>0?t.revenue/t.adSpend:0, trueRoas: t.adSpend>0?t.netRevenue/t.adSpend:0,
    cpa: t.orders>0?t.adSpend/t.orders:0, profitMargin: t.revenue>0?t.profit/t.revenue:0,
    ctr: t.impressions>0?t.clicks/t.impressions:0 };
}

function computeRendDow(rows) {
  const DAYS = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
  const agg = Array.from({length:7}, (_,i) => ({dow:i, label:DAYS[i], revenue:0, adSpend:0, profit:0, orders:0, days:0}));
  rows.forEach(r => {
    const d = new Date(r.Fecha + "T12:00:00").getDay();
    agg[d].revenue += r.Revenue||0; agg[d].adSpend += r["Ad Spend"]||0;
    agg[d].profit += r.Profit||0; agg[d].orders += r["Ordenes > $0"]||0; agg[d].days++;
  });
  return agg.map(d => ({ ...d, avgRevenue: d.days>0?d.revenue/d.days:0, avgProfit: d.days>0?d.profit/d.days:0, avgOrders: d.days>0?d.orders/d.days:0 }));
}
// ─── fin Rendimiento helpers ──────────────────────────────────────────────

// Sin fallback — se requiere uid válido con tienda conectada

async function fetchPage(storeId, accessToken, extraParams, page, perPage=200) {
  const headers = {
    'Authentication': `bearer ${accessToken}`,
    'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)'
  };
  const url = `https://api.tiendanube.com/v1/${storeId}/orders?per_page=${perPage}&page=${page}${extraParams ? "&" + extraParams : ""}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`TN API error ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

async function fetchAllPages(storeId, accessToken, extraParams = "") {
  const first = await fetchPage(storeId, accessToken, extraParams, 1);
  if (first.length === 0 || first.length < 200) return first;
  const extras = await Promise.all(
    [2,3,4,5,6,7,8,9,10].map(p =>
      fetchPage(storeId, accessToken, extraParams, p).catch(() => [])
    )
  );
  let all = [...first];
  for (const page of extras) {
    if (page.length === 0) break;
    all = all.concat(page);
    if (page.length < 200) break;
  }
  return all;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { uid, tab, countOnly, q, action } = req.query;

  // ── Rendimiento: financial dashboard (antiguo /api/rendimiento) ──────────
  if (action === 'daily_metrics') {
    if (!uid) return res.status(400).json({ error: "Falta uid" });
    try {
      const db = initAdmin();
      const days = parseInt(req.query.days) || 30;
      // Día actual en zona Argentina (UTC-3) — alinea con api/stock.js (argTodayParts)
      // para que el rango no se corra de día (antes se calculaba en UTC y stock.js
      // lo reinterpretaba como AR, desalineando el revenue vs el tab Análisis).
      const argToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date());
      const addDays = (ymd, n) => { const [y,m,d]=ymd.split("-").map(Number); return new Date(Date.UTC(y,m-1,d)+n*86400000).toISOString().slice(0,10); };
      const until = req.query.date_to || argToday;
      const since = req.query.date_from || addDays(argToday, -(days-1));
      const span = Math.round((Date.parse(until+"T00:00:00Z") - Date.parse(since+"T00:00:00Z"))/86400000); // nº de días - 1
      const prevUntil = addDays(since, -1);
      const prevSince = addDays(prevUntil, -span);
      const userSnap = await db.collection("users").doc(uid).get();
      const userData = userSnap.data() || {};
      const stores = userData.stores || [];
      const hasML = stores.some(s => s.type === "meli");
      const commission = parseFloat(userData.rendimientoCommission) || (hasML ? 0.10 : 0.03);
      async function fetchStock(from, to) {
        try {
          const stockUrl = new URL(`https://${req.headers.host}/api/stock`);
          stockUrl.searchParams.set("uid", uid); stockUrl.searchParams.set("action", "products");
          stockUrl.searchParams.set("date_from", from); stockUrl.searchParams.set("date_to", to);
          const r = await fetch(stockUrl.toString(), { headers: { host: req.headers.host } });
          if (!r.ok) return { dailyRevenue:{}, dailyOrders:{} };
          const j = await r.json();
          // Combinar TN/Shopify + Mercado Libre (ML viene aparte en ml_data),
          // igual que el tab Análisis del front (mergeDaily). Antes se ignoraba ML
          // → facturación incompleta en el tab Márgenes.
          const dailyRevenue = { ...(j.daily_revenue||{}) };
          const dailyOrders  = { ...(j.daily_orders||{}) };
          const mlRev = j.ml_data?.daily_revenue || {};
          const mlOrd = j.ml_data?.daily_orders  || {};
          for (const [day,v] of Object.entries(mlRev)) dailyRevenue[day] = (dailyRevenue[day]||0) + (v||0);
          for (const [day,v] of Object.entries(mlOrd)) dailyOrders[day]  = (dailyOrders[day]||0)  + (v||0);
          return { dailyRevenue, dailyOrders, raw: j };
        } catch(_) { return { dailyRevenue:{}, dailyOrders:{}, raw:{} }; }
      }
      // Comisión REAL de Mercado Pago en ventas que NO son ML (Shopify/TN vía MP
      // Checkout). Con el token de ML se consultan los pagos de MP y se suma el
      // fee_details de los pagos de tienda (external_reference alfanumérico tipo
      // rXXX = receipt_id de la transacción Shopify). Se excluyen: ML (ref
      // numérica, ya contada en sale_fee), cashback, INSTORE, y no aprobados.
      async function fetchMPCommission(sinceYmd, untilYmd) {
        try {
          const tok = await getValidMLToken(db, uid);
          if (!tok?.accessToken) return 0;
          const begin = `${sinceYmd}T00:00:00.000-03:00`, end = `${untilYmd}T23:59:59.999-03:00`;
          let total = 0, offset = 0;
          for (let i=0; i<25; i++) {
            const url = `https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc&range=date_created&begin_date=${encodeURIComponent(begin)}&end_date=${encodeURIComponent(end)}&limit=100&offset=${offset}`;
            const r = await fetch(url, { headers: { Authorization: `Bearer ${tok.accessToken}` } });
            if (!r.ok) break;
            const j = await r.json();
            const results = j.results || [];
            for (const p of results) {
              const ref = String(p.external_reference || "");
              if (p.status==="approved" && p.operation_type==="regular_payment" && /[a-zA-Z]/.test(ref) && !/^cashback|^INSTORE/i.test(ref)) {
                total += (p.fee_details||[]).reduce((s,f)=>s+(parseFloat(f.amount)||0),0);
              }
            }
            offset += results.length;
            if (results.length < 100 || offset >= (j.paging?.total||0)) break;
          }
          return total;
        } catch(_) { return 0; }
      }
      const metaAccountsSnap = await db.collection("users").doc(uid).collection("meta_accounts").get();
      const metaAccounts = metaAccountsSnap.docs.map(d => d.data()).filter(a => a.access_token && a.ad_account_id);
      const metaErr = {};
      // Suma el gasto de TODAS las cuentas de Meta. Antes usaba solo la primera
      // (metaAccounts[0]), por eso daba Ad Spend $0 si la cuenta con gasto no era
      // la primera (ej: tener CP5 + CP7 activas).
      async function fetchMetaAll(s, u, eRef) {
        if (!metaAccounts.length) return {};
        const arr = await Promise.all(metaAccounts.map(a => fetchMetaDailySpend(a, s, u, eRef)));
        const merged = {};
        for (const bd of arr) for (const [d,v] of Object.entries(bd)) {
          const m = merged[d] || (merged[d] = { spend:0, impressions:0, clicks:0, reach:0, purchases:0, purchaseVal:0 });
          m.spend+=v.spend||0; m.impressions+=v.impressions||0; m.clicks+=v.clicks||0; m.reach+=v.reach||0; m.purchases+=v.purchases||0; m.purchaseVal+=v.purchaseVal||0;
        }
        return merged;
      }
      const [curr, prev, metaCurr, metaPrev, mpCommCurr, mpCommPrev] = await Promise.all([
        fetchStock(since, until), fetchStock(prevSince, prevUntil),
        fetchMetaAll(since, until, metaErr), fetchMetaAll(prevSince, prevUntil),
        fetchMPCommission(since, until), fetchMPCommission(prevSince, prevUntil),
      ]);
      const rows = buildRendRows(since, until, curr.dailyRevenue, curr.dailyOrders, metaCurr, commission);
      const prevRows = buildRendRows(prevSince, prevUntil, prev.dailyRevenue, prev.dailyOrders, metaPrev, commission);
      let totals = computeRendTotals(rows); let prevTotals = computeRendTotals(prevRows);
      const byDow = computeRendDow(rows);

      // ── Capas de costo configuradas en Márgenes → margen real estilo Escalafy ──
      const cogsMap   = userData.margenesCogs && typeof userData.margenesCogs==="object" && !Array.isArray(userData.margenesCogs) ? userData.margenesCogs : {};
      const comCfg    = userData.margenesComisionesCfg || {};
      const metodos   = comCfg.metodos && typeof comCfg.metodos==="object" ? comCfg.metodos : {};
      const envioProm = parseFloat(userData.margenesEnvioProm) || 0;
      const fijos     = Array.isArray(userData.margenesCostosFijos) ? userData.margenesCostosFijos : [];
      const dolarCfg  = userData.margenesDolar || {};
      const factExt   = Array.isArray(userData.margenesFactExterna) ? userData.margenesFactExterna : [];
      const fijosMensual = fijos.reduce((s,f)=>s+(parseFloat(f.monto)||0),0);
      const pctImp    = (parseFloat(comCfg.impuestos)||0)/100;
      const pctPlat   = (parseFloat(comCfg.shopify)||0)/100;
      const metPcts   = Object.values(metodos).map(m=>parseFloat(m.pct)||0).filter(x=>x>0);
      const pctPago   = metPcts.length ? (metPcts.reduce((a,b)=>a+b,0)/metPcts.length)/100 : 0;
      const feeAd     = (parseFloat(dolarCfg.feeAdSpend)||0)/100;

      function aplicarCostos(tot, raw, sinceR, untilR, dias, mpComm) {
        // COGS = unidades vendidas × costo cargado por producto/variante.
        let cogs = 0;
        for (const p of (raw?.products||[])) for (const v of (p.variants||[])) {
          const c = parseFloat(cogsMap[v.sku || String(v.id)]); if (c>0) cogs += c*(v.units_sold||0);
        }
        for (const m of (raw?.ml_data?.ml_products||[])) {
          const c = parseFloat(cogsMap["ml:"+m.id]); if (c>0) cogs += c*(m.units||0);
        }
        const storeRev = Object.values(raw?.daily_revenue||{}).reduce((a,b)=>a+b,0);
        const factExtTot = factExt.filter(r => r.fecha && r.fecha>=sinceR && r.fecha<=untilR).reduce((s,r)=>s+(parseFloat(r.monto)||0),0);
        const revenue   = (tot.revenue||0) + factExtTot;
        const impuestos = revenue * pctImp;
        // Comisión de plataforma = % configurado del store (Shopify/TN) + comisión
        // REAL de Mercado Libre (sale_fee de cada orden, ya incluye el pago de MP).
        const comML     = parseFloat(raw?.ml_data?.ml_commission)||0;
        const comPlat   = storeRev * pctPlat + comML;
        const comPago   = storeRev * pctPago + (parseFloat(mpComm)||0); // % configurado + comisión REAL de MP (Shopify)
        const envio     = (tot.orders||0) * envioProm;
        const costosAdic= dias>0 ? (fijosMensual/30)*dias : 0;
        const adSpendEf = (tot.adSpend||0) * (1+feeAd);
        const netRevenue= revenue - impuestos - comPlat - comPago;
        const profit    = revenue - cogs - impuestos - comPlat - comPago - envio - costosAdic - adSpendEf;
        return { ...tot,
          revenue, adSpend: adSpendEf, netRevenue: +netRevenue.toFixed(2), profit: +profit.toFixed(2),
          costoProductos: +cogs.toFixed(2), impuestos: +impuestos.toFixed(2),
          comisionPlataforma: +comPlat.toFixed(2), comisionPago: +comPago.toFixed(2),
          costoEnvio: +envio.toFixed(2), costosAdicionales: +costosAdic.toFixed(2),
          facturacionExterna: +factExtTot.toFixed(2),
          profitMargin: revenue>0 ? profit/revenue : 0,
          roas: adSpendEf>0 ? revenue/adSpendEf : 0,
          trueRoas: adSpendEf>0 ? netRevenue/adSpendEf : 0,
          cpa: (tot.orders||0)>0 ? adSpendEf/tot.orders : 0,
          mer: revenue>0 ? adSpendEf/revenue : 0,
          breakEvenRoas: (1-(pctImp+pctPlat+pctPago))>0 ? 1/(1-(pctImp+pctPlat+pctPago)) : 0,
        };
      }
      totals     = aplicarCostos(totals,     curr.raw, since,     until,     span+1, mpCommCurr);
      prevTotals = aplicarCostos(prevTotals, prev.raw, prevSince, prevUntil, span+1, mpCommPrev);

      // ── Desglose por canal (Tienda vs Mercado Libre) para los tableros ──
      function canal(raw, isMl, mpComm) {
        const dr = isMl ? (raw?.ml_data?.daily_revenue||{}) : (raw?.daily_revenue||{});
        const dord = isMl ? (raw?.ml_data?.daily_orders||{}) : (raw?.daily_orders||{});
        const rev = Object.values(dr).reduce((a,b)=>a+b,0);
        const ord = Object.values(dord).reduce((a,b)=>a+b,0);
        let cogs = 0;
        if (isMl) { for (const m of (raw?.ml_data?.ml_products||[])) { const c=parseFloat(cogsMap["ml:"+m.id]); if(c>0) cogs+=c*(m.units||0); } }
        else { for (const p of (raw?.products||[])) for (const v of (p.variants||[])) { const c=parseFloat(cogsMap[v.sku||String(v.id)]); if(c>0) cogs+=c*(v.units_sold||0); } }
        const impuestos = rev*pctImp;
        const comis = isMl ? (parseFloat(raw?.ml_data?.ml_commission)||0) : (rev*pctPlat + (parseFloat(mpComm)||0));
        const envio = isMl ? 0 : ord*envioProm;
        const netRev = rev - impuestos - comis;
        const profit = rev - cogs - impuestos - comis - envio;
        return { orders:ord, revenue:+rev.toFixed(2), netRevenue:+netRev.toFixed(2),
          costoProductos:+cogs.toFixed(2), impuestos:+impuestos.toFixed(2), comisiones:+comis.toFixed(2), costoEnvio:+envio.toFixed(2),
          profit:+profit.toFixed(2), margin: rev>0?profit/rev:0,
          aov: ord>0?rev/ord:0, aovNeto: ord>0?netRev/ord:0 };
      }
      const byChannel = {
        tienda: canal(curr.raw, false, mpCommCurr),
        ml:     canal(curr.raw, true,  0),
        tiendaPrev: canal(prev.raw, false, mpCommPrev),
        mlPrev:     canal(prev.raw, true,  0),
        platform: curr.raw?.platform || (curr.raw?.products?.[0]?.platform) || "tiendanube",
        hasMl: !!(curr.raw?.ml_data),
      };

      return res.json({ rows, prevRows, totals, prevTotals, byDow, byChannel, since, until, prevSince, prevUntil,
        meta: { hasMetaData: Object.keys(metaCurr).length>0, hasStoreData: Object.keys(curr.dailyRevenue).length>0, commission, metaAccountsCount: metaAccounts.length,
          metaTokenExpired: !!metaErr.expired,
          costosConfigurados: { cogs: Object.keys(cogsMap).length, impuestos: pctImp*100, plataforma: pctPlat*100, pago: pctPago*100, envioProm, fijosMensual, feeAd: feeAd*100 } } });
    } catch(e) { console.error("Dashboard error:", e); return res.status(500).json({ error: e.message }); }
  }

  if (action === 'save_config' && req.method === 'POST') {
    if (!uid) return res.status(400).json({ error: "Falta uid" });
    const body = await new Promise(resolve => {
      let d = ""; req.on("data", c => d += c); req.on("end", () => resolve(JSON.parse(d || "{}")));
    });
    const db = initAdmin();
    await db.collection("users").doc(uid).update({ rendimientoCommission: parseFloat(body.commission) || 0.03 });
    return res.json({ ok: true });
  }
  // ── fin Rendimiento ──────────────────────────────────────────────────────

  if (!uid) return res.status(401).json({ error: "uid requerido" });

  let platform = 'tiendanube', storeId, accessToken, shop, mlUserId, mlToken;
  let dbRef;
  try {
    dbRef = initAdmin();
    const userSnap = await dbRef.collection("users").doc(uid).get();
    if (userSnap.exists) {
      const stores = userSnap.data().stores || [];
      const tnStore = stores.find(s => s.type === "tiendanube");
      const shStore = stores.find(s => s.type === "shopify");
      const mlStore = stores.find(s => s.type === "mercadolibre" || s.type === "meli");
      // Shopify tiene prioridad si está conectado
      if (shStore?.accessToken && shStore?.shop) {
        platform = 'shopify';
        shop = shStore.shop;
        accessToken = shStore.accessToken;
      } else if (tnStore?.accessToken && tnStore?.storeId) {
        platform = 'tiendanube';
        storeId = tnStore.storeId;
        accessToken = tnStore.accessToken;
      }
      // ML (en paralelo a la plataforma primaria, para que stats sume todo)
      if (mlStore) {
        try {
          const tok = await getValidMLToken(dbRef, uid);
          if (tok?.accessToken && tok?.userId) { mlUserId = tok.userId; mlToken = tok.accessToken; }
        } catch (_) {}
      }
    }
  } catch(e) {
    console.error("Error fetching user store:", e.message);
    return res.status(500).json({ error: "Error al obtener credenciales" });
  }
  if (!accessToken) return res.status(403).json({ error: "Tienda no conectada" });

  // ── Helpers Shopify ───────────────────────────────────────────────────
  const SH_HEADERS = { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' };
  const SH_BASE = platform === 'shopify' ? `https://${shop}/admin/api/2024-10` : null;

  async function fetchShopifyOrders(from, to, extraParams = '') {
    let all = [], url = `${SH_BASE}/orders.json?limit=250&status=any&financial_status=paid&created_at_min=${encodeURIComponent(from)}&created_at_max=${encodeURIComponent(to)}&fields=id,total_price,created_at${extraParams}`;
    while (url) {
      const r = await fetch(url, { headers: SH_HEADERS });
      if (!r.ok) break;
      const d = await r.json();
      const batch = d.orders || [];
      all = all.concat(batch);
      if (batch.length < 250) break;
      const link = r.headers.get('Link') || '';
      const next = link.match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
    return all;
  }

  const calcStats = (orders, isShopify) => ({
    count: orders.length,
    revenue: orders.reduce((sum, o) => sum + parseFloat(isShopify ? (o.total_price || 0) : (o.total || 0)), 0),
    units: orders.reduce((sum, o) => {
      // Shopify: line_items[].quantity. TN: products[].quantity.
      const items = isShopify ? (o.line_items || []) : (o.products || []);
      return sum + items.reduce((s, it) => s + (parseInt(it.quantity) || 0), 0);
    }, 0),
  });

  // ── ML orders helper ───────────────────────────────────────────
  // Trae todas las órdenes paid (no canceladas) en el rango con paginación.
  async function fetchMLOrdersInRange(from, to) {
    if (!mlUserId || !mlToken) return [];
    const all = [];
    const fromISO = new Date(from).toISOString().replace("Z", "-00:00");
    const toISO = new Date(to).toISOString().replace("Z", "-00:00");
    for (let offset = 0; offset < 2000; offset += 50) {
      try {
        const url = `https://api.mercadolibre.com/orders/search?seller=${mlUserId}&order.status=paid&order.date_created.from=${encodeURIComponent(fromISO)}&order.date_created.to=${encodeURIComponent(toISO)}&limit=50&offset=${offset}&sort=date_desc`;
        const r = await fetch(url, { headers: { Authorization: `Bearer ${mlToken}` } });
        if (!r.ok) break;
        const d = await r.json();
        const batch = d.results || [];
        all.push(...batch);
        if (batch.length < 50) break;
      } catch (_) { break; }
    }
    return all;
  }
  const calcMLStats = (mlOrders) => ({
    count: mlOrders.length,
    revenue: mlOrders.reduce((s, o) => s + (parseFloat(o.total_amount) || 0), 0),
    units: mlOrders.reduce((s, o) => s + ((o.order_items || []).reduce((u, it) => u + (parseInt(it.quantity) || 0), 0)), 0),
  });
  const mergeStats = (a, b) => ({
    count: (a.count || 0) + (b.count || 0),
    revenue: (a.revenue || 0) + (b.revenue || 0),
    units: (a.units || 0) + (b.units || 0),
  });

  try {
    // Búsqueda directa por número (solo TN — Shopify devuelve vacío)
    if (q) {
      if (platform === 'shopify') return res.status(200).json([]);
      const headers = { 'Authentication': `bearer ${accessToken}`, 'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)' };
      const r = await fetch(`https://api.tiendanube.com/v1/${storeId}/orders?q=${encodeURIComponent(q)}&per_page=20`, { headers });
      if (!r.ok) throw new Error(`TN search error ${r.status}`);
      const data = await r.json();
      return res.status(200).json(Array.isArray(data) ? data : []);
    }

    // STATS: facturado + count período actual vs anterior (para Home KPIs)
    // Compatible con TN, Shopify y ML — SUMA todas las plataformas conectadas.
    if (tab === 'stats') {
      const { from, to, prevFrom } = req.query;
      if (!from) return res.status(400).json({ error: 'from required' });
      const toDate = to || new Date().toISOString();

      // Fetch ML en paralelo a la plataforma primaria
      const mlCurrentP = fetchMLOrdersInRange(from, toDate);
      const mlPrevP = prevFrom ? fetchMLOrdersInRange(prevFrom, from) : Promise.resolve([]);

      let primaryCurrent, primaryPrev;
      if (platform === 'shopify') {
        [primaryCurrent, primaryPrev] = await Promise.all([
          fetchShopifyOrders(from, toDate),
          prevFrom ? fetchShopifyOrders(prevFrom, from) : Promise.resolve([]),
        ]);
        primaryCurrent = calcStats(primaryCurrent, true);
        primaryPrev = calcStats(primaryPrev, true);
      } else {
        const mkParams = (f, t) =>
          `payment_status=paid&created_at_min=${encodeURIComponent(f)}&created_at_max=${encodeURIComponent(t)}`;
        [primaryCurrent, primaryPrev] = await Promise.all([
          fetchAllPages(storeId, accessToken, mkParams(from, toDate)),
          prevFrom ? fetchAllPages(storeId, accessToken, mkParams(prevFrom, from)) : Promise.resolve([]),
        ]);
        primaryCurrent = calcStats(primaryCurrent, false);
        primaryPrev = calcStats(primaryPrev, false);
      }
      const [mlCurOrders, mlPrevOrders] = await Promise.all([mlCurrentP, mlPrevP]);
      const mlCurrent = calcMLStats(mlCurOrders);
      const mlPrev = calcMLStats(mlPrevOrders);
      return res.status(200).json({
        current: mergeStats(primaryCurrent, mlCurrent),
        prev: mergeStats(primaryPrev, mlPrev),
        breakdown: { primary: primaryCurrent, ml: mlCurrent }, // por si la UI quiere desglosar
      });
    }

    // ─── Helper: traduce orden Shopify → formato TN-compatible para que la UI
    // (buildOrdersFromAPI) la procese sin cambios ───
    const shopifyToTNFormat = (o) => {
      const sh = o.shipping_address || o.billing_address || {};
      const fulfillments = o.fulfillments || [];
      const isFulfilled = (o.fulfillment_status || "").toLowerCase() === "fulfilled" || fulfillments.some(f => (f.status || "").toLowerCase() === "success");
      const shStatus = isFulfilled ? "shipped" : (fulfillments.length > 0 ? "ready_to_ship" : "unpacked");
      return {
        id: o.id,
        number: o.order_number || (o.name || "").replace("#", "") || o.id,
        status: o.cancelled_at ? "cancelled" : "open",
        payment_status: o.financial_status === "paid" ? "paid" : (o.financial_status === "pending" ? "pending" : o.financial_status || ""),
        shipping_status: shStatus,
        contact_name: o.customer ? `${o.customer.first_name || ""} ${o.customer.last_name || ""}`.trim() : (sh.name || ""),
        contact_email: o.email || o.contact_email || o.customer?.email || "",
        contact_phone: o.phone || sh.phone || o.customer?.phone || "",
        contact_identification: "",
        created_at: o.created_at,
        paid_at: o.processed_at,
        shipped_at: fulfillments[0]?.created_at || null,
        total: o.total_price,
        subtotal: o.subtotal_price,
        discount: o.total_discounts || "0",
        shipping_cost_customer: o.total_shipping_price_set?.shop_money?.amount || "0",
        shipping_address: {
          name: sh.first_name || "",
          last_name: sh.last_name || "",
          address: sh.address1 || "",
          number: "",
          floor: sh.address2 || "",
          locality: sh.city || "",
          city: sh.city || "",
          zipcode: sh.zip || "",
          province: sh.province || "",
        },
        billing_address: o.billing_address ? { name: `${o.billing_address.first_name || ""} ${o.billing_address.last_name || ""}`.trim(), email: o.email || "", phone: o.billing_address.phone || "" } : null,
        shipping_option: o.shipping_lines?.[0]?.title || "Envío",
        shipping_tracking_number: fulfillments[0]?.tracking_number || "",
        payment_details: { method: o.payment_gateway_names?.[0] || "" },
        gateway_name: o.payment_gateway_names?.[0] || "",
        storefront: "shopify",
        fulfillments: fulfillments.map(f => ({ status: (f.status || "").toLowerCase() === "success" ? "PACKED" : "PENDING", shipping: { option: { name: f.tracking_company || "" } } })),
        products: (o.line_items || []).map(li => ({
          name: li.title || li.name || "",
          product_name: li.title || li.name || "",
          quantity: li.quantity || 1,
          price: li.price || "0",
          unit_price: li.price || "0",
          sku: li.sku || "",
        })),
        _platform: "shopify",
      };
    };

    // Helper Shopify: traer orders con paginación
    const shopifyFetchOrders = async (extraQuery) => {
      const out = [];
      let url = `${SH_BASE}/orders.json?limit=250&status=any&${extraQuery}`;
      let safety = 0;
      while (url && safety < 10) {
        safety++;
        const r = await fetch(url, { headers: SH_HEADERS });
        if (!r.ok) break;
        const d = await r.json();
        out.push(...(d.orders || []));
        const link = r.headers.get("Link") || "";
        const next = link.match(/<([^>]+)>;\s*rel="next"/);
        url = next ? next[1] : null;
      }
      return out;
    };

    // TOTAL: count de todos los pedidos pagados (TN o Shopify)
    if (tab === 'total') {
      if (platform === 'shopify') {
        const orders = await shopifyFetchOrders("financial_status=paid&fields=id");
        return res.status(200).json(Array.from({length: orders.length}, (_,i) => ({id:i})));
      }
      let total = 0;
      for (let p = 1; p <= 20; p++) {
        const page = await fetchPage(storeId, accessToken, "payment_status=paid,partially_paid,partially_refunded", p, 200);
        total += page.length;
        if (page.length < 200) break;
      }
      return res.status(200).json(Array.from({length: total}, (_,i) => ({id:i})));
    }

    // POR COBRAR: pedidos sin pagar
    if (tab === 'cobrar') {
      if (platform === 'shopify') {
        const orders = await shopifyFetchOrders("financial_status=pending,partially_paid");
        const filtered = orders.filter(o => !o.cancelled_at).map(shopifyToTNFormat);
        if (countOnly === 'true') return res.status(200).json(Array.from({length: filtered.length}, (_,i) => ({id:i})));
        return res.status(200).json(filtered);
      }
      const orders = await fetchAllPages(storeId, accessToken, "payment_status=pending,partially_paid&status=open");
      if (countOnly === 'true') return res.status(200).json(Array.from({length: orders.length}, (_,i) => ({id:i})));
      return res.status(200).json(orders);
    }

    // POR EMPAQUETAR: pagados, pendientes de fulfillment
    if (tab === 'empaquetar') {
      if (platform === 'shopify') {
        const orders = await shopifyFetchOrders("financial_status=paid&fulfillment_status=unfulfilled,partial");
        const filtered = orders.filter(o => !o.cancelled_at).map(shopifyToTNFormat);
        if (countOnly === 'true') return res.status(200).json(Array.from({length: filtered.length}, (_,i) => ({id:i})));
        return res.status(200).json(filtered);
      }
      const orders = await fetchAllPages(storeId, accessToken, "payment_status=paid&shipping_status=unpacked&status=open");
      if (countOnly === 'true') return res.status(200).json(Array.from({length: orders.length}, (_,i) => ({id:i})));
      return res.status(200).json(orders);
    }

    // POR ENVIAR: empaquetado, listo a enviar
    if (tab === 'enviar') {
      if (platform === 'shopify') {
        // Shopify no tiene "PACKED" — tomamos partial como ready-to-ship aproximado.
        const orders = await shopifyFetchOrders("financial_status=paid&fulfillment_status=partial");
        const filtered = orders.filter(o => !o.cancelled_at).map(shopifyToTNFormat);
        if (countOnly === 'true') return res.status(200).json(Array.from({length: filtered.length}, (_,i) => ({id:i})));
        return res.status(200).json(filtered);
      }
      const page1 = await fetchPage(storeId, accessToken, "payment_status=paid&status=open", 1, 200);
      const porEnviar = page1.filter(o => o.fulfillments?.some(f => f.status === 'PACKED'));
      if (countOnly === 'true') return res.status(200).json(Array.from({length: porEnviar.length}, (_,i) => ({id:i})));
      return res.status(200).json(porEnviar);
    }

    // ── Coupons (antiguo /api/coupons) ───────────────────────────────────
    if (action === 'coupons') {
      const { desde, hasta } = req.query;
      const tzOffset = "-0300";
      const desdeISO = desde ? `${desde}T00:00:00${tzOffset}` : null;
      const hastaISO = hasta ? `${hasta}T23:59:59${tzOffset}` : null;
      if (platform !== 'tiendanube') return res.status(200).json({ coupons: [], totalPedidosAnalizados: 0, periodo: { desde: desdeISO, hasta: hastaISO } });
      const tnHeaders = { 'Authentication': `bearer ${accessToken}`, 'User-Agent': 'GrowithApp (soluna.biolight@gmail.com)' };
      let allOrders = []; let page = 1;
      while (page <= 25) {
        let url = `https://api.tiendanube.com/v1/${storeId}/orders?payment_status=paid&per_page=200&page=${page}`;
        if (desdeISO) url += `&created_at_min=${encodeURIComponent(desdeISO)}`;
        if (hastaISO) url += `&created_at_max=${encodeURIComponent(hastaISO)}`;
        const r = await fetch(url, { headers: tnHeaders });
        if (!r.ok) break;
        const data = await r.json();
        if (!Array.isArray(data) || data.length === 0) break;
        allOrders = [...allOrders, ...data];
        if (data.length < 200) break;
        page++;
      }
      const couponMap = {};
      for (const o of allOrders) {
        const coupons = Array.isArray(o.coupon) ? o.coupon : [];
        for (const c of coupons) {
          const code = (c.code || "").toUpperCase().trim(); if (!code) continue;
          if (!couponMap[code]) couponMap[code] = { code, type: c.type||"percentage", value: c.value||"0", usosPeriodo: 0, ventasPeriodo: 0, descuentoPeriodo: 0 };
          couponMap[code].usosPeriodo++; couponMap[code].ventasPeriodo += parseFloat(o.total||0); couponMap[code].descuentoPeriodo += parseFloat(o.discount_coupon||0);
        }
      }
      return res.status(200).json({ coupons: Object.values(couponMap).sort((a,b) => b.usosPeriodo - a.usosPeriodo), totalPedidosAnalizados: allOrders.length, periodo: { desde: desdeISO, hasta: hastaISO } });
    }
    // ── fin Coupons ───────────────────────────────────────────────────────

    // Fallback: últimos pedidos pagados
    if (platform === 'shopify') {
      const orders = await shopifyFetchOrders("financial_status=paid");
      const mapped = orders.filter(o => !o.cancelled_at).map(shopifyToTNFormat);
      return res.status(200).json(mapped);
    }
    const orders = await fetchPage(storeId, accessToken, "", 1, 200);
    res.status(200).json(orders);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
