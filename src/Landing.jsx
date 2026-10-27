// src/Landing.jsx — landing pública de marketing (sale de App.jsx el 27/oct/2026 para que cargue
// liviana: src/main.jsx la muestra sola a quien llega sin sesión y la app se baja recién al tocar
// "Iniciar sesión" / "Probar gratis"). App.jsx la sigue usando desde PublicSite.
import React, { useState, useEffect, useMemo, useRef } from "react";
import { PUBLICADORES_ARCHIVADOS, META_OAUTH_OK, BrandIcon, RecurrentesLogo, IA_ICONS, GhI } from "./shared.jsx";

// ── GH_LANDING_MOTION_BEGIN ──────────────────────────────────────────────
// Sistema de movimiento de la landing (27-sept-2026): portado del de Recurrentes,
// con el contenido de Growith. Todo CSS/SVG/DOM, cero dependencias nuevas:
//   · reveal al entrar en pantalla → IntersectionObserver (useGhReveal), con
//     MutationObserver para lo que se monta después y un barrido de seguridad
//     por rAF (saltos de scroll, celular, pestaña oculta).
//   · progreso de scroll 0..1 en la CSS var --p (useGhScrollProgress).
//   · el hero rota tres facetas (Inicio → Pendientes → Dashboard) con flip 3D,
//     zoom con desenfoque y cortina (GhHeroLoop).
// prefers-reduced-motion: todo queda quieto, visible y en su lugar.
// Prefijo gh-lm- para no chocar con nada de la app.
function GhMotionStyle({T}) {
  const F = "'Inter',system-ui,sans-serif";
  return (
    <style>{`
      /* Reveal al entrar en pantalla (el observer pone .is-in). */
      [data-reveal]{opacity:0;transform:translateY(22px);transition:opacity .7s cubic-bezier(.22,1,.36,1),transform .7s cubic-bezier(.22,1,.36,1);}
      [data-reveal="left"]{transform:translateX(-32px);}
      [data-reveal="right"]{transform:translateX(32px);}
      [data-reveal="scale"]{transform:scale(.96);}
      /* Cada sección entra distinto: swing, flip, pop, tilt, rise, wipe, spin. */
      [data-reveal="swing"]{transform:translate(48px,56px) rotate(5deg) scale(.94);transform-origin:100% 100%;transition-duration:.65s;}
      [data-reveal="flip"]{transform:perspective(900px) rotateX(-18deg) translateY(40px);transform-origin:50% 100%;}
      [data-reveal="pop"]{transform:scale(.72);transition-timing-function:cubic-bezier(.34,1.56,.64,1);transition-duration:.55s;}
      [data-reveal="tilt"]{transform:translateX(-56px) rotate(-3deg);transform-origin:0 100%;}
      [data-reveal="rise"]{transform:translateY(72px) scale(.98);transition-duration:.8s;}
      [data-reveal="wipe"]{transform:none;clip-path:inset(0 100% 0 0 round 14px);transition:clip-path .8s cubic-bezier(.22,1,.36,1),opacity .4s;}
      [data-reveal="spin"]{transform:translate(60px,60px) rotate(12deg) scale(.8);transform-origin:100% 100%;transition-duration:.7s;}
      [data-reveal].is-in{opacity:1;transform:none;}
      [data-reveal="wipe"].is-in{clip-path:inset(0 0 0 0 round 14px);}
      [data-reveal-delay="1"]{transition-delay:.08s}[data-reveal-delay="2"]{transition-delay:.16s}[data-reveal-delay="3"]{transition-delay:.24s}[data-reveal-delay="4"]{transition-delay:.32s}
      [data-reveal-delay="5"]{transition-delay:.4s}[data-reveal-delay="6"]{transition-delay:.48s}
      /* ── Hero: tres facetas apiladas, la caja mide siempre lo mismo ── */
      .gh-lm-stage{position:relative;perspective:1200px;min-width:0;max-width:100%;display:grid;}
      .gh-lm-face{grid-area:1/1;min-width:0;max-width:100%;align-self:stretch;}
      .gh-lm-face > *{height:100%;}
      .gh-lm-face.is-hidden{visibility:hidden;pointer-events:none;}
      .gh-lm-face.is-out{pointer-events:none;z-index:2;}
      .gh-lm-in-flip{animation:ghLmInFlip .75s cubic-bezier(.22,1,.36,1) both;transform-origin:50% 50%;}
      .gh-lm-out-flip{animation:ghLmOutFlip .75s cubic-bezier(.22,1,.36,1) both;transform-origin:50% 50%;}
      @keyframes ghLmInFlip{from{opacity:0;transform:rotateY(-70deg) translateX(60px)}to{opacity:1;transform:none}}
      @keyframes ghLmOutFlip{from{opacity:1;transform:none}to{opacity:0;transform:rotateY(60deg) translateX(-80px)}}
      .gh-lm-in-zoom{animation:ghLmInZoom .8s cubic-bezier(.22,1,.36,1) both;}
      .gh-lm-out-zoom{animation:ghLmOutZoom .6s ease both;}
      @keyframes ghLmInZoom{from{opacity:0;transform:scale(.6) translateY(80px);filter:blur(14px)}to{opacity:1;transform:none;filter:blur(0)}}
      @keyframes ghLmOutZoom{from{opacity:1;transform:none;filter:blur(0)}to{opacity:0;transform:scale(1.15);filter:blur(10px)}}
      .gh-lm-in-wipe{animation:ghLmInWipe .8s cubic-bezier(.22,1,.36,1) both;}
      .gh-lm-out-wipe{animation:ghLmOutWipe .7s cubic-bezier(.22,1,.36,1) both;}
      @keyframes ghLmInWipe{from{clip-path:inset(100% 0 0 0 round 14px);transform:translateY(30px)}to{clip-path:inset(0 0 0 0 round 14px);transform:none}}
      @keyframes ghLmOutWipe{from{clip-path:inset(0 0 0 0 round 14px);opacity:1}to{clip-path:inset(0 0 100% 0 round 14px);opacity:.4}}
      .gh-lm-dots{display:flex;gap:6px;justify-content:center;margin-top:16px;}
      .gh-lm-dots > i{width:24px;height:3px;border-radius:99px;background:${T.border};overflow:hidden;position:relative;}
      .gh-lm-dots > i.on::after{content:"";position:absolute;inset:0;background:${T.accentSolid};transform-origin:0 50%;animation:ghLmDot var(--dur,6s) linear both;}
      @keyframes ghLmDot{from{transform:scaleX(0)}to{transform:scaleX(1)}}
      .gh-lm-facelabel{text-align:center;font-size:12px;color:${T.textSm};margin-top:8px;font-family:${F};}
      /* Subrayado que se pinta al entrar la sección. */
      .gh-lm-hi{position:relative;color:${T.text};font-weight:600;background-image:linear-gradient(120deg,${T.accentSolid}55,${T.accentSolid}55);background-repeat:no-repeat;background-size:0% 38%;background-position:0 88%;transition:background-size .6s cubic-bezier(.22,1,.36,1);transition-delay:var(--d,0s);padding:0 2px;border-radius:3px;}
      .is-in .gh-lm-hi{background-size:100% 38%;}
      /* Parallax suave donde el navegador lo soporte (Chrome/Edge). */
      @supports (animation-timeline: view()) {
        .gh-lm-float{animation:ghLmFloat linear both;animation-timeline:view();animation-range:entry 0% exit 100%;}
        @keyframes ghLmFloat{from{transform:translateY(24px)}to{transform:translateY(-24px)}}
      }
      /* Barra de progreso del scroll de la página (usa --p). */
      .gh-lm-progress{position:fixed;left:0;top:0;height:2px;width:100%;z-index:60;background:transparent;pointer-events:none;}
      .gh-lm-progress > i{display:block;height:100%;width:calc(var(--p,0) * 100%);background:${T.accentSolid};}
      /* ── Marquee de integraciones ── */
      .gh-lm-marquee{overflow:hidden;-webkit-mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);mask-image:linear-gradient(90deg,transparent,#000 8%,#000 92%,transparent);}
      .gh-lm-marquee-row{display:flex;gap:28px;width:max-content;animation:ghLmMarquee 42s linear infinite;}
      .gh-lm-marquee:hover .gh-lm-marquee-row{animation-play-state:paused;}
      @keyframes ghLmMarquee{to{transform:translateX(-50%)}}
      @media (prefers-reduced-motion: reduce){
        [data-reveal]{opacity:1;transform:none;transition:none;clip-path:none;}
        [data-reveal="wipe"]{clip-path:none;}
        .gh-lm-in-flip,.gh-lm-out-flip,.gh-lm-in-zoom,.gh-lm-out-zoom,.gh-lm-in-wipe,.gh-lm-out-wipe{animation:none;}
        .gh-lm-face.is-out{display:none;}
        .gh-lm-dots > i.on::after{animation:none;transform:none;}
        .gh-lm-float{animation:none;}
        .gh-lm-hi{background-size:100% 38%;transition:none;}
        .gh-lm-marquee-row{animation:none;flex-wrap:wrap;width:auto;justify-content:center;}
        .gh-lm-marquee{-webkit-mask-image:none;mask-image:none;}
        .gh-lm-progress{display:none;}
      }
    `}</style>
  );
}

