// api/_snapshot.js — snapshot DETERMINISTA del negocio (el prefijo "_" hace que
// Vercel no lo exponga como endpoint). Lo usan el Copilot (api/copilot.js) y el
// conector de ChatGPT/Claude (api/mcp.js): todas las cifras salen de cálculos
// que Growith ya hizo y guardó en Firestore — la IA nunca genera números.
//
// Todo sale de Firestore (rápido, sin llamadas a APIs externas salvo la lista
// de campañas de Meta). Si algo falta, el bloque devuelve null.

export const n2 = (v) => (typeof v === "number" && isFinite(v)) ? +v.toFixed(2) : 0;

export function resumenDeRows(rows, desdeIdx) {
  // rows del caché de Márgenes: keys tipo "Fecha", "Revenue", "Ad Spend", "Profit"
  const slice = desdeIdx != null ? rows.slice(desdeIdx) : rows;
  const acc = { dias: slice.length, ordenes: 0, facturacion: 0, pauta: 0, ganancia: 0 };
  for (const r of slice) {
    acc.ordenes += r["Ordenes > $0"] || r.orders || 0;
    acc.facturacion += r.Revenue || r.revenue || 0;
    acc.pauta += r["Ad Spend"] || r.adSpend || 0;
    acc.ganancia += r.Profit ?? r.profit ?? 0;
  }
  acc.facturacion = n2(acc.facturacion); acc.pauta = n2(acc.pauta); acc.ganancia = n2(acc.ganancia);
  acc.margen_pct = acc.facturacion > 0 ? n2(acc.ganancia / acc.facturacion * 100) : 0;
  return acc;
}

export async function snapshotMargenes(db, uid, topN = 12) {
  try {
    const snap = await db.collection("users").doc(uid).collection("margenes_cache").doc("d30").get();
    if (!snap.exists) return null;
    const doc = snap.data();
    const m = JSON.parse(doc.body || "{}");
    const rows = Array.isArray(m.rows) ? m.rows : [];
    const hoyIso = new Date().toISOString().slice(0, 10);
    const idxHoy = rows.findIndex(r => (r.Fecha || r.fecha) === hoyIso);
    const t = m.totals || {};
    return {
      datos_al: doc.cachedAt || null,
      periodo: { desde: m.since, hasta: m.until },
      ultimos_30_dias: {
        facturacion: n2(t.revenue), ordenes: t.orders || 0,
        pauta_total: n2(t.adSpend), pauta_meta: n2(t.adSpendMeta), pauta_ml: n2(t.adSpendMl),
        ganancia_neta: n2(t.profit), margen_pct: n2((t.profitMargin || 0) * 100),
        roas: n2(t.roas), true_roas: n2(t.trueRoas), cpa: n2(t.cpa),
        roas_break_even: n2(t.breakEvenRoas),
      },
      ultimos_7_dias: resumenDeRows(rows, Math.max(0, rows.length - 7)),
      ayer: (() => {
        // "ayer" = anteúltima fila si la última es hoy; si no, la última.
        const r = rows[rows.length - (idxHoy >= 0 ? 2 : 1)];
        if (!r) return null;
        return { fecha: r.Fecha || r.fecha, facturacion: n2(r.Revenue || 0), pauta: n2(r["Ad Spend"] || 0), ganancia: n2(r.Profit ?? 0), ordenes: r["Ordenes > $0"] || 0 };
      })(),
      por_canal: m.byChannel || null,
      top_productos: (m.byProduct || []).slice(0, topN).map(p => ({
        producto: p.nombre || p.name || p.key, canal: p.canal || null,
        facturacion: n2(p.revenue), ganancia: n2(p.profit),
        margen_pct: n2((p.margin || 0) * 100), unidades: p.units || 0,
        sin_costo_configurado: !!p.sinCogs,
      })),
      clientes: m.clientes || null,
      cashflow_mercadopago: m.cashflow || null,
      dolar: m.dolarActual || null,
      calidad_del_dato: m.quality || null,
      metas_configuradas: null, // se llena desde el user doc
    };
  } catch (e) {
    console.warn("[copilot] snapshotMargenes:", e.message);
    return null;
  }
}

