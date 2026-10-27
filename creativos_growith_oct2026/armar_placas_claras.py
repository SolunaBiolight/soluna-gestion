"""Segunda tanda de Growith (octubre 2026): 5 placas de feed 1080x1350 con fondos que rotan
(blanco, violeta, gris claro, lavanda). Misma familia que la tanda oscura: logo arriba,
la flecha en zigzag del logo como firma, una tarjeta con la app y el pie con el botón.

Uso:  python3 armar_todo.py  → anuncios 08-12, cada uno en FEED-4x5 e HISTORIA-9x16
"""
import os, subprocess
from comun import AQUI, MARCA, DATOS, VIOLETA, VIOLETA_SOLIDO, zig, check, exportar, FORMATOS, nombre_par, HIST

FECHA = "271026"
SALIDA = os.path.join(AQUI, "LISTAS_PARA_SUBIR")
D = DATOS

# Paletas de fondo (los colores de texto y tarjeta salen del tema claro de la app: LIGHT en shared.jsx)
VERDE_C = "#16a34a"
ROJO_C = "#dc2626"
NARANJA_C = "#ea580c"
AMARILLO_C = "#ca8a04"
FONDOS = {
    "blanco":  {"bg": "#ffffff", "card": "#ffffff", "borde": "#e4e4e7", "borde_l": "#f0f0f2", "txt": "#09090b", "md": "#52525b", "sm": "#a1a1aa",
                "glow": f"radial-gradient(circle at 85% 4%, {VIOLETA}1f 0%, transparent 42%)", "logo": "logo-color.png", "cta_bg": VIOLETA_SOLIDO, "cta_tx": "#fff", "zig": VIOLETA, "sombra": "0 40px 80px -40px rgba(24,24,27,.22)"},
    "gris":    {"bg": "#f4f4f5", "card": "#ffffff", "borde": "#e4e4e7", "borde_l": "#f0f0f2", "txt": "#09090b", "md": "#52525b", "sm": "#a1a1aa",
                "glow": f"radial-gradient(circle at 12% 0%, {VIOLETA}14 0%, transparent 40%)", "logo": "logo-color.png", "cta_bg": VIOLETA_SOLIDO, "cta_tx": "#fff", "zig": VIOLETA, "sombra": "0 40px 80px -40px rgba(24,24,27,.22)"},
    "lavanda": {"bg": "#f3effe", "card": "#ffffff", "borde": "#e2d9fb", "borde_l": "#efe9fd", "txt": "#1a1033", "md": "#5b5276", "sm": "#9c94b5",
                "glow": f"radial-gradient(circle at 90% 100%, {VIOLETA}24 0%, transparent 45%)", "logo": "logo-color.png", "cta_bg": VIOLETA_SOLIDO, "cta_tx": "#fff", "zig": VIOLETA, "sombra": "0 40px 80px -40px rgba(76,29,149,.25)"},
    "violeta": {"bg": VIOLETA_SOLIDO, "card": "#ffffff", "borde": "#ffffff33", "borde_l": "#f0f0f2", "txt": "#ffffff", "md": "#e9e2ff", "sm": "#c8b8fb",
                "glow": "radial-gradient(circle at 85% 0%, #a78bfa88 0%, transparent 50%), radial-gradient(circle at 0% 100%, #4c1d9588 0%, transparent 50%)", "logo": "logo-blanco.png", "cta_bg": "#ffffff", "cta_tx": VIOLETA_SOLIDO, "zig": "#ffffff", "sombra": "0 40px 90px -40px rgba(30,10,80,.55)"},
}