// Marca .is-in cuando cada [data-reveal] entra en pantalla. Una sola vez.
function useGhReveal(rootRef) {
  useEffect(() => {
    // Raíz SIEMPRE document: el efecto corre antes de que exista el <div ref>
    // (el hook se llama arriba del return), así que rootRef.current es null en
    // la primera pasada y el efecto no se reejecuta nunca —el objeto ref no
    // cambia de identidad—. El ref queda por compatibilidad de firma.
    //
    // El motor es ÚNICO y global (window.__ghRevealOn): si la landing se
    // desmonta y se vuelve a montar (cambios de ruta del sitio público), el
    // efecto anterior limpiaba sus listeners y el reveal quedaba muerto — la
    // página entera invisible. Con el motor global eso no puede pasar: se
    // instala una sola vez y sobrevive a los montajes.
    if (typeof window === "undefined") return;
    if (window.__ghRevealOn) { window.__ghRevealKick?.(); return; }
    window.__ghRevealOn = true;

    const VIS = 0.92;
    let raf = 0;
    // Barrido: revela lo que ya entró en pantalla O quedó por encima. Sin límite
    // inferior a propósito: lo de arriba ya pasó por pantalla y tiene que verse
    // (entrar por un ancla, refrescar a mitad de página, restauración de scroll).
    const sweep = () => {
      raf = 0;
      const vh = window.innerHeight || 1;
      document.querySelectorAll("[data-reveal]:not(.is-in)").forEach(e => {
        if (e.getBoundingClientRect().top < vh * VIS) e.classList.add("is-in");
      });
    };
    const kick = () => { if (!raf) raf = requestAnimationFrame(sweep); };
    window.__ghRevealKick = kick;

    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((ents) => {
        for (const en of ents) if (en.isIntersecting) { en.target.classList.add("is-in"); io.unobserve(en.target); }
      }, { threshold: 0.18, rootMargin: "0px 0px -8% 0px" });
      const seen = new WeakSet();
      const scan = () => document.querySelectorAll("[data-reveal]:not(.is-in)").forEach(e => {
        if (!seen.has(e)) { seen.add(e); io.observe(e); }
      });
      scan();
      // Lo que se monta después (secciones nuevas, FAQ que se abre) también entra.
      if ("MutationObserver" in window) {
        new MutationObserver(() => { scan(); kick(); }).observe(document.body, { childList: true, subtree: true });
      }
    } else {
      document.querySelectorAll("[data-reveal]").forEach(e => e.classList.add("is-in"));
    }

    window.addEventListener("scroll", kick, { passive: true });
    window.addEventListener("resize", kick);
    window.addEventListener("load", kick);
    document.addEventListener("visibilitychange", kick);
    // Barridos escalonados: fuentes e imágenes mueven el layout, y en mobile la
    // landing pasa de ~14.000 a ~22.000 px de alto.
    [60, 200, 500, 1000, 2000].forEach(ms => setTimeout(kick, ms));
    kick();
    // Sin cleanup a propósito: el motor es global y tiene que seguir vivo
    // aunque este componente se desmonte.
  }, []);
}

// Progreso 0..1 del scroll dentro del elemento: 0 arriba, 1 abajo. Se escribe en
// la CSS var --p del propio nodo (sin re-render de React).
function useGhScrollProgress(ref, {enabled = true} = {}) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || 1;
      const total = Math.max(1, r.height - vh);
      const p = Math.min(1, Math.max(0, -r.top / total));
      el.style.setProperty("--p", p.toFixed(4));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => { window.removeEventListener("scroll", onScroll); window.removeEventListener("resize", onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [ref, enabled]);
}

function useGhMedia(query) {
  const [m, setM] = useState(() => typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener ? mq.addEventListener("change", on) : mq.addListener(on);
    return () => { mq.removeEventListener ? mq.removeEventListener("change", on) : mq.removeListener(on); };
  }, [query]);
  return m;
}
const useGhReduced = () => useGhMedia("(prefers-reduced-motion: reduce)");

// Hero: tres facetas de la app real (Inicio, Pendientes, Dashboard) que van
// pasando, cada pasaje con una transición distinta (flip 3D · zoom con
// desenfoque · cortina). Las tres están SIEMPRE montadas y apiladas, así la caja
// mantiene el mismo tamaño y nada se corta.
function GhHeroLoop({T, facetas}) {
  const reduce = useGhReduced();
  const [i, setI] = useState(0);
  const [prev, setPrev] = useState(null); // {i, trans} la faceta que sale
  useEffect(() => { if (prev == null) return; const t = setTimeout(() => setPrev(null), 800); return () => clearTimeout(t); }, [prev]);
  useEffect(() => {
    if (reduce) return;
    const dur = facetas[i]?.dur || 7000;
    const t = setTimeout(() => setI(cur => { const n = (cur + 1) % facetas.length; setPrev({i: cur, trans: facetas[n].trans}); return n; }), dur);
    return () => clearTimeout(t);
  }, [i, reduce, facetas]);
  const cur = facetas[i];
  return (
    <div style={{position:"relative"}}>
      <div style={{position:"absolute",inset:-40,background:`radial-gradient(circle at 55% 25%, ${T.accentSolid}26 0%, transparent 62%)`,filter:"blur(30px)",pointerEvents:"none"}} aria-hidden="true"/>
      <div className="gh-lm-stage">
        {facetas.map((f, k) => {
          const esActual = k === i, sale = prev != null && prev.i === k && !reduce;
          const cls = "gh-lm-face " + (esActual ? (prev && !reduce ? "gh-lm-in-" + cur.trans : "") : sale ? "is-out gh-lm-out-" + prev.trans : "is-hidden");
          return <div key={f.key} className={cls} aria-hidden={!esActual}>{f.render()}</div>;
        })}
      </div>
      <div className="gh-lm-dots" aria-hidden="true">{facetas.map((f, k) => <i key={f.key} className={k === i ? "on" : ""} style={{"--dur":((f.dur||7000)/1000)+"s"}}/>)}</div>
      <div className="gh-lm-facelabel">{cur.label} · datos de ejemplo</div>
    </div>
  );
}
// ── GH_LANDING_MOTION_END ────────────────────────────────────────────────

