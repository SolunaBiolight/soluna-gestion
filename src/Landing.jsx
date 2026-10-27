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

// ── Rediseño 27/oct/2026 (pre-lanzamiento con pauta) ─────────────────────
// Diagnóstico que lo motivó: en celular las animaciones de entrada estiraban la
// página hacia el costado (447 px de ancho en un teléfono de 375), el hero
// dependía del reveal para aparecer, prometía "sin renovación automática" (los
// planes con tarjeta se renuevan solos) y la página contaba lo mismo cuatro
// veces en ~14.000 px. Ahora: hero visible desde el primer cuadro, tres
// diferenciales arriba (ganancia real por venta, etiquetas con saldo, ARCA), las
// secciones en UNA vitrina con pestañas, y botón fijo abajo en celular.
// Firma visual: la flecha en zigzag que sube del logo (GhZig).

// Marca que hace Growith y lo usa todos los días. Vacío = se oculta la sección.
const GH_LAND_MARCA = "Soluna Biolight";

// La flecha del logo como trazo: un zigzag que sube y termina en punta.
function GhZig({w=140, h=26, c, sw=3, style}) {
  return (
    <svg width={w} height={h} viewBox="0 0 140 26" fill="none" preserveAspectRatio="none" aria-hidden="true" style={style}>
      <path d="M2 22 L38 12 L58 19 L122 5" stroke={c} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
      <path d="M110 3.5 L124 4.5 L117 16" stroke={c} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
    </svg>
  );
}