def pagina_clara(cuerpo, f, css_extra="", h=1350):
    p = FONDOS[f]
    css = f"""
*{{box-sizing:border-box;margin:0;padding:0}}
html,body{{width:1080px;height:{h}px;background:{p["bg"]};overflow:hidden}}
body{{font-family:'Inter',system-ui,sans-serif;color:{p["txt"]};-webkit-font-smoothing:antialiased;position:relative}}
.glow{{position:absolute;inset:0;background:{p["glow"]};pointer-events:none}}
.lienzo{{position:absolute;inset:0;padding:76px 80px;display:flex;flex-direction:column}}
.marca{{display:flex;align-items:center;gap:16px;font-size:34px;font-weight:700;letter-spacing:-.5px}}
.marca img{{width:48px;height:48px}}
.medio{{flex:1;display:flex;flex-direction:column;justify-content:center;padding:20px 0 40px}}
.medio>:first-child{{margin-top:0!important}}
.kicker{{display:inline-flex;align-items:center;gap:12px;font-size:24px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:{p["sm"]}}}
.kicker i{{width:12px;height:12px;border-radius:6px;display:inline-block}}
h1{{font-size:88px;line-height:1.03;letter-spacing:-3.2px;font-weight:700}}
h1 .gris{{color:{p["md"]};}}
.sub{{font-size:32px;line-height:1.45;color:{p["md"]}}}
.card{{background:{p["card"]};border:1.5px solid {p["borde"] if f != "violeta" else "transparent"};border-radius:32px;box-shadow:{p["sombra"]};color:#09090b}}
.barra{{display:flex;align-items:center;gap:12px;padding:22px 30px;border-bottom:1.5px solid #f0f0f2;font-size:22px;color:#52525b;font-weight:600}}
.barra .p{{width:13px;height:13px;border-radius:7px;background:#e4e4e7}}
.barra .tag{{margin-left:auto;font-size:17px;letter-spacing:1px;text-transform:uppercase;color:#a1a1aa;font-weight:500}}
.num{{font-variant-numeric:tabular-nums}}
.pie{{display:flex;align-items:center;gap:22px}}
.cta{{background:{p["cta_bg"]};color:{p["cta_tx"]};border-radius:999px;padding:24px 40px;font-size:30px;font-weight:600;white-space:nowrap}}
.pie .txt{{font-size:24px;color:{p["sm"]};line-height:1.4}} .pie .txt b{{color:{p["txt"]};font-weight:600}}
"""
    return f"""<!doctype html><html lang="es"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=block">
<style>{css}{HIST if h > 1400 else ""}{css_extra}</style></head><body><div class="glow"></div><div class="lienzo">
<div class="marca"><img src="{MARCA}/{p["logo"]}" alt="">Growith</div>
<div class="medio">{cuerpo}</div>
{pie()}
</div></body></html>"""


def pie(texto=None, cta="Probar gratis"):
    t = texto or f'<b>{D["prueba"]}</b> · {D["sin_tarjeta"]}<br>{D["web"]}'
    return f'<div class="pie"><span class="cta">{cta}</span><span class="txt">{t}</span></div>'


# ── 11 · Blanco · Calendario de pagos: "el alquiler vence mañana" ─────────
def pagos(h=1350):
    filas = [("Mañana", "Alquiler del depósito", "$ 850.000", NARANJA_C), ("Jueves", "Proveedor de packaging", "$ 320.000", "#52525b"),
             ("Viernes", "Cuota del préstamo · 4/12", "$ 410.000", "#52525b"), ("Vencido", "Tarjeta corporativa", "$ 1.240.000", ROJO_C)]
    fl = "".join(f'<div class="fr"><em style="color:{c}">{d}</em><span>{n}</span><b class="num">{m}</b></div>' for d, n, m, c in filas)
    return pagina_clara(f"""
<div class="noti"><img src="{MARCA}/logo-color.png"><div><b>Growith · Calendario de pagos</b><span>Mañana vence el alquiler del depósito: $ 850.000</span></div><small>ahora</small></div>
<h1 style="margin-top:56px">El alquiler vence mañana.<br><span class="gris">Growith ya te avisó.</span></h1>
<div class="card" style="margin-top:44px">
  <div class="barra"><span class="p"></span><span class="p"></span><span class="p"></span>&nbsp;Esta semana<span class="tag">Datos de ejemplo</span></div>
  <div style="padding:6px 34px 14px">{fl}</div>
</div>
""", "blanco", h=h, css_extra=f"""
.noti{{display:flex;align-items:center;gap:20px;background:#f4f4f5;border:1.5px solid #e4e4e7;border-radius:28px;padding:22px 26px}}
.noti img{{width:56px;height:56px;border-radius:14px;background:#fff;padding:6px;border:1.5px solid #e4e4e7}}
.noti b{{display:block;font-size:22px;margin-bottom:4px}} .noti span{{font-size:24px;color:#3f3f46}} .noti div{{flex:1}} .noti small{{font-size:20px;color:#a1a1aa;align-self:flex-start}}
.fr{{display:flex;align-items:center;gap:22px;font-size:26px;padding:19px 0;border-top:1.5px solid #f0f0f2}} .fr:first-child{{border-top:none}}
.fr em{{font-style:normal;font-weight:700;font-size:22px;width:110px}} .fr span{{flex:1;color:#3f3f46}} .fr b{{font-weight:700}}
""")