export function LandingPage({T, onLogin}) {
  const F = "'Inter',system-ui,sans-serif";
  const [faqAbierta,setFaqAbierta] = useState(0);
  // Movimiento de la landing (ver GH_LANDING_MOTION): el reveal por sección y el
  // progreso del scroll de la página entera en la CSS var --p de la raíz.
  const landRef = useRef(null);
  useGhReveal(landRef);
  useGhScrollProgress(landRef);
  // ── Sistema visual de la landing: una sola familia tipográfica, un solo
  // acento, bordes finos, sin brillos ni degradados. Cada sección respira lo
  // mismo (104 px) y se separa con una línea, no con fondos de colores.
  const ink = T.text, ink2 = T.textMd, ink3 = T.textSm, line = T.border, lineL = T.borderL;
  const WRAP = {maxWidth:1120, margin:"0 auto", padding:"0 24px"};
  const SEC = {padding:"104px 0", borderTop:`1px solid ${lineL}`};
  const kicker = (txt, c) => <div style={{display:"flex",alignItems:"center",gap:8,fontSize:12,fontWeight:600,letterSpacing:0.6,textTransform:"uppercase",color:ink3,marginBottom:14,fontFamily:F}}>{c&&<span style={{width:6,height:6,borderRadius:3,background:c,display:"inline-block"}}/>}{txt}</div>;
  const h2 = (txt, opts={}) => <h2 style={{fontSize:"clamp(28px,3.6vw,40px)",fontWeight:700,letterSpacing:-0.9,lineHeight:1.12,color:ink,margin:"0 0 14px",maxWidth:opts.center?720:640,textAlign:opts.center?"center":"left",marginLeft:opts.center?"auto":0,marginRight:opts.center?"auto":0,fontFamily:F}}>{txt}</h2>;
  const sub = (txt, opts={}) => <p style={{fontSize:16.5,color:ink2,lineHeight:1.6,margin:opts.center?"0 auto":"0",maxWidth:opts.center?600:560,textAlign:opts.center?"center":"left",fontFamily:F}}>{txt}</p>;
  // El encabezado de cada sección entra con la variante que le toque (opts.rev).
  const head = (k, t, s, opts={}) => <div data-reveal={opts.rev||"rise"} style={{marginBottom:opts.mb??56}}>{kicker(k, opts.c)}{h2(t,opts)}{s&&<div style={{marginTop:14}}>{sub(s,opts)}</div>}</div>;
  const Check = ({c}) => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={c||ink3} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0,marginTop:3}}><path d="M5 12.5l4.2 4L19 7"/></svg>;
  const lista = (items, c) => <div style={{display:"flex",flexDirection:"column",gap:10}}>{items.map(x=><div key={x} style={{display:"flex",gap:10,fontSize:14.5,color:ink,lineHeight:1.5}}><Check c={c}/>{x}</div>)}</div>;
  const btnPri = (label, onClick, big) => <button onClick={onClick} style={{background:T.accentSolid,border:`1px solid ${T.accentSolid}`,color:"#fff",borderRadius:10,fontSize:big?15:13.5,fontWeight:600,padding:big?"13px 22px":"8px 14px",cursor:"pointer",fontFamily:F,lineHeight:1.2}}>{label}</button>;
  const btnSec = (label, onClick, big) => <button onClick={onClick} style={{background:"transparent",border:`1px solid ${line}`,color:ink,borderRadius:10,fontSize:big?15:13.5,fontWeight:600,padding:big?"13px 22px":"8px 14px",cursor:"pointer",fontFamily:F,lineHeight:1.2}}>{label}</button>;
  const irA = (id) => { try{document.getElementById(id)?.scrollIntoView({behavior:"smooth"});}catch(_){} };
  // Íconos de marca: BrandIcon + TikTok (mismo trazo del menú) + las IAs (IA_ICONS, pantalla de permiso)
  const TIKTOK_PATH = "M16.5 3c.3 2.4 1.7 3.9 4 4.1v3.1c-1.5 0-2.9-.5-4-1.3v6.4c0 3.3-2.7 5.9-6 5.9s-6-2.6-6-5.9 2.7-5.9 6-5.9c.3 0 .7 0 1 .1v3.2c-.3-.1-.6-.2-1-.2-1.5 0-2.8 1.2-2.8 2.8s1.3 2.8 2.8 2.8 2.8-1.2 2.8-2.8V3h3.2z";
  const marca = (b, s=18) => b==="tiktok" ? <svg width={s} height={s} viewBox="0 0 24 24"><path d={TIKTOK_PATH} fill="#EE1D52"/></svg>
    : b==="pagonube" ? <svg width={s} height={s} viewBox="0 0 24 24"><path d="M7 18.5h10.5a4.2 4.2 0 00.7-8.35A6.2 6.2 0 006.3 9.2 4.7 4.7 0 007 18.5z" fill="#3b82f6"/><path d="M12 10.2v5.6M13.8 11.3c-.4-.5-1-.8-1.8-.8-1 0-1.7.5-1.7 1.2 0 1.6 3.6.8 3.6 2.5 0 .8-.8 1.3-1.9 1.3-.9 0-1.6-.3-2-.9" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" fill="none"/></svg>
    : b==="pagospers" ? <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6.5 15h4"/></svg>
    : b==="recurrentes" ? <RecurrentesLogo size={s}/>
    : IA_ICONS[b] ? React.cloneElement(IA_ICONS[b], {width:s, height:s})
    : <BrandIcon name={b} size={b==="andreani"?s+4:s}/>;
  const chip = (b, s=18, box=32) => <span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:box,height:box,borderRadius:8,background:T.surface,border:`1px solid ${lineL}`,flexShrink:0}}>{marca(b,s)}</span>;
  const pronto = <span style={{fontSize:10,fontWeight:600,color:ink3,border:`1px solid ${line}`,borderRadius:6,padding:"1px 6px",letterSpacing:0.3,textTransform:"uppercase",whiteSpace:"nowrap"}}>Pronto</span>;
  // Vista de ejemplo de una sección: una ventana plana, con título y sin adornos.
  const ventana = (titulo, hijos) => (
    <div style={{background:T.card,border:`1px solid ${line}`,borderRadius:12,overflow:"hidden"}}>
      <div style={{display:"flex",alignItems:"center",padding:"10px 16px",borderBottom:`1px solid ${lineL}`}}>
        <span style={{fontSize:12,color:ink2,fontWeight:600}}>{titulo}</span>
        <span style={{marginLeft:"auto",fontSize:10,color:ink3,letterSpacing:0.4,textTransform:"uppercase"}}>Datos de ejemplo</span>
      </div>
      <div style={{padding:"14px 16px"}}>{hijos}</div>
    </div>
  );
  const estado = (txt, c) => <span style={{fontSize:11,fontWeight:600,color:c,whiteSpace:"nowrap",display:"inline-flex",alignItems:"center",gap:6}}><span style={{width:6,height:6,borderRadius:3,background:c,display:"inline-block"}}/>{txt}</span>;
  const filaMock = (izq, der, extra) => (
    <div style={{display:"flex",alignItems:"center",gap:10,padding:"9px 0",borderTop:`1px solid ${lineL}`,fontSize:12.5}}>
      {extra}
      <span style={{flex:1,minWidth:0,color:ink2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{izq}</span>
      {der}
    </div>
  );

  // Mini-Inicio del hero (números de demo, no reales) — refleja la pantalla de Inicio real
  const HERO_KPIS = [
    {l:"Facturado", v:"$ 12,4M", d:"Este mes", c:T.text},
    {l:"Pedidos", v:"486", d:"Este mes", c:T.text},
    {l:"Reclamos abiertos", v:"2", d:"Requieren atención", c:T.red},
    {l:"Stock crítico", v:"3", d:"Productos en alerta", c:T.red},
  ];
  const HERO_PEND = [
    ["Reclamos","Cambio de talle · pedido #1463","Responder",T.red],
    ["Envíos","#1475 en sucursal hace 4 días","Ver envío",T.orange],
    ["Stock","Producto A · Negro: quedan 4 días","Reponer",T.yellow],
    ["Canjes","Contenido de @creadora vence mañana","Ver canje","#E1306C"],
  ];
  // Tercera faceta del hero: el Dashboard de márgenes (números de demo).
  const HERO_DASH = [
    ["Facturación","$ 12.430.000",T.text],
    ["Costo de mercadería","− $ 4.980.000",T.textMd],
    ["Comisiones y envíos","− $ 1.910.000",T.textMd],
    ["Publicidad","− $ 2.140.000",T.textMd],
  ];
  const HERO_CANALES = [["Tienda Nube","62%",62],["Mercado Libre","29%",29],["Shopify","9%",9]];
  const MARQUEE = [["tiendanube","Tienda Nube"],["shopify","Shopify"],["mercadolibre","Mercado Libre"],["mercadopago","Mercado Pago"],["pagonube","Pago Nube"],["pagospers","Pagos personalizados"],["recurrentes","Recurrentes",true],["meta","Meta Ads"],["googleads","Google Ads"],["andreani","Andreani"],["arca","ARCA"],["Claude","Claude"],["ChatGPT","ChatGPT"],["Gemini","Gemini"]];

  // ── Hoy: el negocio repartido en pestañas ──
  const PESTANAS = ["Admin de la tienda","Mercado Libre","Portal de Andreani","ARCA","Administrador de anuncios","Planilla de stock","WhatsApp con influencers","Notas con los pagos del mes","Mails de reclamos","Excel de costos","App de ganancias"];

  // ── El menú real de Growith, por área ──
  const AREAS = [
    {t:"Finanzas", c:"#6366f1", items:[
      {gi:"chart", n:"Dashboard", d:"Facturación, costos y ganancia del período, por canal."},
      {gi:"calendar", n:"P&L mensual", d:"El resultado de cada mes, listo para tu contador."},
      {gi:"file", n:"Facturador", d:"Facturas electrónicas de ARCA desde tus ventas."},
    ]},
    {t:"Analytics", c:"#3b82f6", items:[
      {gi:"play", n:"Meta Ads", d:META_OAUTH_OK?"Campañas, análisis y el gasto directo en tu profit. Se conecta en un clic con Facebook.":"Campañas, análisis y el gasto directo en tu profit."},
      {gi:"box", n:"Stock", d:"Inventario de todos tus canales y alertas de quiebre."},
      {gi:"store", n:"Mercado Libre", d:"Gestión, preguntas, mensajes, ventas y reputación."},
      {gi:"search", n:"Google Ads", d:"Campañas de tus cuentas de Google, activas y pausadas."},
    ]},
    {t:"Operaciones", c:"#f97316", items:[
      {gi:"clip", n:"Envíos", d:"Etiquetas Andreani, SKU en rótulos y seguimientos."},
      {gi:"alert", n:"Reclamos", d:"Reclamos, cambios y devoluciones en un tablero."},
      {gi:"camera", n:"Canjes", d:"Influencers, envíos, contenido y comisiones por cupón."},
      {gi:"check", n:"Tareas", d:"Tareas del equipo con briefs, entregas y fechas."},
      {gi:"clock", n:"Calendario de pagos", d:"Alquiler, proveedores, cuotas y tarjetas, con aviso."},
    ]},
    // Los publicadores de PAUTA (Meta/Google/TikTok) están archivados: Meta
    // rechazó ads_management y sin ese permiso no se puede escribir en ninguna
    // cuenta publicitaria. No se anuncian features que no se pueden cumplir.
    {t:"Publicar", c:"#22c55e", items:[
      {gi:"upload", n:"Publicar en Mercado Libre", d:"Publicaciones nuevas en tu cuenta de Mercado Libre."},
      ...(PUBLICADORES_ARCHIVADOS ? [] : [
        {gi:"upload", n:"Publicar en Meta", d:"Subí creativos y armá campañas sin salir de Growith."},
        {gi:"upload", n:"Publicar en TikTok", d:"Campañas con tus videos.", soon:true},
        {gi:"upload", n:"Publicar en Google", d:"Campañas de Búsqueda y Performance Max."},
      ]),
    ]},
  ];

  // ── Cada módulo en detalle (texto + vista de ejemplo, alternados) ──
  const MODULOS = [
    {k:"Finanzas", c:"#6366f1", gi:"calendar", t:"Tus números y tus pagos, ordenados",
      d:"El Dashboard te muestra facturación, costos y ganancia por canal, y el Calendario de pagos te recuerda lo que tenés que pagar antes de que venza.",
      b:["Dashboard por período y por canal","P&L mensual","Calendario de pagos: alquiler, proveedores, préstamos, cuotas y tarjetas","Aviso por mail el día anterior y el día del vencimiento","Comprobantes de pago guardados en cada obligación"], mock:"pagos"},
    {k:"Facturación", c:"#eab308", gi:"file", t:"Facturás sin copiar datos a mano",
      d:"Growith toma las ventas de tu tienda y de Mercado Libre y emite las facturas en ARCA, con CAE, PDF y QR oficial.",
      b:["Facturación automática de tus órdenes","Facturas y notas de crédito manuales","Monotributo y Responsable Inscripto","Varios CUITs y puntos de venta","La factura queda adjunta a la venta"], mock:"factura"},
    {k:"Publicidad", c:"#3b82f6", gi:"play", t:"Tus campañas de Meta y Google en un solo lugar",
      d:PUBLICADORES_ARCHIVADOS?"Mirá cómo viene cada campaña de Meta y Google contra tu break-even, con el gasto ya descontado de tu ganancia, sin entrar a cada administrador de anuncios.":"Mirá cómo viene cada campaña, pausala o activala y publicá campañas nuevas sin entrar a cada administrador de anuncios.",
      b:["Análisis de campañas de Meta Ads y Google Ads",...(META_OAUTH_OK?["Meta se conecta en un clic con Facebook"]:[]),"ROAS por campaña contra tu break-even","El gasto publicitario entra solo a tus números"], mock:"campanas"},
    {k:"Stock", c:"#22c55e", gi:"box", t:"Un solo stock para Tienda Nube, Shopify y Mercado Libre",
      d:"Un inventario central por producto y variante, para saber qué tenés, qué se está por agotar y cuándo reponer.",
      b:["Stock unificado por SKU entre todos tus canales","Alerta cuando a un producto le quedan pocos días","Días de reposición por producto","Historial de agotados"], mock:"stock"},
    {k:"Mercado Libre", c:"#facc15", gi:"store", t:"Tu cuenta de Mercado Libre, sin abrir Mercado Libre",
      d:"Preguntas, mensajes, ventas y reputación en el mismo lugar que el resto del negocio, con el contador de preguntas en el menú.",
      b:["Respondé preguntas y mensajes desde Growith","Tus ventas de Mercado Libre junto a las de tu tienda","Reputación y métricas de la cuenta","Publicaciones nuevas desde Publicar en ML"], mock:"ml"},
    {k:"Envíos", c:"#f97316", gi:"clip", t:"Etiquetas de Andreani con saldo, sin contrato propio",
      d:"Cargás saldo y emitís las etiquetas de Andreani desde tus pedidos, a domicilio, a sucursal o a un punto HOP, sin tener cuenta en Andreani. Growith sigue cada paquete hasta que llega y los que se traban aparecen solos en tu Inicio.",
      b:["Etiquetas prepagas: cargás saldo con Mercado Pago o transferencia y emitís al instante","Ves el precio de cada etiqueta antes de emitir y tu envío promedio","Si te equivocás, la anulás en los primeros 30 minutos y el saldo vuelve al instante","Con el SKU impreso en el rótulo, listas para imprimir en tanda","Sucursal de retiro bien elegida, sin adivinar","Seguimiento automático y avisos al comprador por mail","Alertas de envíos demorados, en sucursal o con visita fallida","Gestiones con Andreani desde la ficha de cada envío","Andreani en el checkout de tu Shopify"], mock:"envios"},
    {k:"Reclamos", c:"#ef4444", gi:"alert", t:"Ningún reclamo ni cambio se pierde",
      d:"Un tablero con cada reclamo, cambio o devolución y en qué etapa está. También los reclamos de Mercado Libre y los contracargos de Mercado Pago.",
      b:["Tablero por etapas: nuevo, en gestión, enviado, resuelto","Seguimiento del envío de ida y de vuelta","Reclamos de Mercado Libre y contracargos de Mercado Pago aparte","Respondés al comprador desde Growith","Historial de todo lo resuelto"], mock:"reclamos"},
  ];
  const mockDe = (m) => {
    if (m==="envios") return ventana("Envíos · Seguimientos", <div>
      {[["#1482 · Córdoba","Entregado",T.green],["#1479 · CABA","En camino",T.blue],["#1475 · Rosario","En sucursal hace 4 días",T.orange],["#1471 · Mendoza","Visita fallida",T.red]].map(([p,e,c])=>(
        <div key={p}>{filaMock(p, estado(e,c), chip("andreani",14,26))}</div>
      ))}
      <div style={{fontSize:10.5,color:T.textSm,marginTop:8}}>Al comprador le llega el aviso solo · a vos, el resumen del día</div>
    </div>);
    if (m==="stock") return ventana("Stock · Alertas", <div>
      {[["Producto A · Negro","12 u.","4 días",T.red,15],["Producto A · Blanco","48 u.","16 días",T.orange,45],["Producto B · Único","130 u.","41 días",T.green,85],["Producto C · Talle M","0 u.","Agotado",T.red,2]].map(([n,u,d,c,w])=>(
        <div key={n} style={{padding:"8px 0",borderTop:`1px solid ${T.borderL}`}}>
          <div style={{display:"flex",fontSize:12,marginBottom:5}}><span style={{flex:1,color:T.textMd}}>{n}</span><span style={{fontWeight:700,marginRight:10}}>{u}</span><span style={{fontWeight:800,color:c,width:62,textAlign:"right"}}>{d}</span></div>
          <div style={{height:5,borderRadius:4,background:T.bg}}><div style={{height:"100%",width:`${w}%`,borderRadius:4,background:c}}/></div>
        </div>
      ))}
      <div style={{fontSize:10.5,color:T.textSm,marginTop:8}}>Stock sumado de Tienda Nube, Shopify y Mercado Libre</div>
    </div>);
    if (m==="reclamos") return ventana("Reclamos · Tablero", <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
      {[["Nuevo",T.red,["Cambio de talle","Llegó dañado"]],["En gestión",T.orange,["Devolución #1440"]],["Resuelto",T.green,["Cambio #1421","Reenvío #1418"]]].map(([col,c,cards])=>(
        <div key={col} style={{background:T.bg,border:`1px solid ${T.borderL}`,borderRadius:10,padding:8,minWidth:0}}>
          <div style={{fontSize:9.5,fontWeight:800,color:c,textTransform:"uppercase",letterSpacing:0.5,marginBottom:6}}>{col} · {cards.length}</div>
          {cards.map(x=><div key={x} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:7,padding:"6px 7px",fontSize:11,color:T.textMd,marginBottom:5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{x}</div>)}
        </div>
      ))}
    </div>);
    if (m==="ml") return ventana("Mercado Libre · Preguntas", <div>
      {[["¿Tienen en color negro?","Respondida",T.green],["¿Llega antes del viernes?","Sin responder · 2 h",T.orange],["¿Hacen factura A?","Sin responder · 20 min",T.orange]].map(([p,e,c])=>(
        <div key={p}>{filaMock(p, estado(e,c))}</div>
      ))}
      <div style={{display:"flex",gap:8,marginTop:10}}>
        {[["Reputación","Verde"],["Preguntas hoy","14"],["Ventas hoy","9"]].map(([l,v])=>(
          <div key={l} style={{flex:1,background:T.bg,border:`1px solid ${T.borderL}`,borderRadius:9,padding:"6px 8px"}}><div style={{fontSize:9.5,color:T.textSm}}>{l}</div><div style={{fontSize:13,fontWeight:800}}>{v}</div></div>
        ))}
      </div>
    </div>);
    if (m==="campanas") return ventana("Publicidad · Campañas", <div>
      {[["meta","Prospección · Video","Activa",T.green],["googleads","Búsqueda · Marca","Activa",T.green],["meta","Remarketing 30 días","Pausada",T.textSm],["googleads","Performance Max","Activa",T.green]].map(([b,n,e,c],i)=>(
        <div key={i}>{filaMock(n, estado(e,c), chip(b,13,24))}</div>
      ))}
      <div style={{fontSize:10.5,color:T.textSm,marginTop:8}}>{PUBLICADORES_ARCHIVADOS?"Cada campaña con su ROAS contra tu break-even":"Pausás o activás cada campaña desde acá"}</div>
    </div>);
    if (m==="factura") return ventana("Facturador · ARCA", <div>
      {[["Factura B 0004-00001812","$ 58.900"],["Factura B 0004-00001811","$ 23.400"],["Factura A 0004-00000418","$ 112.000"],["Nota de crédito 0004-00000094","− $ 23.400"]].map(([f,mto])=>(
        <div key={f}>{filaMock(f, <span style={{display:"flex",gap:10,alignItems:"center"}}><span style={{fontWeight:700,color:T.text}}>{mto}</span><span style={{fontWeight:800,color:T.green}}>CAE ✓</span></span>)}</div>
      ))}
      <div style={{display:"flex",alignItems:"center",gap:8,marginTop:10}}>{chip("arca",16,28)}<span style={{fontSize:10.5,color:T.textSm}}>PDF con QR oficial, adjunto a la venta</span></div>
    </div>);
    return ventana("Calendario de pagos · Esta semana", <div>
      {[["Mañana","Alquiler del depósito","$ 850.000",T.orange],["Jueves","Proveedor de packaging","$ 320.000",T.textMd],["Viernes","Cuota del préstamo · 4/12","$ 410.000",T.textMd],["Vencido","Tarjeta corporativa","$ 1.240.000",T.red]].map(([d,n,mto,c])=>(
        <div key={n}>{filaMock(n, <span style={{fontWeight:700,color:T.text}}>{mto}</span>, <span style={{width:58,fontSize:10.5,fontWeight:800,color:c}}>{d}</span>)}</div>
      ))}
      <div style={{fontSize:10.5,color:T.textSm,marginTop:8}}>Te llega un mail el día anterior y el día del vencimiento</div>
    </div>);
  };

  const AVISOS = [
    {gi:"clip", c:"#f97316", t:"Envíos trabados", d:"Resumen diario por mail con los envíos demorados, en sucursal o con visita fallida. Al comprador le avisamos solos."},
    {gi:"box", c:"#22c55e", t:"Stock por agotarse", d:"Alerta cuando a un producto le quedan pocos días de stock, con el umbral que vos elijas."},
    {gi:"clock", c:"#6366f1", t:"Pagos por vencer", d:"Mail el día anterior y el mismo día de cada vencimiento, y un resumen los lunes."},
    {gi:"alert", c:"#ef4444", t:"Reclamos y preguntas", d:"Contadores en el menú: ves cuántos reclamos, preguntas de Mercado Libre y tareas te esperan."},
    {gi:"check", c:"#14b8a6", t:"Tareas por vencer", d:"Aviso por mail a quien tiene la tarea asignada antes de la fecha de entrega."},
    {gi:"ban", c:"#a855f7", t:"Etiquetas sin usar", d:"Las etiquetas de Andreani que nunca se despacharon se anulan solas a los días que elijas."},
  ];
  const DIA = [
    ["08:30","Abrís el Inicio","Ves lo facturado, los pedidos y todo lo pendiente del día, ordenado por área.","eye"],
    ["09:00","Abrís el Dashboard","Ves la ganancia de ayer y cómo viene arrancando hoy, por canal.","chart"],
    ["10:00","Despachás","Etiquetas Andreani con el SKU impreso, listas para imprimir en tanda.","clip"],
    ["11:30","Respondés","Preguntas de Mercado Libre y reclamos, sin abrir otra pestaña.","chat"],
    ["13:00","Facturás","Las ventas del día se facturan en ARCA sin copiar un solo dato.","file"],
    ["16:00","Revisás campañas",PUBLICADORES_ARCHIVADOS?"Mirás cómo vienen Meta y Google y ves cuál deja ganancia y cuál no.":"Mirás cómo vienen Meta y Google y pausás la que no funciona.","play"],
    ["18:00","Reponés stock","La alerta te avisó que a un producto le quedan 4 días.","box"],
    ["19:00","Mirás la semana","El Calendario de pagos te muestra qué vence mañana.","calendar"],
  ];
  const CATEGORIAS = [
    {t:"Tiendas", d:"Pedidos, productos, stock y clientes.", items:[["tiendanube","Tienda Nube"],["shopify","Shopify"],["mercadolibre","Mercado Libre"]]},
    {t:"Publicidad", d:"Campañas y gasto publicitario.", items:[["meta","Meta Ads"],["googleads","Google Ads"],["mercadolibre","Mercado Ads"]]},
    {t:"Pagos", d:"Comisiones reales de cada medio de cobro, cobros y contracargos.", items:[["mercadopago","Mercado Pago"],["pagonube","Pago Nube"],["pagospers","Pagos personalizados"],["recurrentes","Recurrentes",true]]},
    {t:"Logística", d:"Etiquetas, sucursales y seguimiento.", items:[["andreani","Andreani"]]},
    {t:"Facturación", d:"Factura electrónica con CAE y QR.", items:[["arca","ARCA"]]},
    {t:"Inteligencia artificial", d:"Consultá tu negocio desde la IA que ya usás.", items:[["Claude","Claude"],["ChatGPT","ChatGPT"],["Gemini","Gemini"]]},
  ];
  const EQUIPO = [
    {gi:"users", t:"Tu equipo, con permisos por sección", d:"Sumá personas a tu cuenta y elegí qué ve cada una: el que despacha ve Envíos, el de atención ve Reclamos."},
    {gi:"link", t:"Portal para colaboradores", d:"Diseñadores, editores o influencers reciben sus tareas con brief y fecha, y entregan desde su propio portal, sin crear cuenta."},
    {gi:"folder", t:"Varias tiendas, un solo login", d:"Manejá más de una marca y pasá de una a otra desde el menú. Cada tienda tiene sus datos, sus conexiones y su equipo."},
    {gi:"lock", t:"Conexiones oficiales", d:"Tus tiendas y cuentas publicitarias se conectan con el acceso oficial de cada plataforma, y las desconectás cuando quieras."},
  ];
  const FAQ = [
    ["¿Necesito tarjeta para probar?","No. Tenés 14 días gratis con todas las funciones, sin cargar ninguna tarjeta. Si te sirve, elegís un plan."],
    ["¿Qué veo apenas entro?","El Inicio: lo facturado y los pedidos del período, los reclamos abiertos, el stock crítico y todos los pendientes ordenados por área. Cada cosa te lleva con un clic a donde se resuelve."],
    ["¿Con qué plataformas se conecta?","Tienda Nube, Shopify, Mercado Libre, Mercado Pago, Pago Nube, pagos personalizados, Meta Ads, Google Ads, Andreani y ARCA. Recurrentes llega muy pronto. Además podés consultar tu negocio desde Claude, ChatGPT o Gemini."],
    ["¿Sirve si vendo solo en Mercado Libre?","Sí. Podés conectar solo Mercado Libre y usar preguntas, mensajes, ventas, reputación, stock, reclamos y facturación. Si después sumás una tienda, se integra al resto."],
    ["¿La facturación sirve para Monotributo y Responsable Inscripto?","Sí. Growith emite comprobantes electrónicos en ARCA con CAE, PDF y QR, para Monotributo y Responsable Inscripto, con varios CUITs y puntos de venta."],
    ["¿Mi equipo puede usarlo?","Sí. Sumás personas y elegís qué secciones ve cada una. Para colaboradores externos hay un portal propio de tareas, sin crear cuenta."],
    ["¿Puedo manejar varias tiendas?","Sí. Con un solo login manejás varias marcas y cambiás de una a otra desde el menú. Cada tienda adicional suma entre USD 5 y USD 15 por mes, según el plan."],
    ["¿Cómo funciona lo de Claude, ChatGPT o Gemini?","Agregás Growith como conector en la IA que ya usás, autorizás con tu cuenta y le preguntás por ventas, campañas, stock o envíos. Solo puede leer: no cambia nada de tu cuenta."],
    ["¿Hay permanencia?","No. Cancelás cuando quieras desde la sección Suscripción."],
    ["¿En cuánto tiempo está funcionando?","En minutos: conectás tu tienda y Growith empieza a traer tus pedidos. Al principio, una configuración guiada te lleva paso a paso por lo que falta."],
    ["¿Tienen soporte?","Sí, en español y con gente que conoce el e-commerce argentino. Escribinos a contacto.growith@gmail.com."],
  ];
  const NAV = [["Secciones","gh-landing-features"],["Cómo funciona","gh-landing-modulos"],["Integraciones","gh-landing-integraciones"],["Precios","gh-landing-precios"],["Preguntas","gh-landing-faq"]];
  const PLANES_L = [
    {n:"Facturador", d:"Solo el facturador ARCA, ilimitado", p:19, antes:29, anual:16, b:["Facturación ARCA ilimitada","Facturación automática de órdenes de tu tienda y Mercado Libre","Facturas y notas de crédito manuales","Monotributo y Responsable Inscripto","Varios CUITs y puntos de venta"]},
    {n:"Intermedio", d:"Toda la gestión de tu e-commerce", p:39, antes:59, anual:32, rec:true, b:["Todo lo del plan Facturador","Meta Ads y Mercado Ads","Stock cruzado entre canales","Mercado Libre integrado","Envíos con etiquetas Andreani","Reclamos, Canjes y Tareas ilimitados"]},
    {n:"Pro", d:"Todo Growith para tu e-commerce", p:69, antes:99, anual:57, b:["Todo lo del plan Intermedio","Dashboard de rentabilidad en tiempo real","Tu profit real por venta: costos, comisiones y publicidad"]},
  ];
  // La caja del hero: misma ventana plana para las tres facetas (título, chip de
  // período y el contenido que cambia). Alto mínimo fijo para que no salte.
  const ventanaHero = (titulo, periodo, hijos) => (
    <div style={{background:T.card,border:`1px solid ${line}`,borderRadius:14,overflow:"hidden",boxShadow:"0 30px 80px -40px rgba(0,0,0,0.6)",height:"100%",display:"flex",flexDirection:"column",minHeight:322}}>
      <div style={{display:"flex",alignItems:"center",padding:"12px 18px",borderBottom:`1px solid ${lineL}`}}>
        <span style={{fontSize:12,color:ink2,fontWeight:600}}>{titulo}</span>
        <span style={{marginLeft:"auto",fontSize:11,color:ink3,border:`1px solid ${lineL}`,borderRadius:6,padding:"2px 8px"}}>{periodo}</span>
      </div>
      <div style={{flex:1,minHeight:0}}>{hijos}</div>
    </div>
  );
  const heroFacetas = [
    {key:"kpis", trans:"flip", label:"Inicio · lo facturado y los pedidos", dur:7000, render:()=>ventanaHero("Inicio","Este mes",
      <div>
        <div className="gh-land-kpis" style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:0,borderBottom:`1px solid ${lineL}`}}>
          {HERO_KPIS.map((k,i)=>(
            <div key={k.l} style={{padding:"18px 20px",borderLeft:i?`1px solid ${lineL}`:"none"}}>
              <div style={{fontSize:12,color:ink3,fontWeight:500,marginBottom:6}}>{k.l}</div>
              <div style={{fontSize:24,fontWeight:700,letterSpacing:-0.8,color:k.c,lineHeight:1}}>{k.v}</div>
              <div style={{fontSize:11.5,color:ink3,marginTop:6}}>{k.d}</div>
            </div>
          ))}
        </div>
        <div style={{padding:"16px 20px 18px"}}>
          <div style={{fontSize:12.5,fontWeight:600,marginBottom:10}}>Ventas por canal</div>
          {HERO_CANALES.map(([n,pct,w])=>(
            <div key={n} style={{marginBottom:9}}>
              <div style={{display:"flex",fontSize:12,color:ink2,marginBottom:4}}><span style={{flex:1}}>{n}</span><span style={{fontWeight:600,color:ink}}>{pct}</span></div>
              <div style={{height:5,borderRadius:4,background:T.bg}}><div style={{height:"100%",width:`${w}%`,borderRadius:4,background:T.accentSolid}}/></div>
            </div>
          ))}
        </div>
      </div>)},
    {key:"pend", trans:"zoom", label:"Inicio · todo lo pendiente del día", dur:7500, render:()=>ventanaHero("Inicio · Pendientes","Hoy",
      <div style={{padding:"14px 20px 18px"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
          <span style={{fontSize:12.5,fontWeight:600}}>Pendientes</span>
          <span style={{fontSize:11,fontWeight:600,color:ink3}}>{HERO_PEND.length}</span>
        </div>
        {HERO_PEND.map(([cat,txt,acc,c])=>(
          <div key={txt} style={{display:"flex",alignItems:"center",gap:12,padding:"11px 0",borderTop:`1px solid ${lineL}`,fontSize:13}}>
            <span style={{width:6,height:6,borderRadius:3,background:c,flexShrink:0}}/>
            <span style={{width:70,fontSize:11.5,fontWeight:600,color:ink3,flexShrink:0}}>{cat}</span>
            <span style={{flex:1,minWidth:0,color:ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{txt}</span>
            <span style={{fontSize:12,fontWeight:600,color:T.accent,whiteSpace:"nowrap"}}>{acc} →</span>
          </div>
        ))}
        <div style={{fontSize:11,color:ink3,marginTop:12}}>Un clic en cada línea y estás resolviendo</div>
      </div>)},
    {key:"dash", trans:"wipe", label:"Dashboard · tu ganancia real", dur:7000, render:()=>ventanaHero("Dashboard · Márgenes","Este mes",
      <div style={{padding:"16px 20px 18px"}}>
        {HERO_DASH.map(([l,v,c])=>(
          <div key={l} style={{display:"flex",alignItems:"center",padding:"10px 0",borderTop:`1px solid ${lineL}`,fontSize:13}}>
            <span style={{flex:1,color:ink2}}>{l}</span>
            <span style={{fontWeight:600,color:c,fontVariantNumeric:"tabular-nums"}}>{v}</span>
          </div>
        ))}
        <div style={{display:"flex",alignItems:"center",padding:"14px 0 4px",borderTop:`1px solid ${line}`,marginTop:4}}>
          <span style={{flex:1,fontSize:13.5,fontWeight:600}}>Ganancia</span>
          <span style={{fontSize:22,fontWeight:700,letterSpacing:-0.8,color:T.green,fontVariantNumeric:"tabular-nums"}}>$ 3.400.000</span>
        </div>
        <div style={{display:"flex",gap:8,marginTop:12}}>
          {[["Margen","27,4%"],["Ticket promedio","$ 25.580"],["ROAS","3,1x"]].map(([l,v])=>(
            <div key={l} style={{flex:1,background:T.bg,border:`1px solid ${lineL}`,borderRadius:9,padding:"7px 9px"}}>
              <div style={{fontSize:9.5,color:ink3}}>{l}</div><div style={{fontSize:14,fontWeight:700}}>{v}</div>
            </div>
          ))}
        </div>
      </div>)},
  ];
  // Las dos columnas entran por lados opuestos; la mock con su propia variante.
  const split = (izq, der, invert, rev) => (
    <div className="gh-land-row" style={{display:"grid",gridTemplateColumns:"minmax(0,5fr) minmax(0,6fr)",gap:64,alignItems:"center"}}>
      <div data-reveal={invert?"right":"left"} style={{order:invert?2:1}}>{izq}</div>
      <div data-reveal={rev||(invert?"tilt":"swing")} className="gh-land-mock" style={{order:invert?1:2}}>{der}</div>
    </div>
  );
  return (
    <div ref={landRef} style={{fontFamily:F, background:T.bg, minHeight:"100vh", color:ink, WebkitFontSmoothing:"antialiased"}}>
      <GhMotionStyle T={T}/>
      <div className="gh-lm-progress" aria-hidden="true"><i/></div>
      <style>{`
        .gh-land-row{}
        @media(max-width:900px){ .gh-land-row{grid-template-columns:1fr!important;gap:32px!important;} .gh-land-row>.gh-land-mock{order:2!important;} .gh-land-row>div:first-child{order:1!important;} .gh-land-g4{grid-template-columns:repeat(2,1fr)!important;} .gh-land-g3{grid-template-columns:1fr!important;} .gh-land-g2{grid-template-columns:1fr!important;} .gh-land-antes{grid-template-columns:1fr!important;} .gh-land-foot{grid-template-columns:1fr 1fr!important;} .gh-land-stats{grid-template-columns:1fr!important;} }
        @media(max-width:600px){ .gh-land-g4{grid-template-columns:1fr!important;} .gh-land-kpis{grid-template-columns:repeat(2,1fr)!important;} .gh-land-kpis>div:nth-child(3){border-left:none!important;} .gh-land-kpis>div{border-top:1px solid ${lineL};} .gh-land-hide-m{display:none!important;} .gh-land-dia{grid-template-columns:56px 1fr!important;} .gh-land-hero{padding-top:64px!important;} .gh-land-sec{padding:72px 0!important;} }
        @media(max-width:1000px){ .gh-land-navlink{display:none!important;} }
        .gh-land-navlink{color:${ink2};} .gh-land-navlink:hover{color:${ink};}
        .gh-land-logo{opacity:0.72;filter:grayscale(1);transition:opacity .15s ease, filter .15s ease;} .gh-land-logo:hover{opacity:1;filter:none;}
        .gh-land-faqbtn:hover{color:${ink};}
      `}</style>

      {/* Nav */}
      <div style={{position:"sticky",top:0,zIndex:50,background:T.bg+"e6",backdropFilter:"blur(12px)",borderBottom:`1px solid ${lineL}`}}>
        <div style={{...WRAP,height:64,display:"flex",alignItems:"center",gap:4}}>
          <img src="/logo-color.png" alt="Growith" style={{width:26,height:26,borderRadius:6}}/>
          <span style={{fontSize:16,fontWeight:700,letterSpacing:-0.3,marginLeft:8,marginRight:22}}>Growith</span>
          {NAV.map(([l,id])=><button key={id} onClick={()=>irA(id)} className="gh-land-navlink" style={{background:"transparent",border:"none",cursor:"pointer",fontSize:13.5,fontFamily:F,padding:"6px 10px",fontWeight:500}}>{l}</button>)}
          <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:8,whiteSpace:"nowrap"}}>
            <button onClick={onLogin} style={{background:"transparent",border:"none",cursor:"pointer",fontSize:13.5,fontFamily:F,padding:"8px 10px",fontWeight:500,color:ink2,whiteSpace:"nowrap"}}>Iniciar sesión</button>
            {btnPri("Probar gratis", onLogin)}
          </div>
        </div>
      </div>

      {/* Hero */}
      <div className="gh-land-hero" style={{...WRAP,padding:"112px 24px 0",textAlign:"center"}}>
        <div data-reveal="left" style={{fontSize:13,fontWeight:500,color:ink2,marginBottom:22}}>14 días de prueba gratis · sin tarjeta</div>
        <h1 data-reveal="rise" data-reveal-delay="1" style={{fontSize:"clamp(36px,6.2vw,68px)",fontWeight:700,letterSpacing:-2,lineHeight:1.04,margin:"0 auto 22px",maxWidth:880}}>
          Todo tu e‑commerce bajo control.<br/><span style={{color:ink2}}>A un clic.</span>
        </h1>
        <p data-reveal="rise" data-reveal-delay="2" style={{fontSize:18,color:ink2,lineHeight:1.55,maxWidth:620,margin:"0 auto 32px"}}>
          Márgenes, pedidos, envíos, stock, reclamos, facturación y publicidad de tu Tienda Nube, Shopify y Mercado Libre, en un solo lugar. Entrás y sabés qué pasó, qué falta y qué resolver hoy.
        </p>
        <div data-reveal="pop" data-reveal-delay="3" style={{display:"flex",gap:10,justifyContent:"center",flexWrap:"wrap"}}>
          {btnPri("Probar gratis 14 días", onLogin, true)}
          {btnSec("Ver qué incluye", ()=>irA("gh-landing-features"), true)}
        </div>
        <div data-reveal data-reveal-delay="4" style={{fontSize:12.5,color:ink3,marginTop:18}}>Sin renovación automática · Cancelás cuando quieras · Soporte en español</div>

        {/* El hero rota tres facetas de la app real: los KPIs del Inicio, los
            pendientes del día y el Dashboard de márgenes. Cada pasaje entra
            distinto (flip 3D · zoom con desenfoque · cortina) y la caja mide
            siempre lo mismo, así nada salta. */}
        <div data-reveal="pop" className="gh-lm-float" style={{margin:"72px auto 0",maxWidth:960,textAlign:"left"}}>
          <GhHeroLoop T={T} facetas={heroFacetas}/>
        </div>

        {/* Con qué se conecta: fila estática, sin marquee */}
        {/* Se conecta con lo que ya usás: la fila se desliza sola (se pausa al
            pasar el mouse) y con prefers-reduced-motion queda quieta y envuelta. */}
        <div id="gh-landing-integs" data-reveal="wipe" style={{padding:"56px 0 88px"}}>
          <div style={{fontSize:12,color:ink3,fontWeight:500,marginBottom:20}}>Se conecta con lo que ya usás</div>
          <div className="gh-lm-marquee">
            <div className="gh-lm-marquee-row">
              {[...MARQUEE,...MARQUEE].map(([b,n,soon],i)=>(
                <span key={n+i} className="gh-land-logo" style={{display:"inline-flex",alignItems:"center",gap:8,fontSize:13.5,fontWeight:600,color:ink2,whiteSpace:"nowrap"}}>
                  {marca(b,18)}{n}{soon&&pronto}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Antes / después */}
      <div className="gh-land-sec" style={SEC}>
        <div style={WRAP}>
          {head("Todo en un lugar","Tu negocio hoy está repartido en diez pestañas","Para saber cómo viene el día tenés que abrir la tienda, Mercado Libre, el portal de Andreani, ARCA, el administrador de anuncios y un par de planillas. Growith lo junta en una sola pantalla.",{rev:"tilt"})}
          <div className="gh-land-antes" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:24}}>
            <div data-reveal="left" style={{border:`1px solid ${line}`,borderRadius:12,padding:"22px 24px"}}>
              <div style={{fontSize:12,fontWeight:600,letterSpacing:0.6,textTransform:"uppercase",color:ink3,marginBottom:14}}>Hoy</div>
              {PESTANAS.map(p=>(
                <div key={p} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 0",borderTop:`1px solid ${lineL}`,fontSize:14,color:ink2}}>
                  <span style={{width:6,height:6,borderRadius:3,border:`1px solid ${ink3}`,flexShrink:0}}/>{p}
                </div>
              ))}
            </div>
            <div data-reveal="flip" data-reveal-delay="2" style={{border:`1px solid ${T.accentSolid}`,borderRadius:12,padding:"22px 24px",background:T.card}}>
              <div style={{fontSize:12,fontWeight:600,letterSpacing:0.6,textTransform:"uppercase",color:T.accent,marginBottom:14}}>Con Growith</div>
              <div style={{display:"flex",alignItems:"center",gap:10,paddingBottom:14,borderBottom:`1px solid ${lineL}`,marginBottom:6}}>
                <img src="/logo-color.png" alt="" style={{width:28,height:28,borderRadius:7}}/>
                <div><div style={{fontSize:15,fontWeight:600}}>Un solo lugar</div><div style={{fontSize:12.5,color:ink3}}>Un login, un menú, todo conectado</div></div>
              </div>
              {["Todo lo pendiente del día en el Inicio","Cada área del negocio a un clic en el menú","Avisos cuando algo necesita tu atención","Tu equipo trabajando en el mismo lugar"].map(x=>(
                <div key={x} style={{display:"flex",gap:10,fontSize:14,color:ink,padding:"7px 0"}}><Check c={T.accent}/>{x}</div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* El Inicio */}
      <div className="gh-land-sec" style={SEC}>
        <div style={WRAP}>
          {split(<div>
            {kicker("Inicio", T.accent)}
            {h2("Entrás y ya sabés qué hay que hacer")}
            <div style={{marginTop:14,marginBottom:24}}>{sub("El Inicio junta lo que pasa en todas tus áreas y te lo muestra en orden. Nada de salir a buscar problemas: los problemas te encuentran a vos.")}</div>
            {lista(["Facturado y pedidos de hoy, los últimos 7 días o el mes","Reclamos abiertos y stock crítico, a la vista","Pendientes agrupados: dashboard, reclamos, envíos, stock y canjes","Contadores en el menú de lo que te espera en cada sección","Un clic y estás resolviendo, sin buscar nada","Configuración guiada para arrancar sin perderte"], T.accent)}
          </div>, ventana("Inicio · Pendientes", <div>
            {[["Dashboard",T.accent,["Profit de hoy: $ 142.000 · 31% de margen","3 productos vendidos sin costo cargado"]],["Reclamos",T.red,["Cambio de talle · #1463","Llegó dañado · #1458"]],["Envíos",T.orange,["#1475 en sucursal hace 4 días","#1471 con visita fallida"]],["Stock",T.yellow,["Producto A · Negro: quedan 4 días"]]].map(([cat,c,items])=>(
              <div key={cat} style={{marginBottom:10}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:2}}>
                  <span style={{width:6,height:6,borderRadius:3,background:c,display:"inline-block"}}/>
                  <span style={{fontSize:11.5,fontWeight:600,color:ink3,flex:1}}>{cat}</span>
                  <span style={{fontSize:11,fontWeight:600,color:ink3}}>{items.length}</span>
                </div>
                {items.map(x=><div key={x}>{filaMock(x, <span style={{fontSize:12,fontWeight:600,color:T.accent}}>Ir →</span>)}</div>)}
              </div>
            ))}
          </div>))}
        </div>
      </div>

      {/* Mapa de secciones */}
      <div id="gh-landing-features" className="gh-land-sec" style={SEC}>
        <div style={WRAP}>
          {head("Qué incluye","Cada parte de tu negocio, a un clic","Así está organizado el menú de Growith. Todo lo que hoy hacés en otras apps, planillas y portales, en una sección propia.",{rev:"spin"})}
          <div className="gh-land-g4" style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:0,border:`1px solid ${line}`,borderRadius:12,overflow:"hidden"}}>
            {AREAS.map((a,ai)=>(
              <div key={a.t} data-reveal="pop" data-reveal-delay={String(ai+1)} style={{padding:"22px 22px 12px",borderLeft:ai?`1px solid ${lineL}`:"none",background:T.card}}>
                <div style={{display:"flex",alignItems:"center",gap:8,fontSize:12,fontWeight:600,letterSpacing:0.6,textTransform:"uppercase",color:ink3,marginBottom:8}}><span style={{width:6,height:6,borderRadius:3,background:a.c}}/>{a.t}</div>
                {a.items.map(it=>(
                  <div key={it.n} style={{display:"flex",gap:12,padding:"12px 0",borderTop:`1px solid ${lineL}`}}>
                    <span style={{color:ink3,flexShrink:0,marginTop:2}}><GhI n={it.gi} size={15}/></span>
                    <div style={{minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,fontSize:14,fontWeight:600,marginBottom:3}}>{it.n}{it.soon&&pronto}</div>
                      <div style={{fontSize:12.5,color:ink3,lineHeight:1.5}}>{it.d}</div>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Cómo funciona cada sección */}
      <div id="gh-landing-modulos" className="gh-land-sec" style={SEC}>
        <div style={WRAP}>
          {head("Cómo funciona","Así se ve cada sección por dentro","Cada sección resuelve una parte concreta de la operación. Esto es lo que vas a encontrar cuando entres.",{mb:80,rev:"flip"})}
          <div style={{display:"flex",flexDirection:"column",gap:96}}>
            {/* La mock de cada módulo entra con una variante distinta, en ciclo. */}
            {MODULOS.map((m,i)=><div key={m.k}>{split(<div>
              {kicker(m.k, m.c)}
              {h2(m.t)}
              <div style={{marginTop:14,marginBottom:24}}>{sub(m.d)}</div>
              {lista(m.b, m.c)}
            </div>, mockDe(m.mock), i%2===1, ["swing","flip","pop","wipe","spin","tilt","rise"][i%7])}</div>)}
          </div>
        </div>
      </div>

      {/* Avisos */}
      <div id="gh-landing-avisos" className="gh-land-sec" style={SEC}>
        <div style={WRAP}>
          {head("Avisos","Growith te avisa antes de que sea un problema","No tenés que revisar todo el día. Cuando algo necesita tu atención, te enterás.",{rev:"swing"})}
          <div className="gh-land-g3" style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:"40px 32px"}}>
            {AVISOS.map((a,i)=>(
              <div key={a.t} data-reveal="pop" data-reveal-delay={String((i%3)+1)}>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}><span style={{color:a.c,display:"inline-flex"}}><GhI n={a.gi} size={16}/></span><div style={{fontSize:15.5,fontWeight:600}}>{a.t}</div></div>
                <div style={{fontSize:14,color:ink2,lineHeight:1.6}}>{a.d}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Un día con Growith */}
      <div id="gh-landing-dia" className="gh-land-sec" style={SEC}>
        <div style={WRAP}>
          {head("En la práctica","Un día con Growith","Todo lo del día, desde el mismo lugar.",{rev:"wipe"})}
          <div style={{maxWidth:760}}>
            {DIA.map(([h,t,d,gi],i)=>(
              <div key={h} data-reveal="left" className="gh-land-dia" style={{display:"grid",gridTemplateColumns:"72px 28px 1fr",gap:12,padding:"16px 0",borderTop:`1px solid ${lineL}`,alignItems:"start"}}>
                <span style={{fontSize:13,fontWeight:600,color:ink3,fontVariantNumeric:"tabular-nums",paddingTop:2}}>{h}</span>
                <span className="gh-land-hide-m" style={{color:ink3,display:"inline-flex",paddingTop:2}}><GhI n={gi} size={15}/></span>
                <div><div style={{fontSize:15.5,fontWeight:600,marginBottom:3}}>{t}</div><div style={{fontSize:14,color:ink2,lineHeight:1.6}}>{d}</div></div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Equipo, multi-tienda y conexiones */}
      <div className="gh-land-sec" style={SEC}>
        <div style={WRAP}>
          {head("Equipo","Todos trabajando en el mismo lugar","Vos ves todo. Cada persona de tu equipo ve lo suyo.",{rev:"tilt"})}
          <div className="gh-land-g4" style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:32}}>
            {EQUIPO.map((s,i)=>(
              <div key={s.t} data-reveal="rise" data-reveal-delay={String(i+1)}>
                <span style={{color:ink3,display:"inline-flex",marginBottom:12}}><GhI n={s.gi} size={18}/></span>
                <div style={{fontSize:15.5,fontWeight:600,marginBottom:8}}>{s.t}</div>
                <div style={{fontSize:14,color:ink2,lineHeight:1.6}}>{s.d}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* IA */}
      <div id="gh-landing-ia" className="gh-land-sec" style={SEC}>
        <div style={WRAP}>
          {split(<div>
            <div style={{display:"flex",gap:8,marginBottom:16}}>{["Claude","ChatGPT","Gemini"].map(k=><span key={k}>{chip(k,18,34)}</span>)}</div>
            {h2("Preguntale por tu negocio a la IA que ya usás")}
            <div style={{marginTop:14,marginBottom:24}}>{sub("Conectá Growith a Claude, ChatGPT o Gemini y consultá ventas, campañas, stock o envíos en una conversación. Solo lee tus datos: no cambia nada.")}</div>
            {lista(["Se conecta desde Configuración, en un par de pasos","Autorizás con tu cuenta de Growith","Lo desconectás cuando quieras"], T.accent)}
          </div>, ventana("Claude · con Growith conectado", <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <div style={{alignSelf:"flex-end",maxWidth:"85%",background:T.surface,border:`1px solid ${lineL}`,borderRadius:"12px 12px 4px 12px",padding:"10px 13px",fontSize:13,lineHeight:1.55,color:ink}}>¿Cómo vienen los envíos y el stock esta semana?</div>
            <div style={{alignSelf:"flex-start",maxWidth:"92%",background:T.bg,border:`1px solid ${lineL}`,borderRadius:"12px 12px 12px 4px",padding:"11px 13px",fontSize:13,lineHeight:1.6,color:ink2}}>
              Tenés <strong style={{color:ink}}>2 envíos</strong> con problemas: el #1475 está en sucursal hace 4 días y el #1471 tuvo una visita fallida.<br/><br/>
              En stock, al <strong style={{color:ink}}>Producto A · Negro</strong> le quedan 4 días y el <strong style={{color:ink}}>Producto C · Talle M</strong> está agotado.
            </div>
          </div>), false, "wipe")}
        </div>
      </div>

      {/* Integraciones por categoría */}
      <div id="gh-landing-integraciones" className="gh-land-sec" style={SEC}>
        <div style={WRAP}>
          {head("Integraciones","Todo lo que ya usás, conectado","Growith se conecta con las plataformas de tu negocio. Sin exportar planillas ni copiar datos.",{rev:"rise"})}
          <div className="gh-land-g3" style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:0,border:`1px solid ${line}`,borderRadius:12,overflow:"hidden"}}>
            {CATEGORIAS.map((c,i)=>(
              <div key={c.t} data-reveal="flip" data-reveal-delay={String((i%3)+1)} style={{padding:"22px 24px",background:T.card,borderLeft:i%3?`1px solid ${lineL}`:"none",borderTop:i>=3?`1px solid ${lineL}`:"none"}}>
                <div style={{fontSize:15,fontWeight:600,marginBottom:4}}>{c.t}</div>
                <div style={{fontSize:13,color:ink3,lineHeight:1.5,marginBottom:14}}>{c.d}</div>
                <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  {c.items.map(([b,n,soon])=>(
                    <span key={n} style={{display:"inline-flex",alignItems:"center",gap:10,fontSize:13.5,fontWeight:500,color:ink}}>{chip(b,16,28)}{n}{soon&&pronto}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Valor + cómo empezar */}
      <div className="gh-land-sec" style={SEC}>
        <div style={WRAP}>
          <div className="gh-land-stats" style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:0,border:`1px solid ${line}`,borderRadius:12,overflow:"hidden",marginBottom:96}}>
            {[
              {k:"Apps por separado", pre:"USD", v:"145–250", suf:"/mes", muted:true, l:"entre facturador, envíos, stock, reportes y gestión de Mercado Libre"},
              {k:"Con Growith", pre:"desde USD", v:"19", suf:"/mes", l:"todo unificado en un solo lugar; el Pro completo cuesta USD 69"},
              {k:"Puesta en marcha", v:"5", suf:" min", l:"conectás tu tienda y ya ves tus pedidos y pendientes"},
            ].map((s,i)=>(
              <div key={s.k} data-reveal="spin" data-reveal-delay={String(i+1)} style={{padding:"26px 28px",background:T.card,borderLeft:i?`1px solid ${lineL}`:"none"}}>
                <div style={{fontSize:12,fontWeight:600,letterSpacing:0.6,textTransform:"uppercase",color:ink3,marginBottom:12}}>{s.k}</div>
                <div style={{display:"flex",alignItems:"baseline",gap:6}}>
                  {s.pre&&<span style={{fontSize:13,fontWeight:600,color:ink3}}>{s.pre}</span>}
                  <span style={{fontSize:34,fontWeight:700,letterSpacing:-1.2,color:s.muted?ink3:ink,textDecoration:s.muted?"line-through":"none",textDecorationThickness:2}}>{s.v}</span>
                  {s.suf&&<span style={{fontSize:13,fontWeight:600,color:ink3}}>{s.suf}</span>}
                </div>
                <div style={{fontSize:13,color:ink2,lineHeight:1.55,marginTop:10}}>{s.l}</div>
              </div>
            ))}
          </div>
          {head("Cómo empezar","En marcha en minutos","Sin migraciones, sin importar planillas, sin implementación. Conectás y Growith hace el resto.",{rev:"pop"})}
          <div className="gh-land-g3" style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:32}}>
            {[
              {n:"01",t:"Conectá tus canales",d:"Tienda Nube, Shopify, Mercado Libre y tus cuentas publicitarias, con un par de clics. Sin tocar código."},
              {n:"02",t:"Growith junta todo",d:"Pedidos, stock, envíos, reclamos y facturas se ordenan solos y se mantienen al día, canal por canal."},
              {n:"03",t:"Manejá todo desde un lugar",d:"Despachá, facturá, respondé, reponé stock y seguí tus campañas sin saltar entre apps."},
            ].map((p,i)=>(
              <div key={p.n} data-reveal="right" data-reveal-delay={String(i+1)} style={{borderTop:`1px solid ${line}`,paddingTop:18}}>
                <div style={{fontSize:12,fontWeight:600,color:ink3,marginBottom:10,fontVariantNumeric:"tabular-nums"}}>{p.n}</div>
                <div style={{fontSize:16,fontWeight:600,marginBottom:8}}>{p.t}</div>
                <div style={{fontSize:14,color:ink2,lineHeight:1.6}}>{p.d}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Precios */}
      <div id="gh-landing-precios" className="gh-land-sec" style={SEC}>
        <div style={WRAP}>
          {head("Precios","Planes simples, sin letra chica","Probás gratis 14 días con absolutamente todo. Después elegís lo que necesitás.",{center:true,rev:"flip"})}
          <div className="gh-land-g3" style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16,alignItems:"stretch"}}>
            {PLANES_L.map((p,i)=>(
              <div key={p.n} data-reveal="swing" data-reveal-delay={String(i+1)} style={{background:T.card,border:`1px solid ${p.rec?T.accentSolid:line}`,borderRadius:14,padding:"26px 26px 24px",display:"flex",flexDirection:"column",position:"relative"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
                  <div style={{fontSize:15,fontWeight:600}}>{p.n}</div>
                  {p.rec&&<span style={{fontSize:11,fontWeight:600,color:T.accent,border:`1px solid ${T.accentSolid}66`,borderRadius:6,padding:"2px 8px"}}>Recomendado</span>}
                </div>
                <div style={{fontSize:13,color:ink3,marginBottom:20}}>{p.d}</div>
                <div style={{display:"flex",alignItems:"baseline",gap:6}}>
                  <span style={{fontSize:44,fontWeight:700,letterSpacing:-1.8,lineHeight:1}}>${p.p}</span>
                  <span style={{fontSize:13,color:ink3,fontWeight:500}}>USD/mes</span>
                  <span style={{fontSize:13,color:ink3,textDecoration:"line-through",marginLeft:4}}>${p.antes}</span>
                </div>
                <div style={{fontSize:12.5,color:ink3,marginTop:8,marginBottom:22}}>o USD {p.anual}/mes pagando anual</div>
                <div style={{display:"flex",flexDirection:"column",gap:9,marginBottom:26,flex:1}}>
                  {p.b.map((x,i)=>(
                    <div key={x} style={{display:"flex",gap:9,alignItems:"flex-start",fontSize:13.5,color:i===0&&p.n!=="Facturador"?ink:ink2,fontWeight:i===0&&p.n!=="Facturador"?600:400,lineHeight:1.45}}><Check c={p.rec?T.accent:ink3}/>{x}</div>
                  ))}
                </div>
                {p.rec
                  ? <button onClick={onLogin} style={{background:T.accentSolid,border:`1px solid ${T.accentSolid}`,color:"#fff",borderRadius:10,fontSize:14,fontWeight:600,padding:"12px",cursor:"pointer",fontFamily:F,width:"100%"}}>Probar gratis 14 días</button>
                  : <button onClick={onLogin} style={{background:"transparent",border:`1px solid ${line}`,color:ink,borderRadius:10,fontSize:14,fontWeight:600,padding:"12px",cursor:"pointer",fontFamily:F,width:"100%"}}>Probar gratis 14 días</button>}
              </div>
            ))}
          </div>
          <div data-reveal style={{maxWidth:640,margin:"28px auto 0",textAlign:"center",fontSize:13.5,color:ink3,lineHeight:1.6}}>
            Sin tarjeta · Sin renovación automática · Cancelás cuando quieras.<br/>¿Manejás más de una marca? Sumá tiendas a tu mismo login: <span style={{color:ink2}}>USD 5, 10 o 15 por mes</span> cada una, según el plan.
          </div>
        </div>
      </div>

      {/* Preguntas frecuentes */}
      <div id="gh-landing-faq" className="gh-land-sec" style={SEC}>
        <div style={{...WRAP,maxWidth:820}}>
          {head("Preguntas frecuentes","Lo que nos preguntan antes de empezar","Si te queda alguna duda, escribinos y te respondemos nosotros.",{rev:"left"})}
          <div style={{borderTop:`1px solid ${line}`}}>
            {FAQ.map(([q,a],i)=>{
              const abierta=faqAbierta===i;
              return (
                <div key={q} data-reveal="rise" style={{borderBottom:`1px solid ${line}`}}>
                  <button onClick={()=>setFaqAbierta(abierta?-1:i)} aria-expanded={abierta} className="gh-land-faqbtn" style={{width:"100%",display:"flex",alignItems:"center",gap:16,padding:"18px 0",background:"transparent",border:"none",cursor:"pointer",textAlign:"left",fontFamily:F,fontSize:15.5,fontWeight:600,color:abierta?ink:ink2}}>
                    <span style={{flex:1}}>{q}</span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{flexShrink:0,transform:abierta?"rotate(45deg)":"none",transition:"transform .15s ease",color:ink3}}><path d="M12 5v14M5 12h14"/></svg>
                  </button>
                  {abierta&&<div style={{padding:"0 40px 20px 0",fontSize:14.5,color:ink2,lineHeight:1.7}}>{a}</div>}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* CTA final */}
      <div className="gh-land-sec" style={SEC}>
        <div style={{...WRAP,textAlign:"center"}}>
          <h2 data-reveal="pop" style={{fontSize:"clamp(30px,4.4vw,48px)",fontWeight:700,letterSpacing:-1.4,lineHeight:1.08,margin:"0 auto 16px",maxWidth:720}}>Tené todo tu negocio bajo control</h2>
          <p data-reveal data-reveal-delay="1" style={{fontSize:16.5,color:ink2,maxWidth:520,margin:"0 auto 28px",lineHeight:1.6}}>14 días gratis con absolutamente todo. Conectás tu tienda en 5 minutos y Growith empieza a ordenar.</p>
          <div data-reveal="rise" data-reveal-delay="2" style={{display:"flex",gap:10,justifyContent:"center",flexWrap:"wrap"}}>
            {btnPri("Probar gratis 14 días", onLogin, true)}
            <a href="mailto:contacto.growith@gmail.com" style={{display:"inline-flex",alignItems:"center",border:`1px solid ${line}`,color:ink,borderRadius:10,fontSize:15,fontWeight:600,padding:"13px 22px",textDecoration:"none",fontFamily:F,lineHeight:1.2}}>Hablar con nosotros</a>
          </div>
          <div style={{fontSize:12.5,color:ink3,marginTop:16}}>Sin tarjeta · Sin renovación automática</div>
        </div>
      </div>

      {/* Footer */}
      <div style={{borderTop:`1px solid ${lineL}`}}>
        <div style={{...WRAP,padding:"48px 24px 40px"}}>
          <div data-reveal="rise" className="gh-land-foot" style={{display:"grid",gridTemplateColumns:"1.6fr 1fr 1fr 1fr",gap:28}}>
            <div>
              <div style={{display:"flex",alignItems:"center",gap:8,fontSize:15,fontWeight:700,marginBottom:10}}>
                <img src="/logo-color.png" alt="" style={{width:22,height:22,borderRadius:5}}/> Growith
              </div>
              <div style={{fontSize:13,color:ink3,lineHeight:1.6,maxWidth:300}}>La plataforma de gestión para e-commerce argentinos: todo tu negocio bajo control, en un solo lugar.</div>
            </div>
            <div>
              <div style={{fontSize:12,fontWeight:600,letterSpacing:0.6,textTransform:"uppercase",color:ink2,marginBottom:12}}>Producto</div>
              {[["Secciones","gh-landing-features"],["Cómo funciona","gh-landing-modulos"],["Avisos","gh-landing-avisos"],["Precios","gh-landing-precios"],["Preguntas frecuentes","gh-landing-faq"]].map(([l,id])=>(
                <button key={id} onClick={()=>irA(id)} style={{display:"block",background:"none",border:"none",padding:"4px 0",cursor:"pointer",fontFamily:F,fontSize:13,color:ink3,textAlign:"left"}}>{l}</button>
              ))}
            </div>
            <div>
              <div style={{fontSize:12,fontWeight:600,letterSpacing:0.6,textTransform:"uppercase",color:ink2,marginBottom:12}}>Integraciones</div>
              {["Tienda Nube · Shopify","Mercado Libre · Mercado Pago","Pago Nube · Pagos personalizados","Meta Ads · Google Ads","Andreani · ARCA","Claude · ChatGPT · Gemini"].map(l=>(
                <div key={l} style={{fontSize:13,color:ink3,padding:"4px 0"}}>{l}</div>
              ))}
            </div>
            <div>
              <div style={{fontSize:12,fontWeight:600,letterSpacing:0.6,textTransform:"uppercase",color:ink2,marginBottom:12}}>Contacto y legal</div>
              <a href="mailto:contacto.growith@gmail.com" style={{display:"block",fontSize:13,color:ink3,padding:"4px 0",textDecoration:"none"}}>contacto.growith@gmail.com</a>
              <a href="/privacidad.html" style={{display:"block",fontSize:13,color:ink3,padding:"4px 0",textDecoration:"none"}}>Privacidad</a>
              <a href="/terminos.html" style={{display:"block",fontSize:13,color:ink3,padding:"4px 0",textDecoration:"none"}}>Términos</a>
            </div>
          </div>
          <div style={{borderTop:`1px solid ${lineL}`,marginTop:32,paddingTop:18,fontSize:12,color:ink3,display:"flex",flexWrap:"wrap",gap:"6px 18px",justifyContent:"space-between"}}>
            <span>© {new Date().getFullYear()} Growith · Hecho en Argentina</span>
            {/* Partner de la misma casa (27-sept-2026): suscripciones con Mercado Pago para Shopify y Tiendanube. */}
            <span>Partner: <a href="https://www.recurrentesapp.com/" style={{color:ink2,fontWeight:600,textDecoration:"none"}}>Recurrentes App</a> · suscripciones con Mercado Pago para tu tienda</span>
          </div>
        </div>
      </div>
    </div>
  );
}
