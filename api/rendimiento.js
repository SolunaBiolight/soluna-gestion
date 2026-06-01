// api/rendimiento.js — Growith Rendimiento / Financial Dashboard
// Combina: stock diario (TN/Shopify/ML) + Meta Ads diario
// Devuelve métricas por día: Revenue, Órdenes, Ad Spend, ROAS, CPA, Net Revenue

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

// Fetch Meta ad spend per day for the given date range
async function fetchMetaDailySpend(cfg, since, until) {
  if (!cfg?.access_token || !cfg.ad_account_id) return {};
  try {
    const res = await metaGet(`${cfg.ad_account_id}/insights`, {
      level: "account",
      fields: "spend,actions,action_values,purchase_roas,impressions,clicks",
      "time_range[since]": since,
      "time_range[until]": until,
      time_increment: "1",         // 1 = daily breakdown
      action_attribution_windows: JSON.stringify(["1d_click","1d_view"]),
      limit: "90",
    }, cfg.access_token);

    const byDate = {};
    for (const row of (res.data || [])) {
      const date = row.date_start; // YYYY-MM-DD
      if (!date) continue;
      const spend = parseFloat(row.spend) || 0;
      const roas = parseFloat((row.purchase_roas || [])[0]?.value) || 0;
      const purchases = (row.actions || []).find(a => a.action_type === "purchase")?.value || 0;
      const purchaseValue = (row.action_values || []).find(a => a.action_type === "purchase")?.value || 0;
      const impressions = parseInt(row.impressions) || 0;
      const clicks = parseInt(row.clicks) || 0;
      byDate[date] = { spend, roas, purchases: parseFloat(purchases), purchaseValue: parseFloat(purchaseValue), impressions, clicks };
    }
    return byDate;
  } catch (e) {
    console.error("Meta daily spend error:", e.message);
    return {};
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const db = initAdmin();
  const { uid, action, days: daysQ, date_from, date_to } = req.query;
  if (!uid) return res.status(400).json({ error: "Falta uid" });

  // ── action=daily_metrics ────────────────────────────────────────────
  if (action === "daily_metrics") {
    try {
      // Date range
      const days = parseInt(daysQ) || 30;
      const now = new Date();
      const until = date_to || now.toISOString().slice(0,10);
      const since = date_from || new Date(now - days * 86400000).toISOString().slice(0,10);

      // Load user doc to get stores + Meta accounts
      const userSnap = await db.collection("users").doc(uid).get();
      const userData = userSnap.data() || {};
      const stores = userData.stores || [];
      const primaryStore = stores.find(s => s.type === "tiendanube") || stores.find(s => s.type === "shopify");
      const mlStore = stores.find(s => s.type === "meli");

      // 1. Fetch stock daily data from existing stock endpoint (internal call)
      const stockUrl = new URL(`https://${req.headers.host}/api/stock`);
      stockUrl.searchParams.set("uid", uid);
      stockUrl.searchParams.set("action", "products");
      stockUrl.searchParams.set("date_from", since);
      stockUrl.searchParams.set("date_to", until);
      let dailyRevenue = {}, dailyOrders = {}, totalRevenue = 0, totalOrders = 0;
      try {
        const stockRes = await fetch(stockUrl.toString(), { headers: { host: req.headers.host } });
        if (stockRes.ok) {
          const stockJson = await stockRes.json();
          dailyRevenue = stockJson.daily_revenue || {};
          dailyOrders  = stockJson.daily_orders  || {};
          totalRevenue = stockJson.total_revenue  || 0;
          totalOrders  = stockJson.total_orders   || 0;
        }
      } catch (e) {
        console.error("Stock fetch error:", e.message);
      }

      // 2. Fetch Meta daily ad spend
      let metaDailySpend = {};
      const metaAccountsSnap = await db.collection("users").doc(uid).collection("meta_accounts").get();
      const metaAccounts = metaAccountsSnap.docs.map(d => d.data()).filter(a => a.access_token && a.ad_account_id);
      if (metaAccounts.length > 0) {
        // Use first active Meta account
        const metaCfg = metaAccounts[0];
        metaDailySpend = await fetchMetaDailySpend(metaCfg, since, until);
      }

      // 3. Build commission rate (configurable, stored in user doc, default 15% for ML, 3% for TN)
      const commissionRate = parseFloat(userData.rendimientoCommission) || 0.03;
      // If has ML, use a weighted average (ML ~15%, TN ~3%)
      const hasML = !!mlStore;
      const effectiveCommission = hasML ? 0.10 : commissionRate;

      // 4. Merge by date
      const allDates = new Set([
        ...Object.keys(dailyRevenue),
        ...Object.keys(dailyOrders),
        ...Object.keys(metaDailySpend),
      ]);

      // Generate all dates in range
      const start = new Date(since + "T12:00:00");
      const end = new Date(until + "T12:00:00");
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        allDates.add(d.toISOString().slice(0,10));
      }

      const sortedDates = [...allDates].sort();
      const rows = sortedDates.map(date => {
        const revenue    = dailyRevenue[date] || 0;
        const orders     = dailyOrders[date]  || 0;
        const adSpend    = metaDailySpend[date]?.spend || 0;
        const metaRoas   = metaDailySpend[date]?.roas || 0;
        const netRevenue = revenue * (1 - effectiveCommission);
        const profit     = netRevenue - adSpend;
        const profitMargin = revenue > 0 ? profit / revenue : 0;
        const roas       = adSpend > 0 ? revenue / adSpend : 0;
        const trueRoas   = adSpend > 0 ? netRevenue / adSpend : 0;
        const cpa        = orders > 0 ? adSpend / orders : 0;
        return {
          Fecha:           date,
          "Ordenes > $0":  orders,
          Revenue:         revenue,
          "Ad Spend":      adSpend,
          "Net Revenue":   parseFloat(netRevenue.toFixed(2)),
          Profit:          parseFloat(profit.toFixed(2)),
          "Profit Margin": parseFloat(profitMargin.toFixed(6)),
          ROAS:            parseFloat(roas.toFixed(4)),
          "True ROAS":     parseFloat(trueRoas.toFixed(4)),
          CPA:             parseFloat(cpa.toFixed(2)),
          // Extra fields
          _metaRoas:       metaRoas,
          _metaImpressions: metaDailySpend[date]?.impressions || 0,
          _metaClicks:     metaDailySpend[date]?.clicks || 0,
        };
      });

      // 5. Compute totals row
      const totals = rows.reduce((t, r) => ({
        orders:     t.orders + r["Ordenes > $0"],
        revenue:    t.revenue + r.Revenue,
        adSpend:    t.adSpend + r["Ad Spend"],
        netRevenue: t.netRevenue + r["Net Revenue"],
        profit:     t.profit + r.Profit,
      }), { orders: 0, revenue: 0, adSpend: 0, netRevenue: 0, profit: 0 });

      const hasMetaData = Object.keys(metaDailySpend).length > 0;
      const hasStoreData = Object.keys(dailyRevenue).length > 0;

      return res.json({
        rows,
        since,
        until,
        totals: {
          ...totals,
          roas:   totals.adSpend > 0 ? totals.revenue / totals.adSpend : 0,
          trueRoas: totals.adSpend > 0 ? totals.netRevenue / totals.adSpend : 0,
          cpa:    totals.orders > 0   ? totals.adSpend / totals.orders : 0,
          profitMargin: totals.revenue > 0 ? totals.profit / totals.revenue : 0,
        },
        meta: { hasMetaData, hasStoreData, effectiveCommission, metaAccountsCount: metaAccounts.length },
      });
    } catch (e) {
      console.error("Rendimiento error:", e);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── action=save_config — guardar comisión ────────────────────────────
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