# ── 12 · Violeta · Comisión real de Mercado Pago ────────────────────────
def comision(h=1350):
    filas = [("#1482 · 1 pago", "$ 58.900", "$ 3.590", "6,1 %"), ("#1479 · 3 cuotas sin interés", "$ 41.200", "$ 4.980", "12,1 %"),
             ("#1476 · Promo sin comisión", "$ 23.400", "$ 0", "0 %")]
    fl = "".join(f'<div class="fr"><span>{a}<small class="num">{b}</small></span><b class="num">− {c}</b><em class="num">{d}</em></div>' for a, b, c, d in filas)
    return pagina_clara(f"""
<h1 style="font-size:80px;letter-spacing:-2.8px">No es “más o menos<br>el 7 %”.<br><span class="gris">Es lo que te cobraron.</span></h1>
<div class="sub" style="margin-top:24px">Growith lee la comisión real de Mercado Pago en cada venta: cuotas, promos y todo.</div>
<div class="card" style="margin-top:48px">
  <div class="barra"><img src="{MARCA}/mercadopago.png" style="height:28px">&nbsp;Comisión por venta<span class="tag">Datos de ejemplo</span></div>
  <div style="padding:6px 34px 16px">{fl}</div>
</div>
<div style="margin-top:40px">{zig(200, 36, "#ffffff", 6)}</div>
""", "violeta", h=h, css_extra=f"""
.fr{{display:flex;align-items:center;gap:20px;font-size:26px;padding:20px 0;border-top:1.5px solid #f0f0f2;color:#3f3f46}} .fr:first-child{{border-top:none}}
.fr span{{flex:1}} .fr small{{display:block;font-size:21px;color:#a1a1aa;margin-top:4px}}
.fr b{{color:#09090b;font-weight:700}} .fr em{{font-style:normal;font-weight:700;color:{VIOLETA_SOLIDO};background:#f3effe;border-radius:999px;padding:6px 16px;font-size:22px;min-width:100px;text-align:center}}
""")


# ── 13 · Gris · Stock: "le quedan 4 días" ───────────────────────────────
def stock(h=1350):
    filas = [("Producto A · Negro", "12 u.", "4 días", ROJO_C, 15), ("Producto A · Blanco", "48 u.", "16 días", NARANJA_C, 45),
             ("Producto B · Único", "130 u.", "41 días", VERDE_C, 85)]
    fl = "".join(f'<div class="fr"><div class="top"><span>{n}</span><b class="num">{u}</b><em style="color:{c}">{d}</em></div><div class="bar"><i style="width:{w}%;background:{c}"></i></div></div>' for n, u, d, c, w in filas)
    return pagina_clara(f"""
<div class="dias num">4<span> días</span></div>
<h1 style="font-size:76px;letter-spacing:-2.6px">de stock le quedan a tu<br>producto más vendido.<br><span class="gris">Te enterás hoy, no cuando se agota.</span></h1>
<div class="card" style="margin-top:44px">
  <div class="barra"><span class="p"></span><span class="p"></span><span class="p"></span>&nbsp;Stock · Tienda Nube + Mercado Libre<span class="tag">Ejemplo</span></div>
  <div style="padding:8px 34px 20px">{fl}</div>
</div>
""", "gris", h=h, css_extra=f"""
.dias{{font-size:230px;font-weight:800;letter-spacing:-11px;line-height:.9;color:{ROJO_C}}} .dias span{{font-size:80px;letter-spacing:-2px;color:#09090b}}
.fr{{padding:16px 0;border-top:1.5px solid #f0f0f2}} .fr:first-child{{border-top:none}}
.top{{display:flex;align-items:center;gap:18px;font-size:25px;margin-bottom:10px}} .top span{{flex:1;color:#3f3f46}} .top b{{font-weight:700}} .top em{{font-style:normal;font-weight:700;width:120px;text-align:right}}
.bar{{height:10px;border-radius:6px;background:#f4f4f5}} .bar i{{display:block;height:100%;border-radius:6px}}
""")


