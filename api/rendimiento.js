// api/rendimiento.js — Growith Dashboard Financiero
// Revenue (TN/ML) + Meta Ads por día — con período anterior y análisis

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function initAdmin() {
  if (getApps().length > 0) return getFirestore();
  initializeApp({ credential: cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g,"\n").replace(/"/g,""),
  })});
  return getFirestore();
}

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

async function fetchMetaDailySpend(cfg, since, until) {
  if (!cfg?.access_token || !cfg.ad_account_id) return {};
  try {
    const res = await metaGet(`${cfg.ad_account_id}/insights`, {
      level: "account",
      fields: "spend,actions,action_values,purchase_roas,impressions,clicks,reach",
      "time_range[since]": since,
      "time_range[until]": until,
      time_increment: "1",
      action_attribution_windows: JSON.stringify(["1d_click","1d_view"]),
      limit: "90",
    }, cfg.access_token);
    const byDate = {};
    for (const row of (res.data || [])) {
      const date = row.date_start;
      if (!date) continue;
      byDate[date] = {
        spend:       parseFloat(row.spend) || 0,
        roas:        parseFloat((row.purchase_roas || [])[0]?.value) || 0,
        purchases:   parseFloat((row.actions || []).find(a => a.action_type==="purchase")?.value || 0),
        purchaseVal: parseFloat((row.action_values || []).find(a => a.action_type==="purchase")?.value || 0),
        impressions: parseInt(row.impressions) || 0,
        clicks:      parseInt(row.clicks) || 0,
        reach:       parseInt(row.reach) || 0,
      };
    }
    return byDate;
  } catch (e) {
    console.error("Meta daily spend error:", e.message);
    return {};
  }
}

// Build daily rows from revenue/orders/meta dictionaries
function buildRows(since, until, dailyRevenue, dailyOrders, metaDailySpend, commission) {
  const allDates = new Set([
    ...Object.keys(dailyRevenue),
    ...Object.keys(dailyOrders),
    ...Object.keys(metaDailySpend),
  ]);
  const start = new Date(since + "T12:00:00");
  const end   = new Date(until + "T12:00:00");
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1))
    allDates.add(d.toISOString().slice(0,10));

  return [...allDates].sort().map(date => {
    const revenue    = dailyRevenue[date] || 0;
    const orders     = dailyOrders[date]  || 0;
    const adSpend    = metaDailySpend[date]?.spend || 0;
    const netRevenue = revenue * (1 - commission);
    const profit     = netRevenue - adSpend;
    const roas       = adSpend > 0 ? revenue / adSpend : 0;
    const trueRoas   = adSpend > 0 ? netRevenue / adSpend : 0;
    const cpa        = orders > 0  ? adSpend / orders : 0;
    return {
      Fecha:           date,
      "Ordenes > $0":  orders,
      Revenue:         revenue,
      "Ad Spend":      adSpend,
      "Net Revenue":   parseFloat(netRevenue.toFixed(2)),
      Profit:          parseFloat(profit.toFixed(2)),
      "Profit Margin": revenue > 0 ? parseFloat((profit/revenue).toFixed(6)) : 0,
      ROAS:            parseFloat(roas.toFixed(4)),
      "True ROAS":     parseFloat(trueRoas.toFixed(4)),
      CPA:             parseFloat(cpa.toFixed(2)),
      _impressions:    metaDailySpend[date]?.impressions || 0,
      _clicks:         metaDailySpend[date]?.clicks || 0,
      _reach:          metaDailySpend[date]?.reach || 0,
    };
  });
}

function computeTotals(rows) {
  const t = rows.reduce((acc, r) => ({
    orders:     acc.orders     + (r["Ordenes > $0"] || 0),
    revenue:    acc.revenue    + (r.Revenue || 0),
    adSpend:    acc.adSpend    + (r["Ad Spend"] || 0),
    netRevenue: acc.netRevenue + (r["Net Revenue"] || 0),
    profit:     acc.profit     + (r.Profit || 0),
    impressions:acc.impressions+ (r._impressions || 0),
    clicks:     acc.clicks     + (r._clicks || 0),
  }), {orders:0,revenue:0,adSpend:0,netRevenue:0,profit:0,impressions:0,clicks:0});
  return {
    ...t,
    roas:        t.adSpend > 0 ? t.revenue / t.adSpend : 0,
    trueRoas:    t.adSpend > 0 ? t.netRevenue / t.adSpend : 0,
    cpa:         t.orders  > 0 ? t.adSpend / t.orders : 0,
    profitMargin:t.revenue > 0 ? t.profit / t.revenue : 0,
    ctr:         t.impressions > 0 ? t.clicks / t.impressions : 0,
  };
}