export async function snapshotEnvios(db, uid) {
  try {
    const desde = new Date(Date.now() - 60 * 86400000).toISOString();
    const snap = await db.collection("users").doc(uid).collection("envios")
      .where("creado", ">=", desde).get();
    const envios = snap.docs.map(d => d.data());
    if (envios.length === 0) return { total_60d: 0 };
    const activos = envios.filter(e => e.activo);
    const porCat = {};
    for (const e of envios) porCat[e.categoria || "sin_categoria"] = (porCat[e.categoria || "sin_categoria"] || 0) + 1;
    const dias = iso => iso ? Math.floor((Date.now() - Date.parse(iso)) / 86400000) : null;
    const alertas = [];
    for (const e of activos) {
      if (e.categoria === "en_sucursal" && dias(e.enSucursalDesde) >= 3)
        alertas.push(`#${e.numero} en sucursal hace ${dias(e.enSucursalDesde)} días sin retirar`);
      if (e.categoria === "visita_fallida") alertas.push(`#${e.numero} con visita fallida`);
      if (e.categoria === "devolucion") alertas.push(`#${e.numero} volviendo (devolución)`);
      const dEst = dias(e.estadoDesde || e.despachadoAt);
      if ((e.categoria === "en_camino" || e.categoria === "desconocido") && dEst >= 7)
        alertas.push(`#${e.numero} sin movimiento hace ${dEst} días`);
    }
    const entregados30 = envios.filter(e => e.entregadoAt && dias(e.entregadoAt) <= 30);
    const tiempos = entregados30.filter(e => e.despachadoAt)
      .map(e => (Date.parse(e.entregadoAt) - Date.parse(e.despachadoAt)) / 86400000)
      .filter(d => d >= 0 && d < 40);
    return {
      total_60d: envios.length,
      activos_en_seguimiento: activos.length,
      por_categoria: porCat,
      alertas: alertas.slice(0, 10),
      entregados_ultimos_30d: entregados30.length,
      dias_promedio_despacho_a_entrega: tiempos.length ? n2(tiempos.reduce((a, b) => a + b, 0) / tiempos.length) : null,
    };
  } catch (e) {
    console.warn("[copilot] snapshotEnvios:", e.message);
    return null;
  }
}

export async function snapshotStock(db, uid) {
  try {
    const [itemsSnap, userSnap, cacheSnap] = await Promise.all([
      db.collection("users").doc(uid).collection("inventory_items").get(),
      db.collection("users").doc(uid).get(),
      db.collection("users").doc(uid).collection("stock_cache").doc("d7").get(),
    ]);
    const settings = userSnap.data()?.inventory_settings || {};
    const umbral = settings.alert_global || 14;
    const items = itemsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const cache = cacheSnap.exists ? cacheSnap.data().data : null;
    const variantes = [];
    if (cache?.products) {
      for (const p of cache.products) for (const v of (p.variants || [])) {
        const rate = (v.units_sold || 0) / 7;
        variantes.push({
          producto: p.nombre, variante: v.nombre, sku: v.sku || null,
          stock_tienda: v.stock, vendidos_7d: v.units_sold || 0,
          dias_restantes: rate > 0 ? Math.round(v.stock / rate) : null,
        });
      }
      variantes.sort((a, b) => (a.dias_restantes ?? 9999) - (b.dias_restantes ?? 9999));
    }
    if (items.length === 0 && variantes.length === 0) return null;
    return {
      umbral_alerta_dias: umbral,
      stock_cruzado_modo: settings.sync_mode || "off",
      // Inventario central de Growith (item_id sirve para la acción ajustar_stock)
      inventario_central: items.slice(0, 40).map(i => ({
        item_id: i.id, nombre: i.nombre, sku: i.sku || null,
        stock: Math.max(0, i.stock_total || 0), canales: i.canales || [],
      })),
      // Stock y velocidad por variante según la tienda (últimos 7 días)
      por_variante_7d: variantes.slice(0, 40),
      alertas: variantes.filter(v => v.stock_tienda === 0 || (v.dias_restantes != null && v.dias_restantes <= umbral)).slice(0, 15),
    };
  } catch (e) {
    console.warn("[copilot] snapshotStock:", e.message);
    return null;
  }
}