# ── 14 · Blanco · Reclamos: el mensaje ya escrito ───────────────────────
def reclamos(h=1350):
    return pagina_clara(f"""
<div class="kicker"><i style="background:{ROJO_C}"></i>Reclamos y cambios</div>
<h1 style="margin-top:22px">Un cambio de talle.<br><span class="gris">El mensaje ya escrito.</span></h1>
<div class="card" style="margin-top:48px">
  <div class="barra"><span class="p"></span><span class="p"></span><span class="p"></span>&nbsp;Cambio · pedido #1463<span class="tag">Ejemplo</span></div>
  <div style="padding:28px 34px 32px">
    <div class="paso"><span class="dot"></span>Ahora: <b>escribile al cliente</b></div>
    <div class="msg">¡Hola Martina! Recibimos tu pedido de cambio de talle. Te pasamos los pasos para devolver el producto y te mandamos el nuevo apenas llegue.</div>
    <div class="btns"><span class="b1">Abrir WhatsApp</span><span class="b2">Copiar</span><span class="b2">Mail</span></div>
  </div>
</div>
<div class="etapas">{"".join(f'<span class="{c}">{t}</span>' for t, c in [("Nuevo","ok"),("Contactado","on"),("Producto recibido",""),("Resuelto","")])}</div>
""", "blanco", h=h, css_extra=f"""
.paso{{display:flex;align-items:center;gap:14px;font-size:26px;color:#52525b;margin-bottom:20px}} .paso b{{color:#09090b}}
.dot{{width:14px;height:14px;border-radius:7px;background:{ROJO_C}}}
.msg{{background:#f4f4f5;border-radius:24px 24px 24px 8px;padding:24px 28px;font-size:27px;line-height:1.5;color:#27272a}}
.btns{{display:flex;gap:12px;margin-top:22px}} .btns span{{border-radius:999px;padding:14px 26px;font-size:23px;font-weight:600}}
.b1{{background:#09090b;color:#fff}} .b2{{border:1.5px solid #e4e4e7;color:#27272a}}
.etapas{{display:flex;gap:10px;margin-top:34px;flex-wrap:wrap}} .etapas span{{font-size:22px;border:1.5px solid #e4e4e7;color:#a1a1aa;border-radius:999px;padding:10px 20px;font-weight:500}}
.etapas .ok{{color:#52525b}} .etapas .on{{background:{VIOLETA_SOLIDO};border-color:{VIOLETA_SOLIDO};color:#fff;font-weight:600}}
""")


# ── 15 · Lavanda · Un día con Growith ───────────────────────────────────
def dia(h=1350):
    filas = [("08:30", "Abrís el Inicio y ves todo lo pendiente"), ("09:00", "Mirás la ganancia de ayer"), ("10:00", "Emitís las etiquetas de Andreani"),
             ("13:00", "Las ventas ya están facturadas en ARCA"), ("18:00", "Reponés el producto que se agota")]
    fl = "".join(f'<div class="fr"><em class="num">{h}</em><span class="d"></span><span>{t}</span></div>' for h, t in filas)
    return pagina_clara(f"""
<h1>Todo tu día de trabajo,<br><span class="gris">desde una sola pantalla.</span></h1>
<div class="card linea" style="margin-top:52px">{fl}</div>
<div class="sub" style="margin-top:36px;font-size:28px">Tienda Nube, Shopify y Mercado Libre conectados.</div>
""", "lavanda", h=h, css_extra=f"""
.linea{{padding:20px 40px;position:relative}}
.linea:before{{content:"";position:absolute;left:170px;top:50px;bottom:50px;width:3px;background:#e2d9fb}}
.fr{{display:flex;align-items:center;gap:26px;font-size:29px;padding:20px 0;color:#1a1033;position:relative}}
.fr em{{font-style:normal;font-weight:700;color:{VIOLETA_SOLIDO};width:96px;font-size:26px}}
.fr .d{{width:18px;height:18px;border-radius:9px;background:#fff;border:4px solid {VIOLETA};flex-shrink:0;position:relative;z-index:1}}
""")


PIEZAS = [
    (8, "MOFU", "pagos-vence-manana", pagos),
    (9, "TOFU", "comision-real-mp", comision),
    (10, "MOFU", "stock-4-dias", stock),
    (11, "MOFU", "reclamos-mensaje", reclamos),
    (12, "TOFU", "un-dia", dia),
]


def main():
    os.makedirs(SALIDA, exist_ok=True)
    hechos = []
    for n, etapa, slug, fn in PIEZAS:
        for h, _ in FORMATOS:
            nombre = nombre_par(n, etapa, slug, FECHA, h)
            hechos.append(exportar(fn(h), os.path.join(SALIDA, nombre + ".png"), h=h))
            print("ok", nombre)
    return hechos

if __name__ == "__main__":
    main()