export function LandingPage({T, onLogin}) {
  const F = "'Inter',system-ui,sans-serif";
  const BRAND = "#8455FB"; // violeta del logo
  const [faqAbierta,setFaqAbierta] = useState(0);
  const [modulo,setModulo] = useState(0);
  const [barra,setBarra] = useState(false); // botón fijo de celular, aparece pasado el hero
  const landRef = useRef(null);
  useGhReveal(landRef);
  useGhScrollProgress(landRef);
  useEffect(() => {
    const on = () => setBarra(window.scrollY > 700);
    on(); window.addEventListener("scroll", on, {passive:true});
    return () => window.removeEventListener("scroll", on);
  }, []);

  const ink = T.text, ink2 = T.textMd, ink3 = T.textSm, line = T.border, lineL = T.borderL;
  const WRAP = {maxWidth:1140, margin:"0 auto", padding:"0 24px"};
  const SEC = {padding:"112px 0", borderTop:`1px solid ${lineL}`};
  const kicker = (txt, c) => <div style={{display:"flex",alignItems:"center",gap:8,fontSize:12,fontWeight:600,letterSpacing:0.6,textTransform:"uppercase",color:ink3,marginBottom:14,fontFamily:F}}>{c&&<span style={{width:6,height:6,borderRadius:3,background:c,display:"inline-block"}}/>}{txt}</div>;
  const h2 = (txt, opts={}) => <h2 style={{fontSize:"clamp(28px,3.8vw,44px)",fontWeight:700,letterSpacing:-1.1,lineHeight:1.1,color:ink,margin:"0 0 14px",maxWidth:opts.center?760:660,textAlign:opts.center?"center":"left",marginLeft:opts.center?"auto":0,marginRight:opts.center?"auto":0,fontFamily:F}}>{txt}</h2>;
  const sub = (txt, opts={}) => <p style={{fontSize:17,color:ink2,lineHeight:1.6,margin:opts.center?"0 auto":"0",maxWidth:opts.center?620:560,textAlign:opts.center?"center":"left",fontFamily:F}}>{txt}</p>;
  const head = (k, t, s, opts={}) => <div data-reveal="rise" style={{marginBottom:opts.mb??56}}>{kicker(k, opts.c)}{h2(t,opts)}{s&&<div style={{marginTop:14}}>{sub(s,opts)}</div>}</div>;
  const Check = ({c}) => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={c||ink3} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0,marginTop:3}}><path d="M5 12.5l4.2 4L19 7"/></svg>;
  const lista = (items, c) => <div style={{display:"flex",flexDirection:"column",gap:10}}>{items.map(x=><div key={x} style={{display:"flex",gap:10,fontSize:14.5,color:ink,lineHeight:1.5}}><Check c={c}/>{x}</div>)}</div>;
  const btnPri = (label, onClick, big) => <button onClick={onClick} className="gh-land-btn" style={{background:T.accentSolid,border:`1px solid ${T.accentSolid}`,color:"#fff",borderRadius:999,fontSize:big?15.5:13.5,fontWeight:600,padding:big?"14px 26px":"9px 16px",cursor:"pointer",fontFamily:F,lineHeight:1.2,whiteSpace:"nowrap"}}>{label}</button>;
  const btnSec = (label, onClick, big) => <button onClick={onClick} className="gh-land-btn" style={{background:"transparent",border:`1px solid ${line}`,color:ink,borderRadius:999,fontSize:big?15.5:13.5,fontWeight:600,padding:big?"14px 26px":"9px 16px",cursor:"pointer",fontFamily:F,lineHeight:1.2,whiteSpace:"nowrap"}}>{label}</button>;
  const irA = (id) => { try{document.getElementById(id)?.scrollIntoView({behavior:"smooth"});}catch(_){} };
  const marca = (b, s=18) => b==="pagonube" ? <svg width={s} height={s} viewBox="0 0 24 24"><path d="M7 18.5h10.5a4.2 4.2 0 00.7-8.35A6.2 6.2 0 006.3 9.2 4.7 4.7 0 007 18.5z" fill="#3b82f6"/><path d="M12 10.2v5.6M13.8 11.3c-.4-.5-1-.8-1.8-.8-1 0-1.7.5-1.7 1.2 0 1.6 3.6.8 3.6 2.5 0 .8-.8 1.3-1.9 1.3-.9 0-1.6-.3-2-.9" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" fill="none"/></svg>
    : b==="pagospers" ? <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6.5 15h4"/></svg>
    : b==="recurrentes" ? <RecurrentesLogo size={s}/>
    : IA_ICONS[b] ? React.cloneElement(IA_ICONS[b], {width:s, height:s})
    : <BrandIcon name={b} size={b==="andreani"?s+4:s}/>;
  const chip = (b, s=18, box=32) => <span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:box,height:box,borderRadius:9,background:T.surface,border:`1px solid ${lineL}`,flexShrink:0}}>{marca(b,s)}</span>;
  const pronto = <span style={{fontSize:10,fontWeight:600,color:ink3,border:`1px solid ${line}`,borderRadius:999,padding:"1px 7px",letterSpacing:0.3,textTransform:"uppercase",whiteSpace:"nowrap"}}>Pronto</span>;
  const ventana = (titulo, hijos, opts={}) => (
    <div style={{background:T.card,border:`1px solid ${line}`,borderRadius:16,overflow:"hidden",boxShadow:"0 30px 70px -45px rgba(0,0,0,0.7)",...opts.style}}>
      <div style={{display:"flex",alignItems:"center",gap:8,padding:"11px 16px",borderBottom:`1px solid ${lineL}`}}>
        <span style={{display:"flex",gap:5}}>{[0,1,2].map(i=><i key={i} style={{width:7,height:7,borderRadius:4,background:line,display:"inline-block"}}/>)}</span>
        <span style={{fontSize:12,color:ink2,fontWeight:600,marginLeft:6}}>{titulo}</span>
        <span style={{marginLeft:"auto",fontSize:10,color:ink3,letterSpacing:0.4,textTransform:"uppercase"}}>{opts.tag||"Datos de ejemplo"}</span>
      </div>
      <div style={{padding:opts.pad||"14px 16px"}}>{hijos}</div>
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
  const num = {fontVariantNumeric:"tabular-nums"};

  // ── Hero: tres facetas de la app (números de demo) ──
  const HERO_KPIS = [
    {l:"Facturado", v:"$ 12,4M", d:"Este mes"},
    {l:"Ganancia", v:"$ 3,4M", d:"27,4 % de margen", c:T.green},
    {l:"Pedidos", v:"486", d:"Este mes"},
    {l:"Para resolver", v:"4", d:"Reclamos, envíos, stock", c:T.orange},
  ];
  const HERO_PEND = [
    ["Reclamos","Cambio de talle · pedido #1463","Responder",T.red],
    ["Envíos","#1475 en sucursal hace 4 días","Ver envío",T.orange],
    ["Stock","Producto A · Negro: quedan 4 días","Reponer",T.yellow],
    ["Canjes","Contenido de @creadora vence mañana","Ver canje","#E1306C"],
  ];
  const HERO_DASH = [
    ["Facturación","$ 12.430.000",T.text],
    ["Costo de mercadería","− $ 4.980.000",T.textMd],
    ["Comisiones y envíos","− $ 1.910.000",T.textMd],
    ["Publicidad","− $ 2.140.000",T.textMd],
  ];
  const HERO_CANALES = [["Tienda Nube","62 %",62],["Mercado Libre","29 %",29],["Shopify","9 %",9]];
  const MARQUEE = [["tiendanube","Tienda Nube"],["shopify","Shopify"],["mercadolibre","Mercado Libre"],["mercadopago","Mercado Pago"],["pagonube","Pago Nube"],["andreani","Andreani"],["arca","ARCA"],["meta","Meta Ads"],["googleads","Google Ads"],["pagospers","Pagos personalizados"],["recurrentes","Recurrentes",true],["Claude","Claude"],["ChatGPT","ChatGPT"],["Gemini","Gemini"]];

  const ventanaHero = (titulo, periodo, hijos) => (
    <div style={{background:T.card,border:`1px solid ${line}`,borderRadius:18,overflow:"hidden",boxShadow:"0 40px 90px -45px rgba(0,0,0,0.75)",height:"100%",display:"flex",flexDirection:"column",minHeight:330}}>
      <div style={{display:"flex",alignItems:"center",gap:8,padding:"12px 18px",borderBottom:`1px solid ${lineL}`}}>
        <img src="/logo-color.png" alt="" style={{width:16,height:16}}/>
        <span style={{fontSize:12.5,color:ink2,fontWeight:600}}>{titulo}</span>
        <span style={{marginLeft:"auto",fontSize:11,color:ink3,border:`1px solid ${lineL}`,borderRadius:999,padding:"2px 10px"}}>{periodo}</span>
      </div>
      <div style={{flex:1,minHeight:0}}>{hijos}</div>
    </div>
  );
  const heroFacetas = [
    {key:"dash", trans:"wipe", label:"Dashboard · tu ganancia real", dur:7000, render:()=>ventanaHero("Dashboard · Márgenes","Este mes",
      <div style={{padding:"16px 20px 18px"}}>
        {HERO_DASH.map(([l,v,c])=>(
          <div key={l} style={{display:"flex",alignItems:"center",padding:"10px 0",borderTop:`1px solid ${lineL}`,fontSize:13}}>
            <span style={{flex:1,color:ink2}}>{l}</span>
            <span style={{fontWeight:600,color:c,...num}}>{v}</span>
          </div>
        ))}
        <div style={{display:"flex",alignItems:"center",padding:"14px 0 4px",borderTop:`1px solid ${line}`,marginTop:4}}>
          <span style={{flex:1,fontSize:13.5,fontWeight:600}}>Ganancia</span>
          <span style={{fontSize:24,fontWeight:700,letterSpacing:-0.8,color:T.green,...num}}>$ 3.400.000</span>
        </div>
        <div className="gh-land-mini3" style={{display:"flex",gap:8,marginTop:12}}>
          {[["Margen","27,4 %"],["Ticket promedio","$ 25.580"],["ROAS","3,1x"]].map(([l,v])=>(
            <div key={l} style={{flex:1,background:T.bg,border:`1px solid ${lineL}`,borderRadius:10,padding:"7px 10px"}}>
              <div style={{fontSize:9.5,color:ink3}}>{l}</div><div style={{fontSize:14,fontWeight:700}}>{v}</div>
            </div>
          ))}
        </div>
      </div>)},
    {key:"kpis", trans:"flip", label:"Inicio · cómo viene el mes", dur:7000, render:()=>ventanaHero("Inicio","Este mes",
      <div>
        <div className="gh-land-kpis" style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",borderBottom:`1px solid ${lineL}`}}>
          {HERO_KPIS.map((k,i)=>(
            <div key={k.l} style={{padding:"18px 20px",borderLeft:i?`1px solid ${lineL}`:"none"}}>
              <div style={{fontSize:12,color:ink3,fontWeight:500,marginBottom:6}}>{k.l}</div>
              <div style={{fontSize:24,fontWeight:700,letterSpacing:-0.8,color:k.c||ink,lineHeight:1}}>{k.v}</div>
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
    {key:"pend", trans:"zoom", label:"Inicio · lo que hay que resolver hoy", dur:7500, render:()=>ventanaHero("Inicio · Pendientes","Hoy",
      <div style={{padding:"14px 20px 18px"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
          <span style={{fontSize:12.5,fontWeight:600}}>Pendientes</span>
          <span style={{fontSize:11,fontWeight:600,color:ink3}}>{HERO_PEND.length}</span>
        </div>
        {HERO_PEND.map(([cat,txt,acc,c])=>(
          <div key={txt} style={{display:"flex",alignItems:"center",gap:12,padding:"11px 0",borderTop:`1px solid ${lineL}`,fontSize:13}}>
            <span style={{width:6,height:6,borderRadius:3,background:c,flexShrink:0}}/>
            <span className="gh-land-hide-m" style={{width:70,fontSize:11.5,fontWeight:600,color:ink3,flexShrink:0}}>{cat}</span>
            <span style={{flex:1,minWidth:0,color:ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{txt}</span>
            <span style={{fontSize:12,fontWeight:600,color:T.accent,whiteSpace:"nowrap"}}>{acc} →</span>
          </div>
        ))}
        <div style={{fontSize:11,color:ink3,marginTop:12}}>Un clic en cada línea y estás resolviendo</div>
      </div>)},
  ];

  // ── Los tres diferenciales ──
  const TICKET = [["Venta #1482 · Tienda Nube","$ 58.900",ink,600],["Costo del producto","− $ 16.400",ink2],["Comisión real de Mercado Pago","− $ 3.590",ink2],["Envío Andreani","− $ 6.850",ink2],["Publicidad que le corresponde","− $ 9.700",ink2]];

  // ── Vitrina de secciones (una a la vez, con pestañas) ──
  const MODULOS = [
    {k:"Envíos", c:"#f97316", gi:"clip", t:"Etiquetas de Andreani con saldo, sin contrato propio",
      d:"Cargás saldo con Mercado Pago o transferencia y emitís las etiquetas desde tus pedidos, a domicilio o a sucursal. Growith sigue cada paquete y los que se traban aparecen solos en tu Inicio.",
      b:["Ves el precio de cada etiqueta antes de emitir","Si te equivocás, la anulás en 30 minutos y el saldo vuelve al instante","El SKU impreso en el rótulo, listas para imprimir en tanda","Sucursal de retiro bien elegida, sin adivinar","Alertas de envíos demorados, en sucursal o con visita fallida","Andreani en el checkout de tu Shopify"], mock:"envios"},
    {k:"Facturación", c:"#eab308", gi:"file", t:"Facturás en ARCA sin copiar datos a mano",
      d:"Growith toma las ventas de tu tienda y de Mercado Libre y emite las facturas en ARCA, con CAE, PDF y QR oficial. Con el piloto automático se facturan solas.",
      b:["Facturación automática de tus órdenes","Notas de crédito totales o parciales","Monotributo y Responsable Inscripto","Varios CUITs y puntos de venta","La factura queda adjunta a la venta"], mock:"factura"},
    {k:"Stock", c:"#22c55e", gi:"box", t:"Un solo stock para Tienda Nube, Shopify y Mercado Libre",
      d:"Un inventario central por producto y variante, para saber qué tenés, qué se está por agotar y cuándo reponer.",
      b:["Stock unificado por SKU entre todos tus canales","Alerta cuando a un producto le quedan pocos días","Días de reposición por producto","Historial de agotados"], mock:"stock"},
    {k:"Mercado Libre", c:"#facc15", gi:"store", t:"Tu cuenta de Mercado Libre, sin abrir Mercado Libre",
      d:"Preguntas, mensajes, ventas y reputación en el mismo lugar que el resto del negocio, con el contador de preguntas en el menú.",
      b:["Respondé preguntas y mensajes desde Growith","Tus ventas de ML junto a las de tu tienda","Reputación y métricas de la cuenta","Publicaciones nuevas desde Growith"], mock:"ml"},
    {k:"Reclamos", c:"#ef4444", gi:"alert", t:"Ningún reclamo ni cambio se pierde",
      d:"Cada reclamo, cambio o devolución te dice qué hay que hacer ahora, con el mensaje para el cliente ya escrito. También los reclamos de Mercado Libre y los contracargos de Mercado Pago.",
      b:["Vista “Qué hacer”: lo urgente primero","Mensaje sugerido para WhatsApp o mail en cada paso","Seguimiento del envío de ida y de vuelta","Historial de todo lo resuelto"], mock:"reclamos"},
    {k:"Publicidad", c:"#3b82f6", gi:"play", t:"Meta y Google contra tu break-even",
      d:PUBLICADORES_ARCHIVADOS?"Mirá cómo viene cada campaña de Meta y Google con el gasto ya descontado de tu ganancia, sin entrar a cada administrador de anuncios.":"Mirá cómo viene cada campaña, pausala o activala y publicá campañas nuevas sin entrar a cada administrador de anuncios.",
      b:["Análisis de campañas de Meta Ads y Google Ads",...(META_OAUTH_OK?["Meta se conecta en un clic con Facebook"]:[]),"ROAS de cada campaña contra tu break-even","El gasto publicitario entra solo a tu ganancia"], mock:"campanas"},
    {k:"Pagos", c:"#6366f1", gi:"calendar", t:"Lo que tenés que pagar, antes de que venza",
      d:"El Calendario de pagos junta alquiler, proveedores, préstamos, cuotas y tarjetas, y te avisa por mail antes de cada vencimiento.",
      b:["Aviso el día anterior y el día del vencimiento","Resumen de la semana los lunes","Comprobantes guardados en cada pago","P&L mensual, listo para tu contador"], mock:"pagos"},
  ];
  const mockDe = (m) => {
    if (m==="envios") return ventana("Envíos · Seguimientos", <div>
      <div style={{display:"flex",alignItems:"center",gap:10,padding:"2px 0 12px"}}>
        <div style={{flex:1}}><div style={{fontSize:10.5,color:ink3}}>Saldo de envíos</div><div style={{fontSize:20,fontWeight:700,...num}}>$ 84.300</div></div>
        <div style={{textAlign:"right"}}><div style={{fontSize:10.5,color:ink3}}>Tu envío promedio</div><div style={{fontSize:14,fontWeight:700,...num}}>$ 6.850</div></div>
      </div>
      {[["#1482 · Córdoba","Entregado",T.green],["#1479 · CABA","En camino",T.blue],["#1475 · Rosario","En sucursal hace 4 días",T.orange],["#1471 · Mendoza","Visita fallida",T.red]].map(([p,e,c])=>(
        <div key={p}>{filaMock(p, estado(e,c), chip("andreani",14,26))}</div>
      ))}
    </div>);
    if (m==="stock") return ventana("Stock · Alertas", <div>
      {[["Producto A · Negro","12 u.","4 días",T.red,15],["Producto A · Blanco","48 u.","16 días",T.orange,45],["Producto B · Único","130 u.","41 días",T.green,85],["Producto C · Talle M","0 u.","Agotado",T.red,2]].map(([n,u,d,c,w])=>(
        <div key={n} style={{padding:"9px 0",borderTop:`1px solid ${lineL}`}}>
          <div style={{display:"flex",fontSize:12,marginBottom:5}}><span style={{flex:1,color:ink2}}>{n}</span><span style={{fontWeight:700,marginRight:10}}>{u}</span><span style={{fontWeight:700,color:c,width:62,textAlign:"right"}}>{d}</span></div>
          <div style={{height:5,borderRadius:4,background:T.bg}}><div style={{height:"100%",width:`${w}%`,borderRadius:4,background:c}}/></div>
        </div>
      ))}
      <div style={{fontSize:10.5,color:ink3,marginTop:8}}>Stock sumado de Tienda Nube, Shopify y Mercado Libre</div>
    </div>);
    if (m==="reclamos") return ventana("Reclamos · Qué hacer", <div>
      {[["Cambio de talle · #1463","Escribile al cliente",T.red],["Devolución · #1440","Esperando el producto",T.orange],["Cambio · #1421","Mandá el producto nuevo",T.red],["Llegó dañado · #1458","Resuelto",T.green]].map(([n,e,c])=>(
        <div key={n}>{filaMock(n, estado(e,c))}</div>
      ))}
      <div style={{marginTop:12,background:T.bg,border:`1px solid ${lineL}`,borderRadius:10,padding:"9px 11px",fontSize:11.5,color:ink2,lineHeight:1.5}}>“¡Hola Martina! Recibimos tu pedido de cambio de talle. Te pasamos los pasos para devolver el producto…”</div>
    </div>);
    if (m==="ml") return ventana("Mercado Libre · Preguntas", <div>
      {[["¿Tienen en color negro?","Respondida",T.green],["¿Llega antes del viernes?","Sin responder · 2 h",T.orange],["¿Hacen factura A?","Sin responder · 20 min",T.orange]].map(([p,e,c])=>(
        <div key={p}>{filaMock(p, estado(e,c))}</div>
      ))}
      <div style={{display:"flex",gap:8,marginTop:10}}>
        {[["Reputación","Verde"],["Preguntas hoy","14"],["Ventas hoy","9"]].map(([l,v])=>(
          <div key={l} style={{flex:1,background:T.bg,border:`1px solid ${lineL}`,borderRadius:10,padding:"6px 9px"}}><div style={{fontSize:9.5,color:ink3}}>{l}</div><div style={{fontSize:13,fontWeight:700}}>{v}</div></div>
        ))}
      </div>
    </div>);
    if (m==="campanas") return ventana("Publicidad · Campañas", <div>
      {[["meta","Prospección · Video","3,4x",T.green],["googleads","Búsqueda · Marca","5,1x",T.green],["meta","Remarketing 30 días","1,6x",T.red],["googleads","Performance Max","2,4x",T.green]].map(([b,n,r,c],i)=>(
        <div key={i}>{filaMock(n, <span style={{fontSize:12,fontWeight:700,color:c,...num}}>ROAS {r}</span>, chip(b,13,24))}</div>
      ))}
      <div style={{fontSize:10.5,color:ink3,marginTop:8}}>Break-even de la cuenta: 2,0x</div>
    </div>);
    if (m==="factura") return ventana("Facturador · ARCA", <div>
      {[["Factura B 0004-00001812","$ 58.900"],["Factura B 0004-00001811","$ 23.400"],["Factura A 0004-00000418","$ 112.000"],["Nota de crédito 0004-00000094","− $ 23.400"]].map(([f,mto])=>(
        <div key={f}>{filaMock(f, <span style={{display:"flex",gap:10,alignItems:"center"}}><span style={{fontWeight:700,color:ink,...num}}>{mto}</span><span style={{fontWeight:700,color:T.green}}>CAE ✓</span></span>)}</div>
      ))}
      <div style={{display:"flex",alignItems:"center",gap:8,marginTop:10}}>{chip("arca",16,28)}<span style={{fontSize:10.5,color:ink3}}>PDF con QR oficial, adjunto a la venta</span></div>
    </div>);
    return ventana("Calendario de pagos · Esta semana", <div>
      {[["Mañana","Alquiler del depósito","$ 850.000",T.orange],["Jueves","Proveedor de packaging","$ 320.000",ink2],["Viernes","Cuota del préstamo · 4/12","$ 410.000",ink2],["Vencido","Tarjeta corporativa","$ 1.240.000",T.red]].map(([d,n,mto,c])=>(
        <div key={n}>{filaMock(n, <span style={{fontWeight:700,color:ink,...num}}>{mto}</span>, <span style={{width:58,fontSize:10.5,fontWeight:700,color:c}}>{d}</span>)}</div>
      ))}
      <div style={{fontSize:10.5,color:ink3,marginTop:8}}>Te llega un mail el día anterior y el día del vencimiento</div>
    </div>);
  };

  const PESTANAS = ["Admin de la tienda","Mercado Libre","Portal de Andreani","ARCA","Administrador de anuncios","Planilla de stock","Excel de costos","Notas con los pagos del mes"];
  const AVISOS = [
    {gi:"clip", c:"#f97316", t:"Envíos trabados", d:"Resumen diario con los envíos demorados, en sucursal o con visita fallida."},
    {gi:"box", c:"#22c55e", t:"Stock por agotarse", d:"Alerta cuando a un producto le quedan pocos días, con el umbral que elijas."},
    {gi:"clock", c:"#6366f1", t:"Pagos por vencer", d:"Mail el día anterior y el mismo día de cada vencimiento."},
    {gi:"alert", c:"#ef4444", t:"Reclamos y preguntas", d:"Contadores en el menú de lo que te espera en cada sección."},
    {gi:"check", c:"#14b8a6", t:"Tareas por vencer", d:"Aviso a quien tiene la tarea antes de la fecha de entrega."},
    {gi:"ban", c:"#a855f7", t:"Etiquetas sin usar", d:"Las que nunca se despacharon se anulan solas y el saldo vuelve."},
  ];
  const CATEGORIAS = [
    {t:"Tiendas", d:"Pedidos, productos, stock y clientes.", items:[["tiendanube","Tienda Nube"],["shopify","Shopify"],["mercadolibre","Mercado Libre"]]},
    {t:"Publicidad", d:"Campañas y gasto publicitario.", items:[["meta","Meta Ads"],["googleads","Google Ads"],["mercadolibre","Mercado Ads"]]},
    {t:"Pagos", d:"Comisiones reales de cada medio de cobro.", items:[["mercadopago","Mercado Pago"],["pagonube","Pago Nube"],["pagospers","Pagos personalizados"],["recurrentes","Recurrentes",true]]},
    {t:"Logística", d:"Etiquetas, sucursales y seguimiento.", items:[["andreani","Andreani"]]},
    {t:"Facturación", d:"Factura electrónica con CAE y QR.", items:[["arca","ARCA"]]},
    {t:"Inteligencia artificial", d:"Consultá tu negocio desde la IA que ya usás.", items:[["Claude","Claude"],["ChatGPT","ChatGPT"],["Gemini","Gemini"]]},
  ];
  const EQUIPO = [
    {gi:"users", t:"Permisos por sección", d:"El que despacha ve Envíos, el de atención ve Reclamos. Vos ves todo."},
    {gi:"link", t:"Portal para colaboradores", d:"Diseñadores, editores e influencers reciben tareas con brief y fecha, sin crear cuenta."},
    {gi:"folder", t:"Varias tiendas, un login", d:"Manejá más de una marca y pasá de una a otra desde el menú."},
    {gi:"lock", t:"Conexiones oficiales", d:"Cada plataforma se conecta con su acceso oficial y la desconectás cuando quieras."},
  ];
  const FAQ = [
    ["¿Necesito tarjeta para probar?","No. Tenés 14 días gratis con todas las funciones, sin cargar ninguna tarjeta. Si te sirve, elegís un plan."],
    ["¿Cómo calcula Growith mi ganancia?","Cruza cada venta con el costo que cargás de cada producto, la comisión real que te cobró Mercado Pago o tu medio de pago, el envío y la parte de la publicidad que le toca. Los costos los podés traer de tu tienda en un clic."],
    ["¿Necesito contrato con Andreani para las etiquetas?","No. Cargás saldo en Growith (Mercado Pago o transferencia) y emitís las etiquetas desde tus pedidos. Antes de emitir ves el precio de cada una."],
    ["¿Con qué plataformas se conecta?","Tienda Nube, Shopify, Mercado Libre, Mercado Pago, Pago Nube, pagos personalizados, Meta Ads, Google Ads, Andreani y ARCA. Recurrentes llega pronto. Además podés consultar tu negocio desde Claude, ChatGPT o Gemini."],
    ["¿Sirve si vendo solo en Mercado Libre?","Sí. Podés conectar solo Mercado Libre y usar preguntas, mensajes, ventas, reputación, stock, reclamos y facturación."],
    ["¿La facturación sirve para Monotributo y Responsable Inscripto?","Sí. Growith emite comprobantes electrónicos en ARCA con CAE, PDF y QR, con varios CUITs y puntos de venta."],
    ["¿El plan se renueva solo? ¿Hay permanencia?","Si pagás con tarjeta, el plan se renueva cada mes (o cada año) y lo cancelás cuando quieras desde la sección Suscripción, sin permanencia: seguís usando lo que ya pagaste hasta el final del período."],
    ["¿Mi equipo puede usarlo?","Sí. Sumás personas y elegís qué secciones ve cada una. Para colaboradores externos hay un portal de tareas, sin crear cuenta."],
    ["¿Puedo manejar varias tiendas?","Sí. Con un solo login manejás varias marcas. Cada tienda adicional suma entre USD 5 y USD 15 por mes, según el plan."],
    ["¿Tienen soporte?","Sí, en español y con gente que vende en e-commerce todos los días. Escribinos a contacto.growith@gmail.com."],
  ];
  const NAV = [["Qué resuelve","gh-landing-diferencial"],["Secciones","gh-landing-modulos"],["Integraciones","gh-landing-integraciones"],["Precios","gh-landing-precios"],["Preguntas","gh-landing-faq"]];
  const PLANES_L = [
    {n:"Facturador", d:"Solo el facturador de ARCA, ilimitado", p:19, antes:29, anual:16, b:["Facturación ARCA ilimitada","Facturación automática de tu tienda y Mercado Libre","Facturas y notas de crédito manuales","Monotributo y Responsable Inscripto","Varios CUITs y puntos de venta"]},
    {n:"Intermedio", d:"Toda la operación de tu e-commerce", p:39, antes:59, anual:32, rec:true, b:["Todo lo del plan Facturador","Envíos con etiquetas Andreani","Stock cruzado entre canales","Mercado Libre integrado","Meta Ads y Mercado Ads","Reclamos, Canjes y Tareas ilimitados"]},
    {n:"Pro", d:"Todo Growith, con tu ganancia real", p:69, antes:99, anual:57, b:["Todo lo del plan Intermedio","Dashboard de rentabilidad en tiempo real","Tu ganancia real por venta: costos, comisiones y publicidad"]},
  ];
  const M = MODULOS[modulo];

  return (
    <div ref={landRef} className="gh-land-root" style={{fontFamily:F, background:T.bg, minHeight:"100vh", color:ink, WebkitFontSmoothing:"antialiased"}}>
      <GhMotionStyle T={T}/>
      <div className="gh-lm-progress" aria-hidden="true"><i/></div>
      <style>{`
        /* Las animaciones de entrada arrancan corridas: sin esto, en celular la página se estiraba hacia el costado. */
        .gh-land-root{overflow-x:hidden;overflow-x:clip;}
        .gh-land-btn{transition:filter .15s ease, transform .1s ease;} .gh-land-btn:hover{filter:brightness(1.12);} .gh-land-btn:active{transform:scale(.98);}
        .gh-land-tabs{display:flex;gap:6px;flex-wrap:wrap;}
        .gh-land-tab{border-radius:999px;border:1px solid ${line};background:transparent;color:${ink2};font:600 13.5px ${F};padding:9px 15px;cursor:pointer;display:inline-flex;align-items:center;gap:8px;white-space:nowrap;transition:background .15s, color .15s, border-color .15s;}
        .gh-land-tab:hover{color:${ink};}
        .gh-land-tab.on{background:${T.surface};color:${ink};border-color:${T.surface};}
        .gh-land-navlink{color:${ink2};} .gh-land-navlink:hover{color:${ink};}
        .gh-land-logo{opacity:0.75;filter:grayscale(1);transition:opacity .15s ease, filter .15s ease;} .gh-land-logo:hover{opacity:1;filter:none;}
        .gh-land-faqbtn:hover{color:${ink};}
        .gh-land-hero-in{animation:ghLandIn .7s cubic-bezier(.22,1,.36,1) both;}
        @keyframes ghLandIn{from{transform:translateY(12px)}to{transform:none}} /* sin opacidad: el texto se ve aunque la animación no corra */
        .gh-land-bar{display:none;}
        @media(max-width:1000px){ .gh-land-navlink{display:none!important;} }
        @media(max-width:900px){
          .gh-land-row{grid-template-columns:1fr!important;gap:32px!important;}
          .gh-land-g3{grid-template-columns:1fr!important;} .gh-land-g4{grid-template-columns:repeat(2,1fr)!important;} .gh-land-g2{grid-template-columns:1fr!important;}
          .gh-land-foot{grid-template-columns:1fr 1fr!important;}
          .gh-land-dif>div{border-left:none!important;border-top:1px solid ${lineL};}
          .gh-land-dif>div:first-child{border-top:none;}
          .gh-land-tabs{flex-wrap:nowrap;overflow-x:auto;margin:0 -24px;padding:0 24px 6px;scrollbar-width:none;} .gh-land-tabs::-webkit-scrollbar{display:none;}
        }
        @media(max-width:600px){
          .gh-land-g4{grid-template-columns:1fr!important;}
          .gh-land-kpis{grid-template-columns:repeat(2,1fr)!important;} .gh-land-kpis>div:nth-child(3){border-left:none!important;} .gh-land-kpis>div{border-top:1px solid ${lineL};}
          .gh-land-hide-m{display:none!important;}
          .gh-land-hero{padding-top:48px!important;}
          .gh-land-sec{padding:76px 0!important;}
          .gh-land-login{padding:8px 6px!important;font-size:13px!important;}
          .gh-land-navcta{display:none!important;}
          .gh-land-bar{display:flex;position:fixed;left:12px;right:12px;bottom:12px;z-index:70;gap:10px;align-items:center;padding:10px 10px 10px 16px;border-radius:999px;background:${T.card}f2;border:1px solid ${line};backdrop-filter:blur(12px);box-shadow:0 16px 40px -12px rgba(0,0,0,.6);transition:transform .25s ease, opacity .25s ease;}
          .gh-land-bar.off{transform:translateY(130%);opacity:0;pointer-events:none;}
          .gh-land-mini3>div:nth-child(3){display:none;}
        }
        @media (prefers-reduced-motion: reduce){ .gh-land-hero-in{animation:none;} }
      `}</style>

      {/* Nav */}
      <div style={{position:"sticky",top:0,zIndex:50,background:T.bg+"e6",backdropFilter:"blur(12px)",borderBottom:`1px solid ${lineL}`}}>
        <div style={{...WRAP,height:64,display:"flex",alignItems:"center",gap:4}}>
          <img src="/logo-color.png" alt="Growith" style={{width:26,height:26}}/>
          <span style={{fontSize:16.5,fontWeight:700,letterSpacing:-0.3,marginLeft:9,marginRight:22}}>Growith</span>
          {NAV.map(([l,id])=><button key={id} onClick={()=>irA(id)} className="gh-land-navlink" style={{background:"transparent",border:"none",cursor:"pointer",fontSize:13.5,fontFamily:F,padding:"6px 10px",fontWeight:500}}>{l}</button>)}
          <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:8,whiteSpace:"nowrap"}}>
            <button onClick={onLogin} className="gh-land-login" style={{background:"transparent",border:"none",cursor:"pointer",fontSize:13.5,fontFamily:F,padding:"8px 10px",fontWeight:500,color:ink2,whiteSpace:"nowrap"}}>Iniciar sesión</button>
            <span className="gh-land-navcta">{btnPri("Probar gratis", onLogin)}</span>
          </div>
        </div>
      </div>

      {/* Hero — visible desde el primer cuadro: nada acá depende del reveal. */}
      <div className="gh-land-hero" style={{...WRAP,padding:"96px 24px 0",textAlign:"center"}}>
        <div className="gh-land-hero-in" style={{display:"inline-flex",alignItems:"center",gap:8,fontSize:13,fontWeight:500,color:ink2,marginBottom:26,border:`1px solid ${line}`,borderRadius:999,padding:"6px 14px 6px 8px",flexWrap:"wrap",justifyContent:"center"}}>
          <span style={{display:"inline-flex",gap:4}}>{["tiendanube","shopify","mercadolibre"].map(b=><span key={b} style={{display:"inline-flex"}}>{marca(b,15)}</span>)}</span>
          Para Tienda Nube, Shopify y Mercado Libre
        </div>
        <h1 className="gh-land-hero-in" style={{fontSize:"clamp(38px,6.6vw,74px)",fontWeight:700,letterSpacing:-2.4,lineHeight:1.02,margin:"0 auto 24px",maxWidth:900}}>
          Vendés todos los días.<br/>
          <span style={{color:ink2}}>¿Sabés cuánto </span>
          <span style={{position:"relative",display:"inline-block",color:ink}}>ganás?<GhZig w="100%" h={22} c={BRAND} sw={4} style={{position:"absolute",left:0,right:0,bottom:-14,width:"100%"}}/></span>
        </h1>
        <p className="gh-land-hero-in" style={{fontSize:"clamp(16px,1.6vw,18.5px)",color:ink2,lineHeight:1.6,maxWidth:640,margin:"0 auto 34px",animationDelay:".08s"}}>
          Growith conecta tu tienda y te muestra la ganancia real de cada venta, con comisiones, envíos y publicidad descontados. Y desde el mismo lugar emitís las etiquetas de Andreani, facturás en ARCA y resolvés reclamos y stock.
        </p>
        <div className="gh-land-hero-in" style={{display:"flex",gap:10,justifyContent:"center",flexWrap:"wrap",animationDelay:".14s"}}>
          {btnPri("Probar gratis 14 días", onLogin, true)}
          {btnSec("Ver cómo funciona", ()=>irA("gh-landing-diferencial"), true)}
        </div>
        <div className="gh-land-hero-in" style={{display:"flex",gap:"6px 18px",justifyContent:"center",flexWrap:"wrap",fontSize:13,color:ink3,marginTop:20,animationDelay:".2s"}}>
          {["Sin tarjeta","Sin permanencia","En marcha en 5 minutos","Soporte en español"].map(x=><span key={x} style={{display:"inline-flex",alignItems:"center",gap:6}}><Check c={T.green}/>{x}</span>)}
        </div>

        <div className="gh-land-hero-in gh-lm-float" style={{margin:"64px auto 0",maxWidth:960,textAlign:"left",animationDelay:".25s"}}>
          <GhHeroLoop T={T} facetas={heroFacetas}/>
        </div>

        <div id="gh-landing-integs" style={{padding:"56px 0 88px"}}>
          <div style={{fontSize:12.5,color:ink3,fontWeight:500,marginBottom:20}}>Se conecta con lo que ya usás</div>
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

      {/* Los tres diferenciales */}
      <div id="gh-landing-diferencial" className="gh-land-sec" style={SEC}>
        <div style={WRAP}>
          {head("Qué resuelve","Tres cosas que hoy hacés a mano, resueltas","Lo que más tiempo y plata te come en un e-commerce argentino, en un solo lugar y con tus datos reales.")}
          <div className="gh-land-row" style={{display:"grid",gridTemplateColumns:"minmax(0,5fr) minmax(0,6fr)",gap:64,alignItems:"center",marginBottom:96}}>
            <div data-reveal="left">
              {kicker("01 · Tu ganancia real", T.green)}
              {h2("Cuánto te queda de cada venta, no cuánto vendiste")}
              <div style={{marginTop:14,marginBottom:24}}>{sub("Growith cruza cada venta con el costo del producto, la comisión que de verdad te cobró Mercado Pago, el envío y la parte de la publicidad que le toca. Lo ves por venta, por producto, por canal y por mes.")}</div>
              {lista(["Comisiones reales de Mercado Pago, no un porcentaje estimado","El gasto de Meta y Google entra solo","Costos traídos de tu tienda en un clic","P&L del mes listo para tu contador"], T.green)}
            </div>
            <div data-reveal="right">{ventana("Dashboard · Ganancia por venta", <div>
              {TICKET.map(([l,v,c,w],i)=>(
                <div key={l} style={{display:"flex",alignItems:"center",padding:"11px 0",borderTop:i?`1px dashed ${lineL}`:"none",fontSize:13.5}}>
                  <span style={{flex:1,color:i?ink2:ink,fontWeight:w||400}}>{l}</span>
                  <span style={{fontWeight:600,color:c,...num}}>{v}</span>
                </div>
              ))}
              <div style={{display:"flex",alignItems:"baseline",padding:"16px 0 2px",borderTop:`1px solid ${line}`,marginTop:4}}>
                <span style={{flex:1,fontSize:14,fontWeight:600}}>Te queda</span>
                <span style={{fontSize:30,fontWeight:700,letterSpacing:-1,color:T.green,...num}}>$ 22.360</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8,marginTop:8}}>
                <GhZig w={60} h={14} c={T.green} sw={2.5}/>
                <span style={{fontSize:12,color:ink3}}>38 % de margen sobre la venta</span>
              </div>
            </div>, {pad:"8px 18px 18px"})}</div>
          </div>

          <div className="gh-land-g2" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
            <div data-reveal="rise" style={{background:T.card,border:`1px solid ${line}`,borderRadius:18,padding:"28px 28px 24px",display:"flex",flexDirection:"column"}}>
              {kicker("02 · Etiquetas con saldo", "#f97316")}
              <div style={{fontSize:24,fontWeight:700,letterSpacing:-0.6,lineHeight:1.2,marginBottom:10}}>Etiquetas de Andreani sin contrato propio</div>
              <div style={{fontSize:15,color:ink2,lineHeight:1.6,marginBottom:22}}>Cargás saldo con Mercado Pago o transferencia y emitís desde tus pedidos. Ves el precio antes, y si te equivocás la anulás en 30 minutos.</div>
              <div style={{marginTop:"auto",display:"flex",alignItems:"center",gap:14,background:T.bg,border:`1px solid ${lineL}`,borderRadius:14,padding:"14px 16px"}}>
                {chip("andreani",22,44)}
                <div style={{flex:1,minWidth:0}}><div style={{fontSize:12,color:ink3}}>12 pedidos para despachar</div><div style={{fontSize:15,fontWeight:600}}>Etiquetas listas para imprimir</div></div>
                <span style={{fontSize:12,fontWeight:600,color:"#fff",background:"#f97316",borderRadius:999,padding:"7px 12px",whiteSpace:"nowrap"}}>Emitir 12</span>
              </div>
            </div>
            <div data-reveal="rise" data-reveal-delay="2" style={{background:T.card,border:`1px solid ${line}`,borderRadius:18,padding:"28px 28px 24px",display:"flex",flexDirection:"column"}}>
              {kicker("03 · Facturación en ARCA", "#eab308")}
              <div style={{fontSize:24,fontWeight:700,letterSpacing:-0.6,lineHeight:1.2,marginBottom:10}}>Tus ventas se facturan solas</div>
              <div style={{fontSize:15,color:ink2,lineHeight:1.6,marginBottom:22}}>Growith toma las ventas de tu tienda y de Mercado Libre y emite la factura con CAE, PDF y QR. Monotributo o Responsable Inscripto.</div>
              <div style={{marginTop:"auto",display:"flex",alignItems:"center",gap:14,background:T.bg,border:`1px solid ${lineL}`,borderRadius:14,padding:"14px 16px"}}>
                {chip("arca",22,44)}
                <div style={{flex:1,minWidth:0}}><div style={{fontSize:12,color:ink3}}>Ventas de hoy</div><div style={{fontSize:15,fontWeight:600}}>23 de 23 facturadas</div></div>
                <span style={{fontSize:12,fontWeight:700,color:T.green,border:`1px solid ${T.green}55`,borderRadius:999,padding:"6px 12px",whiteSpace:"nowrap"}}>CAE ✓</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Antes / después */}
      <div className="gh-land-sec" style={SEC}>
        <div style={WRAP}>
          <div className="gh-land-row" style={{display:"grid",gridTemplateColumns:"minmax(0,5fr) minmax(0,6fr)",gap:64,alignItems:"center"}}>
            <div data-reveal="left">
              {kicker("Todo en un lugar")}
              {h2("Tu negocio hoy está repartido en ocho pestañas")}
              <div style={{marginTop:14}}>{sub("Para saber cómo viene el día abrís la tienda, Mercado Libre, el portal de Andreani, ARCA, el administrador de anuncios y un par de planillas. Growith lo junta en una pantalla que te dice qué resolver primero.")}</div>
            </div>
            <div data-reveal="right" style={{display:"grid",gridTemplateColumns:"1fr auto 1fr",gap:14,alignItems:"center"}} className="gh-land-antes">
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {PESTANAS.map((p,i)=>(
                  <div key={p} style={{fontSize:12.5,color:ink3,border:`1px solid ${lineL}`,borderRadius:999,padding:"6px 12px",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",textDecoration:"line-through",textDecorationColor:ink3+"88",transform:`translateX(${(i%3)*6}px)`}}>{p}</div>
                ))}
              </div>
              <GhZig w={46} h={20} c={BRAND} sw={2.5}/>
              <div style={{background:T.card,border:`1px solid ${T.accentSolid}`,borderRadius:18,padding:"22px 20px",textAlign:"center"}}>
                <img src="/logo-color.png" alt="" style={{width:44,height:44,marginBottom:10}}/>
                <div style={{fontSize:17,fontWeight:700,marginBottom:4}}>Growith</div>
                <div style={{fontSize:12.5,color:ink3,lineHeight:1.5}}>Un login, un menú y todo lo pendiente del día en el Inicio</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Vitrina de secciones */}
      <div id="gh-landing-modulos" className="gh-land-sec" style={SEC}>
        <div style={WRAP}>
          {head("Secciones","Cada parte del negocio, con su lugar","Elegí una y mirá cómo se ve por dentro.",{mb:32})}
          <div data-reveal="rise" className="gh-land-tabs" role="tablist" style={{marginBottom:40}}>
            {MODULOS.map((m,i)=>(
              <button key={m.k} role="tab" aria-selected={i===modulo} className={"gh-land-tab"+(i===modulo?" on":"")} onClick={()=>setModulo(i)}>
                <span style={{width:7,height:7,borderRadius:4,background:m.c,display:"inline-block"}}/>{m.k}
              </button>
            ))}
          </div>
          <div key={M.k} className="gh-land-row gh-land-hero-in" style={{display:"grid",gridTemplateColumns:"minmax(0,5fr) minmax(0,6fr)",gap:64,alignItems:"center",minHeight:380}}>
            <div>
              {kicker(M.k, M.c)}
              <div style={{fontSize:"clamp(24px,2.8vw,32px)",fontWeight:700,letterSpacing:-0.8,lineHeight:1.15,marginBottom:14}}>{M.t}</div>
              <div style={{fontSize:16,color:ink2,lineHeight:1.6,marginBottom:22}}>{M.d}</div>
              {lista(M.b, M.c)}
            </div>
            <div>{mockDe(M.mock)}</div>
          </div>
        </div>
      </div>

      {/* Avisos + equipo */}
      <div id="gh-landing-avisos" className="gh-land-sec" style={SEC}>
        <div style={WRAP}>
          {head("Avisos","Te enterás antes de que sea un problema","No tenés que revisar todo el día: cuando algo necesita tu atención, Growith te avisa.")}
          <div className="gh-land-g3" style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16}}>
            {AVISOS.map((a,i)=>(
              <div key={a.t} data-reveal="rise" data-reveal-delay={String((i%3)+1)} style={{background:T.card,border:`1px solid ${lineL}`,borderRadius:16,padding:"20px 22px"}}>
                <span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:34,height:34,borderRadius:10,background:a.c+"1c",color:a.c,marginBottom:12}}><GhI n={a.gi} size={16}/></span>
                <div style={{fontSize:15.5,fontWeight:600,marginBottom:6}}>{a.t}</div>
                <div style={{fontSize:14,color:ink2,lineHeight:1.55}}>{a.d}</div>
              </div>
            ))}
          </div>
          <div className="gh-land-g4" style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:32,marginTop:72}}>
            {EQUIPO.map((s,i)=>(
              <div key={s.t} data-reveal="rise" data-reveal-delay={String(i+1)} style={{borderTop:`1px solid ${line}`,paddingTop:18}}>
                <span style={{color:ink3,display:"inline-flex",marginBottom:10}}><GhI n={s.gi} size={17}/></span>
                <div style={{fontSize:15,fontWeight:600,marginBottom:6}}>{s.t}</div>
                <div style={{fontSize:13.5,color:ink2,lineHeight:1.6}}>{s.d}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* IA */}
      <div id="gh-landing-ia" className="gh-land-sec" style={SEC}>
        <div style={WRAP}>
          <div className="gh-land-row" style={{display:"grid",gridTemplateColumns:"minmax(0,5fr) minmax(0,6fr)",gap:64,alignItems:"center"}}>
            <div data-reveal="left">
              <div style={{display:"flex",gap:8,marginBottom:16}}>{["Claude","ChatGPT","Gemini"].map(k=><span key={k}>{chip(k,18,36)}</span>)}</div>
              {h2("Preguntale por tu negocio a la IA que ya usás")}
              <div style={{marginTop:14,marginBottom:24}}>{sub("Conectá Growith a Claude, ChatGPT o Gemini y consultá ventas, ganancia, stock o envíos en una conversación. Solo lee tus datos: no cambia nada.")}</div>
              {lista(["Se conecta desde Configuración, en un par de pasos","Autorizás con tu cuenta de Growith","Lo desconectás cuando quieras"], T.accent)}
            </div>
            <div data-reveal="right">{ventana("Claude · con Growith conectado", <div style={{display:"flex",flexDirection:"column",gap:12}}>
              <div style={{alignSelf:"flex-end",maxWidth:"85%",background:T.surface,border:`1px solid ${lineL}`,borderRadius:"14px 14px 4px 14px",padding:"10px 13px",fontSize:13,lineHeight:1.55,color:ink}}>¿Qué producto me dejó más ganancia este mes?</div>
              <div style={{alignSelf:"flex-start",maxWidth:"92%",background:T.bg,border:`1px solid ${lineL}`,borderRadius:"14px 14px 14px 4px",padding:"11px 13px",fontSize:13,lineHeight:1.6,color:ink2}}>
                El <strong style={{color:ink}}>Producto A · Negro</strong>: dejó <strong style={{color:T.green}}>$ 1.180.000</strong> de ganancia con un 34 % de margen.<br/><br/>
                Ojo: le quedan <strong style={{color:ink}}>4 días de stock</strong> al ritmo de venta actual.
              </div>
            </div>)}</div>
          </div>
        </div>
      </div>

      {/* Hecho por una marca que vende */}
      {GH_LAND_MARCA && <div className="gh-land-sec" style={SEC}>
        <div style={{...WRAP,maxWidth:880,textAlign:"center"}}>
          <div data-reveal="rise">
            <GhZig w={120} h={24} c={BRAND} sw={3} style={{marginBottom:22}}/>
            <div style={{fontSize:"clamp(24px,3.2vw,36px)",fontWeight:600,letterSpacing:-0.9,lineHeight:1.25,color:ink}}>
              Growith nació adentro de un e-commerce argentino. <span style={{color:ink2}}>Lo hace el equipo de {GH_LAND_MARCA}, que vende en Tienda Nube y Mercado Libre y lo usa todos los días para despachar, facturar y saber cuánto gana.</span>
            </div>
            <div style={{fontSize:14,color:ink3,marginTop:20}}>Cada sección existe porque la necesitamos nosotros primero.</div>
          </div>
        </div>
      </div>}

      {/* Integraciones */}
      <div id="gh-landing-integraciones" className="gh-land-sec" style={SEC}>
        <div style={WRAP}>
          {head("Integraciones","Todo lo que ya usás, conectado","Con el acceso oficial de cada plataforma. Sin exportar planillas ni copiar datos.")}
          <div className="gh-land-g3" style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16}}>
            {CATEGORIAS.map((c,i)=>(
              <div key={c.t} data-reveal="rise" data-reveal-delay={String((i%3)+1)} style={{padding:"22px 24px",background:T.card,border:`1px solid ${lineL}`,borderRadius:16}}>
                <div style={{fontSize:15,fontWeight:600,marginBottom:4}}>{c.t}</div>
                <div style={{fontSize:13,color:ink3,lineHeight:1.5,marginBottom:14}}>{c.d}</div>
                <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  {c.items.map(([b,n,soon])=>(
                    <span key={n} style={{display:"inline-flex",alignItems:"center",gap:10,fontSize:13.5,fontWeight:500,color:ink}}>{chip(b,16,30)}{n}{soon&&pronto}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Cómo empezar */}
      <div className="gh-land-sec" style={SEC}>
        <div style={WRAP}>
          {head("Cómo empezar","En marcha en cinco minutos","Sin migraciones, sin importar planillas, sin implementación.")}
          <div className="gh-land-g3" style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:32}}>
            {[
              {n:"1",t:"Conectá tu tienda",d:"Tienda Nube, Shopify o Mercado Libre, con un par de clics y sin tocar código."},
              {n:"2",t:"Cargá tus costos",d:"Traelos de tu tienda en un clic o completalos a mano. Desde ahí, ves tu ganancia real."},
              {n:"3",t:"Manejá todo desde un lugar",d:"Despachá, facturá, respondé y reponé stock sin saltar entre apps."},
            ].map((p,i)=>(
              <div key={p.n} data-reveal="rise" data-reveal-delay={String(i+1)} style={{borderTop:`1px solid ${line}`,paddingTop:20}}>
                <div style={{width:32,height:32,borderRadius:16,border:`1px solid ${T.accentSolid}`,color:T.accent,display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:700,marginBottom:14}}>{p.n}</div>
                <div style={{fontSize:16.5,fontWeight:600,marginBottom:8}}>{p.t}</div>
                <div style={{fontSize:14,color:ink2,lineHeight:1.6}}>{p.d}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Precios */}
      <div id="gh-landing-precios" className="gh-land-sec" style={SEC}>
        <div style={WRAP}>
          {head("Precios","Planes simples, en dólares y sin letra chica","Probás gratis 14 días con todo incluido. Después elegís el plan que necesitás.",{center:true})}
          <div className="gh-land-g3" style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16,alignItems:"stretch"}}>
            {PLANES_L.map((p,i)=>(
              <div key={p.n} data-reveal="rise" data-reveal-delay={String(i+1)} style={{background:T.card,border:`1px solid ${p.rec?T.accentSolid:line}`,borderRadius:20,padding:"28px 26px 24px",display:"flex",flexDirection:"column"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
                  <div style={{fontSize:15.5,fontWeight:600}}>{p.n}</div>
                  {p.rec&&<span style={{fontSize:11,fontWeight:600,color:"#fff",background:T.accentSolid,borderRadius:999,padding:"3px 10px"}}>Recomendado</span>}
                </div>
                <div style={{fontSize:13,color:ink3,marginBottom:20}}>{p.d}</div>
                <div style={{display:"flex",alignItems:"baseline",gap:6}}>
                  <span style={{fontSize:46,fontWeight:700,letterSpacing:-1.8,lineHeight:1}}>${p.p}</span>
                  <span style={{fontSize:13,color:ink3,fontWeight:500}}>USD/mes</span>
                  <span style={{fontSize:13,color:ink3,textDecoration:"line-through",marginLeft:4}}>${p.antes}</span>
                </div>
                <div style={{fontSize:12.5,color:ink3,marginTop:8,marginBottom:22}}>o USD {p.anual}/mes pagando anual</div>
                <div style={{display:"flex",flexDirection:"column",gap:9,marginBottom:26,flex:1}}>
                  {p.b.map((x,j)=>(
                    <div key={x} style={{display:"flex",gap:9,alignItems:"flex-start",fontSize:13.5,color:j===0&&p.n!=="Facturador"?ink:ink2,fontWeight:j===0&&p.n!=="Facturador"?600:400,lineHeight:1.45}}><Check c={p.rec?T.accent:ink3}/>{x}</div>
                  ))}
                </div>
                <button onClick={onLogin} className="gh-land-btn" style={{background:p.rec?T.accentSolid:"transparent",border:`1px solid ${p.rec?T.accentSolid:line}`,color:p.rec?"#fff":ink,borderRadius:999,fontSize:14,fontWeight:600,padding:"13px",cursor:"pointer",fontFamily:F,width:"100%"}}>Probar gratis 14 días</button>
              </div>
            ))}
          </div>
          <div data-reveal style={{maxWidth:660,margin:"28px auto 0",textAlign:"center",fontSize:13.5,color:ink3,lineHeight:1.65}}>
            Sin tarjeta para probar · Sin permanencia: cancelás cuando quieras desde Suscripción.<br/>¿Más de una marca? Sumá tiendas a tu mismo login: <span style={{color:ink2}}>USD 5, 10 o 15 por mes</span> cada una, según el plan.
          </div>
        </div>
      </div>

      {/* Preguntas frecuentes */}
      <div id="gh-landing-faq" className="gh-land-sec" style={SEC}>
        <div style={{...WRAP,maxWidth:820}}>
          {head("Preguntas frecuentes","Lo que nos preguntan antes de empezar","Si te queda alguna duda, escribinos y te respondemos nosotros.")}
          <div style={{borderTop:`1px solid ${line}`}}>
            {FAQ.map(([q,a],i)=>{
              const abierta=faqAbierta===i;
              return (
                <div key={q} style={{borderBottom:`1px solid ${line}`}}>
                  <button onClick={()=>setFaqAbierta(abierta?-1:i)} aria-expanded={abierta} className="gh-land-faqbtn" style={{width:"100%",display:"flex",alignItems:"center",gap:16,padding:"19px 0",background:"transparent",border:"none",cursor:"pointer",textAlign:"left",fontFamily:F,fontSize:15.5,fontWeight:600,color:abierta?ink:ink2}}>
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
          <div data-reveal="rise" style={{background:T.card,border:`1px solid ${line}`,borderRadius:28,padding:"64px 24px",position:"relative",overflow:"hidden"}}>
            <div aria-hidden="true" style={{position:"absolute",inset:0,background:`radial-gradient(circle at 50% 0%, ${BRAND}22 0%, transparent 60%)`,pointerEvents:"none"}}/>
            <div style={{position:"relative"}}>
              <img src="/logo-color.png" alt="" style={{width:52,height:52,marginBottom:20}}/>
              <h2 style={{fontSize:"clamp(30px,4.6vw,50px)",fontWeight:700,letterSpacing:-1.5,lineHeight:1.06,margin:"0 auto 16px",maxWidth:720}}>Empezá a ver cuánto ganás de verdad</h2>
              <p style={{fontSize:17,color:ink2,maxWidth:520,margin:"0 auto 30px",lineHeight:1.6}}>14 días gratis con todo incluido. Conectás tu tienda en 5 minutos y Growith empieza a ordenar.</p>
              <div style={{display:"flex",gap:10,justifyContent:"center",flexWrap:"wrap"}}>
                {btnPri("Probar gratis 14 días", onLogin, true)}
                <a href="mailto:contacto.growith@gmail.com" className="gh-land-btn" style={{display:"inline-flex",alignItems:"center",border:`1px solid ${line}`,color:ink,borderRadius:999,fontSize:15.5,fontWeight:600,padding:"14px 26px",textDecoration:"none",fontFamily:F,lineHeight:1.2}}>Hablar con nosotros</a>
              </div>
              <div style={{fontSize:13,color:ink3,marginTop:18}}>Sin tarjeta · Sin permanencia · Soporte en español</div>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{borderTop:`1px solid ${lineL}`}}>
        <div style={{...WRAP,padding:"48px 24px 96px"}}>
          <div className="gh-land-foot" style={{display:"grid",gridTemplateColumns:"1.6fr 1fr 1fr 1fr",gap:28}}>
            <div>
              <div style={{display:"flex",alignItems:"center",gap:8,fontSize:15,fontWeight:700,marginBottom:10}}>
                <img src="/logo-color.png" alt="" style={{width:22,height:22}}/> Growith
              </div>
              <div style={{fontSize:13,color:ink3,lineHeight:1.6,maxWidth:300}}>La plataforma de gestión para e-commerce argentinos: tu ganancia real y toda la operación, en un solo lugar.</div>
            </div>
            <div>
              <div style={{fontSize:12,fontWeight:600,letterSpacing:0.6,textTransform:"uppercase",color:ink2,marginBottom:12}}>Producto</div>
              {[["Qué resuelve","gh-landing-diferencial"],["Secciones","gh-landing-modulos"],["Avisos","gh-landing-avisos"],["Precios","gh-landing-precios"],["Preguntas frecuentes","gh-landing-faq"]].map(([l,id])=>(
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
            <span>Partner: <a href="https://www.recurrentesapp.com/" style={{color:ink2,fontWeight:600,textDecoration:"none"}}>Recurrentes App</a> · suscripciones con Mercado Pago para tu tienda</span>
          </div>
        </div>
      </div>

      {/* Celular: botón fijo abajo, aparece pasado el hero */}
      <div className={"gh-land-bar"+(barra?"":" off")}>
        <div style={{flex:1,minWidth:0,fontSize:12.5,lineHeight:1.3}}><div style={{fontWeight:600}}>14 días gratis</div><div style={{color:ink3}}>Sin tarjeta</div></div>
        {btnPri("Probar gratis", onLogin)}
      </div>
    </div>
  );
}