export async function snapshotCuentas(db, uid) {
  try {
    const [userSnap, metaSnap] = await Promise.all([
      db.collection("users").doc(uid).get(),
      db.collection("users").doc(uid).collection("meta_accounts").get(),
    ]);
    const u = userSnap.data() || {};
    return {
      tiendas: (u.stores || []).map(s => ({ tipo: s.type, nombre: s.name || s.store_name || null })),
      cuits_arca: (u.cuits || []).length,
      meta_ads: metaSnap.docs.map(d => {
        const a = d.data();
        return { acc_id: d.id, nombre: a.user_name, cuenta_publicitaria: a.ad_account_name || null, token_vencido: !!a.token_invalid, tiene_token: !!a.access_token };
      }),
      // Campañas de Meta (para que el Copilot pueda proponer pausar/activar con
      // ids REALES — nunca inventados). Primera cuenta con token, máx 25.
      campanas_meta: await (async () => {
        try {
          const accDoc = metaSnap.docs.find(d => d.data().access_token && d.data().ad_account_id);
          if (!accDoc) return null;
          const a = accDoc.data();
          const r = await fetch(`https://graph.facebook.com/v23.0/${a.ad_account_id}/campaigns?fields=id,name,status,daily_budget&limit=25&access_token=${encodeURIComponent(a.access_token)}`, { signal: AbortSignal.timeout(10000) });
          if (!r.ok) return null;
          const j = await r.json();
          return (j.data || []).map(c => ({ acc_id: accDoc.id, id: c.id, nombre: c.name, estado: c.status, presupuesto_diario: c.daily_budget ? +(c.daily_budget/100).toFixed(0) : null }));
        } catch (_) { return null; }
      })(),
      metas_margenes: u.margenesMetas || null,
      // Colaboradores del equipo (para la acción crear_tarea — emails REALES)
      colaboradores: await (async () => {
        try {
          const cs = await db.collection("colaboradores").where("uid", "==", uid).limit(20).get();
          return cs.docs.map(d => ({ nombre: d.data().nombre || "", email: d.data().email || "" })).filter(c => c.email);
        } catch (_) { return []; }
      })(),
    };
  } catch (e) {
    console.warn("[copilot] snapshotCuentas:", e.message);
    return null;
  }
}

// Qué está listo y qué falta en la cuenta — alimenta la "configuración guiada"
// del Copilot y el resumen del conector: el modelo ve el estado sin inventar.
export function estadoConfiguracion(margenes, cuentas, stock) {
  return {
    tienda_conectada: !!(cuentas?.tiendas || []).find(t => t.tipo === "tiendanube" || t.tipo === "shopify"),
    mercado_libre_conectado: !!(cuentas?.tiendas || []).find(t => t.tipo === "mercadolibre"),
    meta_ads: (cuentas?.meta_ads || []).length
      ? (cuentas.meta_ads.some(a => a.tiene_token && !a.token_vencido) ? "conectada" : "token_vencido")
      : "sin_conectar",
    arca_facturacion: (cuentas?.cuits_arca || 0) > 0 ? "configurada" : "sin_configurar",
    margenes_calculados: !!margenes,
    productos_sin_costo_cargado: margenes ? (margenes.top_productos || []).filter(p => p.sin_costo_configurado).length : null,
    stock_activado: !!stock,
    colaboradores_en_equipo: (cuentas?.colaboradores || []).length,
  };
}