function computeDow(rows) {
  const DAYS = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
  const agg = Array.from({length:7}, (_,i) => ({dow:i, label:DAYS[i], revenue:0, adSpend:0, profit:0, orders:0, days:0}));
  rows.forEach(r => {
    const d = new Date(r.Fecha + "T12:00:00").getDay();
    agg[d].revenue  += r.Revenue || 0;
    agg[d].adSpend  += r["Ad Spend"] || 0;
    agg[d].profit   += r.Profit || 0;
    agg[d].orders   += r["Ordenes > $0"] || 0;
    agg[d].days++;
  });
  return agg.map(d => ({
    ...d,
    avgRevenue: d.days > 0 ? d.revenue / d.days : 0,
    avgProfit:  d.days > 0 ? d.profit  / d.days : 0,
    avgOrders:  d.days > 0 ? d.orders  / d.days : 0,
  }));
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = initAdmin();
  const { uid, action, days: daysQ, date_from, date_to } = req.query;
  if (!uid) return res.status(400).json({ error: "Falta uid" });

  // ── action=daily_metrics ────────────────────────────────────────────
  if (action === "daily_metrics") {
    try {
      const days    = parseInt(daysQ) || 30;
      const nowDate = new Date();
      const until   = date_to   || nowDate.toISOString().slice(0,10);
      const since   = date_from || new Date(nowDate - days * 86400000).toISOString().slice(0,10);

      // Previous period (same length, immediately before)
      const periodMs = new Date(until+"T23:59:59") - new Date(since+"T00:00:00");
      const prevUntilD = new Date(new Date(since+"T00:00:00") - 86400000);
      const prevSinceD = new Date(prevUntilD - periodMs);
      const prevSince  = prevSinceD.toISOString().slice(0,10);
      const prevUntil  = prevUntilD.toISOString().slice(0,10);

      // User config
      const userSnap = await db.collection("users").doc(uid).get();
      const userData = userSnap.data() || {};
      const stores   = userData.stores || [];
      const hasML    = stores.some(s => s.type === "meli");
      const commission = parseFloat(userData.rendimientoCommission) || (hasML ? 0.10 : 0.03);

      // Helper to fetch stock data for a range
      async function fetchStock(from, to) {
        try {
          const stockUrl = new URL(`https://${req.headers.host}/api/stock`);
          stockUrl.searchParams.set("uid", uid);
          stockUrl.searchParams.set("action", "products");
          stockUrl.searchParams.set("date_from", from);
          stockUrl.searchParams.set("date_to", to);
          const r = await fetch(stockUrl.toString(), { headers: { host: req.headers.host } });
          if (!r.ok) return { dailyRevenue:{}, dailyOrders:{} };
          const j = await r.json();
          return { dailyRevenue: j.daily_revenue||{}, dailyOrders: j.daily_orders||{} };
        } catch(_) { return { dailyRevenue:{}, dailyOrders:{} }; }
      }

      // Fetch current + previous + Meta in parallel
      const metaAccountsSnap = await db.collection("users").doc(uid).collection("meta_accounts").get();
      const metaAccounts = metaAccountsSnap.docs.map(d => d.data()).filter(a => a.access_token && a.ad_account_id);
      const metaCfg = metaAccounts[0] || null;

      const [curr, prev, metaCurr, metaPrev] = await Promise.all([
        fetchStock(since, until),
        fetchStock(prevSince, prevUntil),
        metaCfg ? fetchMetaDailySpend(metaCfg, since, until) : Promise.resolve({}),
        metaCfg ? fetchMetaDailySpend(metaCfg, prevSince, prevUntil) : Promise.resolve({}),
      ]);

      // Build rows
      const rows     = buildRows(since, until, curr.dailyRevenue, curr.dailyOrders, metaCurr, commission);
      const prevRows = buildRows(prevSince, prevUntil, prev.dailyRevenue, prev.dailyOrders, metaPrev, commission);

      const totals     = computeTotals(rows);
      const prevTotals = computeTotals(prevRows);
      const byDow      = computeDow(rows);

      const hasMetaData  = Object.keys(metaCurr).length > 0;
      const hasStoreData = Object.keys(curr.dailyRevenue).length > 0;

      return res.json({
        rows, prevRows,
        totals, prevTotals,
        byDow,
        since, until,
        prevSince, prevUntil,
        meta: { hasMetaData, hasStoreData, commission, metaAccountsCount: metaAccounts.length },
      });
    } catch (e) {
      console.error("Dashboard error:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── action=save_config ───────────────────────────────────────────────
  if (action === "save_config" && req.method === "POST") {
    const body = await new Promise(resolve => {
      let d = "";
      req.on("data", c => d += c);
      req.on("end", () => resolve(JSON.parse(d || "{}")));
    });
    await db.collection("users").doc(uid).update({ rendimientoCommission: parseFloat(body.commission) || 0.03 });
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: "Acción no reconocida" });
}
