"""Tanda de lanzamiento de Growith (octubre 2026): placas de Meta 1080x1350 e historias 1080x1920.

Uso:  python3 armar_placas.py
Sale: LISTAS_PARA_SUBIR/ numerada en el orden de subida, html/ con cada pieza y hoja_contacto.jpg.
Los números y textos que se repiten viven en comun.DATOS (iguales a la landing).
Nada de lo que se promete está apagado hoy: no se habla de publicar ni pausar campañas
(PUBLICADORES_ARCHIVADOS), ni de TikTok, ni del 1 clic de Shopify.
"""
import os, subprocess
from comun import *

FECHA = "271026"
SALIDA = os.path.join(AQUI, "LISTAS_PARA_SUBIR")
D = DATOS


# ── 01 · El ticket: vendiste X, te quedó Y ─────────────────────────────
def ticket(h=1350):
    filas = [("Costo del producto", D["costo"]), ("Comisión real de Mercado Pago", D["comision_mp"]),
             ("Envío Andreani", D["envio"]), ("Publicidad que le corresponde", D["publicidad"])]
    lineas = "".join(f'<div class="f"><span>{l}</span><span class="num">{v}</span></div>' for l, v in filas)
    alto = h > 1400
    return pagina(f"""
{marca_html()}<div class="medio">
<h1 style="margin-top:{90 if alto else 56}px">Vendiste {D["venta"]}.<br><span class="gris">¿Cuánto te quedó?</span></h1>
<div class="ticket" style="margin-top:{80 if alto else 48}px">
  <div class="f top"><span>Venta #1482 · Tienda Nube</span><span class="num">{D["venta"]}</span></div>
  {lineas}
  <div class="tot"><span>Te queda</span><span class="num">{D["queda"]}</span></div>
  <div class="mg">{zig(110, 24, VERDE, 5)}<span>{D["margen"]} de margen · datos de ejemplo</span></div>
</div>
{"<div class='sub' style='margin-top:56px'>Growith te muestra la ganancia real de cada venta, con la comisión que de verdad te cobraron.</div>" if alto else ""}
</div>{pie_html()}
""", h=h, css_extra=f"""
.ticket{{background:{CARD};border:1.5px solid {BORDE};border-radius:32px;padding:18px 44px 34px;position:relative}}
.ticket:before,.ticket:after{{content:"";position:absolute;top:50%;width:44px;height:44px;border-radius:22px;background:{BG};transform:translateY(-50%)}}
.ticket:before{{left:-23px;border-right:1.5px solid {BORDE}}} .ticket:after{{right:-23px;border-left:1.5px solid {BORDE}}}
.f{{display:flex;justify-content:space-between;font-size:29px;color:{TEXTO_MD};padding:17px 0;border-top:2px dashed {BORDE_L}}}
.f.top{{border-top:none;color:{TEXTO};font-weight:600}}
.tot{{display:flex;justify-content:space-between;align-items:baseline;border-top:2px solid {BORDE};margin-top:8px;padding-top:24px;font-size:34px;font-weight:600}}
.tot .num{{font-size:76px;font-weight:700;color:{VERDE};letter-spacing:-2.5px}}
.mg{{display:flex;align-items:center;gap:16px;font-size:24px;color:{TEXTO_MD};margin-top:8px}}
""")


# ── 02 · Ocho pestañas → una ───────────────────────────────────────────
def pestanas():
    tabs = ["Admin de la tienda", "Mercado Libre", "Portal de Andreani", "ARCA", "Administrador de anuncios",
            "Planilla de stock", "Excel de costos", "Notas con los pagos"]
    chips = "".join(f'<div class="tab" style="margin-left:{(i % 3) * 22}px">{t}</div>' for i, t in enumerate(tabs))
    return pagina(f"""
{marca_html()}<div class="medio">
<h1 style="margin-top:56px">Cerrá ocho pestañas.<br><span class="gris">Abrí una.</span></h1>
<div class="fila">
  <div class="tabs">{chips}</div>
  <div class="flecha">{zig(120, 50, VIOLETA, 6)}</div>
  <div class="uno card"><img src="{MARCA}/logo-color.png"><b>Growith</b><span>Tu tienda, Mercado Libre, envíos, ARCA y publicidad en un solo lugar</span></div>
</div>
</div>{pie_html()}
""", css_extra=f"""
.fila{{display:flex;align-items:center;gap:28px;margin-top:64px}}
.tabs{{display:flex;flex-direction:column;gap:13px;flex:1}}
.tab{{font-size:25px;color:{TEXTO_SM};border:1.5px solid {BORDE};border-radius:999px;padding:13px 24px;white-space:nowrap;text-decoration:line-through;text-decoration-color:{TEXTO_SM}99;width:max-content}}
.uno{{width:330px;padding:44px 30px;text-align:center;border-color:{VIOLETA_SOLIDO};display:flex;flex-direction:column;align-items:center;gap:12px}}
.uno img{{width:96px;height:96px;margin-bottom:6px}} .uno b{{font-size:38px}} .uno span{{font-size:22px;color:{TEXTO_MD};line-height:1.45}}
""")


# ── 03 · Etiquetas de Andreani con saldo ───────────────────────────────
def etiquetas(h=1350):
    alto = h > 1400
    return pagina(f"""
{marca_html()}<div class="medio">
<div class="kicker" style="margin-top:{90 if alto else 60}px"><i style="background:{NARANJA}"></i>Envíos con saldo</div>
<h1 style="margin-top:22px">Etiquetas de Andreani<br><span class="gris">sin contrato propio.</span></h1>
<div class="card env" style="margin-top:{70 if alto else 48}px">
  <div class="barra"><span class="p"></span><span class="p"></span><span class="p"></span>&nbsp;Envíos<span class="tag">Datos de ejemplo</span></div>
  <div class="saldo"><div><small>Saldo de envíos</small><b class="num">$ 84.300</b></div><div style="text-align:right"><small>Tu envío promedio</small><b class="num" style="font-size:36px">$ 6.850</b></div></div>
  <div class="lote"><img src="{MARCA}/andreani-iso.png"><div style="flex:1"><small>12 pedidos para despachar</small><div class="t">Precio de cada etiqueta antes de emitir</div></div><span class="btn">Emitir 12</span></div>
</div>
<div class="puntos">
  <div>{check(NARANJA, 30)}Cargás saldo con Mercado Pago o transferencia</div>
  <div>{check(NARANJA, 30)}Si te equivocás, la anulás en {D["anular_min"]} y el saldo vuelve</div>
  <div>{check(NARANJA, 30)}Con el SKU impreso, listas para imprimir en tanda</div>
</div>
</div>{pie_html()}
""", h=h, css_extra=f"""
.saldo{{display:flex;justify-content:space-between;align-items:flex-end;padding:28px 34px 22px}}
.saldo small,.lote small{{display:block;font-size:20px;color:{TEXTO_SM};margin-bottom:6px}} .saldo b{{font-size:52px;font-weight:700;letter-spacing:-1.5px}}
.lote{{display:flex;align-items:center;gap:22px;margin:0 34px 30px;background:{BG};border:1.5px solid {BORDE_L};border-radius:24px;padding:22px 24px}}
.lote img{{width:62px;height:62px;object-fit:contain}} .lote .t{{font-size:26px;font-weight:600}}
.btn{{background:{NARANJA};color:#fff;font-size:24px;font-weight:600;border-radius:999px;padding:14px 26px;white-space:nowrap}}
.puntos{{display:flex;flex-direction:column;gap:16px;margin-top:40px;font-size:28px;color:{TEXTO}}}
.puntos div{{display:flex;gap:16px;align-items:center}}
""")


# ── 04 · Facturado no es ganado ─────────────────────────────────────────
def facturado():
    return pagina(f"""
{marca_html()}<div class="medio">
<h1 style="margin-top:56px">Facturar no es ganar.</h1>
<div class="sub" style="margin-top:22px;max-width:860px">Growith le resta a cada venta lo que de verdad te cuesta: mercadería, comisiones, envíos y publicidad.</div>
<div class="cmp">
  <div class="col"><small>Facturaste este mes</small><b class="num tachado">$ 12,4M</b><span>lo que ves en tu tienda</span></div>
  <div class="col win"><small>Te quedó</small><b class="num">$ 3,4M</b><span>27,4 % de margen</span>{zig(190, 34, VERDE, 6)}</div>
</div>
<div class="mini">Datos de ejemplo · con Tienda Nube, Shopify y Mercado Libre juntos</div>
</div>{pie_html()}
""", css_extra=f"""
.cmp{{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin-top:64px}}
.col{{background:{CARD};border:1.5px solid {BORDE};border-radius:32px;padding:40px 36px;display:flex;flex-direction:column;gap:10px}}
.col small{{font-size:24px;color:{TEXTO_SM}}} .col b{{font-size:104px;white-space:nowrap;font-weight:700;letter-spacing:-3.5px;line-height:1.05}} .col span{{font-size:24px;color:{TEXTO_MD}}}
.tachado{{color:{TEXTO_SM};text-decoration:line-through;text-decoration-thickness:5px;text-decoration-color:{TEXTO_SM}aa}}
.win{{border-color:{VERDE}66}} .win b{{color:{VERDE}}} .win svg{{margin-top:10px}}
.mini{{font-size:21px;color:{TEXTO_SM};margin-top:22px}}
""")


# ── 05 · ARCA: 23 de 23 ─────────────────────────────────────────────────
def arca():
    filas = [("Factura B 0004-00001812", "$ 58.900"), ("Factura B 0004-00001811", "$ 23.400"), ("Factura A 0004-00000418", "$ 112.000")]
    fl = "".join(f'<div class="fr"><span>{a}</span><b class="num">{b}</b><em>CAE ✓</em></div>' for a, b in filas)
    return pagina(f"""
{marca_html()}<div class="medio">
<div class="kicker" style="margin-top:60px"><i style="background:{AMARILLO}"></i>Facturación en ARCA</div>
<div class="big num">23<span>/23</span></div>
<h1 style="font-size:72px;letter-spacing:-2.5px">ventas de hoy facturadas.<br><span class="gris">Sin copiar un solo dato.</span></h1>
<div class="card" style="margin-top:44px;padding:8px 34px 18px">{fl}</div>
</div>{pie_html(f'<b>Monotributo y Responsable Inscripto</b><br>{D["prueba"]} · {D["sin_tarjeta"]}')}
""", css_extra=f"""
.big{{font-size:250px;font-weight:800;letter-spacing:-12px;line-height:.9;margin-top:24px}} .big span{{color:{TEXTO_SM}}}
.fr{{display:flex;align-items:center;gap:20px;font-size:26px;color:{TEXTO_MD};padding:20px 0;border-top:1.5px solid {BORDE_L}}}
.fr:first-child{{border-top:none}} .fr span{{flex:1}} .fr b{{color:{TEXTO};font-weight:700}} .fr em{{font-style:normal;color:{VERDE};font-weight:700}}
""")


# ── 06 · Preguntale a tu IA ──────────────────────────────────────────────
def ia():
    return pagina(f"""
{marca_html()}<div class="medio">
<h1 style="margin-top:56px;font-size:84px">Preguntale por tu negocio<br><span class="gris">a la IA que ya usás.</span></h1>
<div class="chat">
  <div class="yo">¿Qué producto me dejó más ganancia este mes?</div>
  <div class="ia">El <b>Producto A · Negro</b>: dejó <b style="color:{VERDE}">$ 1.180.000</b> de ganancia, con 34 % de margen.<br><br>Ojo: le quedan <b>4 días de stock</b> al ritmo de venta actual.</div>
</div>
<div class="ias"><span class="chip">Claude</span><span class="chip">ChatGPT</span><span class="chip">Gemini</span><span class="nota">Solo lee tus datos · datos de ejemplo</span></div>
</div>{pie_html()}
""", css_extra=f"""
.chat{{display:flex;flex-direction:column;gap:22px;margin-top:56px}}
.yo{{align-self:flex-end;max-width:80%;background:{CARD};border:1.5px solid {BORDE};border-radius:32px 32px 8px 32px;padding:26px 32px;font-size:32px;line-height:1.4}}
.ia{{align-self:flex-start;max-width:90%;background:{BG};border:1.5px solid {BORDE};border-radius:32px 32px 32px 8px;padding:30px 34px;font-size:30px;line-height:1.5;color:{TEXTO_MD}}}
.ia b{{color:{TEXTO}}}
.ias{{display:flex;gap:14px;align-items:center;margin-top:36px;flex-wrap:wrap}} .nota{{font-size:21px;color:{TEXTO_SM};margin-left:8px}}
""")


# ── 07 · La oferta ──────────────────────────────────────────────────────
def oferta(h=1350):
    alto = h > 1400
    items = ["Tu ganancia real por venta", "Etiquetas de Andreani con saldo", "Facturación en ARCA", "Stock de todos tus canales",
             "Reclamos y Mercado Libre", "Meta y Google contra tu break-even"]
    li = "".join(f'<div>{check(VIOLETA, 32)}{x}</div>' for x in items)
    logos = f'<span class="chip"><img src="{MARCA}/tiendanube.png">Tienda Nube</span><span class="chip">Shopify</span><span class="chip"><img src="{MARCA}/mercadolibre.svg">Mercado Libre</span>'
    return pagina(f"""
{marca_html()}<div class="medio">
<div style="margin-top:{120 if alto else 64}px">{zig(240, 46, VIOLETA, 7)}</div>
<h1 style="margin-top:30px;font-size:{120 if alto else 104}px;letter-spacing:-4.5px">14 días gratis.<br><span class="gris">Con todo.</span></h1>
<div class="sub" style="margin-top:26px">Sin tarjeta y sin permanencia. Después, desde {D["precio_desde"]} por mes.</div>
<div class="lista">{li}</div>
<div class="logos">{logos}</div>
</div>{pie_html(f'<b>En marcha en 5 minutos</b><br>{D["web"]}', "Empezar gratis")}
""", h=h, css_extra=f"""
.lista{{display:grid;grid-template-columns:{"1fr" if alto else "1fr 1fr"};gap:18px 30px;margin-top:{60 if alto else 46}px;font-size:29px}}
.lista div{{display:flex;gap:14px;align-items:center}}
.logos{{display:flex;gap:12px;margin-top:{56 if alto else 40}px;flex-wrap:wrap}}
""")


PIEZAS = [
    # (archivo, función, alto)  — orden de subida
    (f"01_TOFU_IMG_ticket_ganancia_{FECHA}", ticket, 1350),
    (f"02_TOFU_IMG_facturar_no_es_ganar_{FECHA}", facturado, 1350),
    (f"03_TOFU_IMG_ocho_pestanas_{FECHA}", pestanas, 1350),
    (f"04_MOFU_IMG_etiquetas_andreani_{FECHA}", etiquetas, 1350),
    (f"05_MOFU_IMG_arca_23de23_{FECHA}", arca, 1350),
    (f"06_MOFU_IMG_ia_conectada_{FECHA}", ia, 1350),
    (f"07_BOFU_IMG_14_dias_gratis_{FECHA}", oferta, 1350),
    (f"08_TOFU_HISTORIA_ticket_ganancia_{FECHA}", ticket, 1920),
    (f"09_MOFU_HISTORIA_etiquetas_andreani_{FECHA}", etiquetas, 1920),
    (f"10_BOFU_HISTORIA_14_dias_gratis_{FECHA}", oferta, 1920),
]


def main():
    os.makedirs(SALIDA, exist_ok=True)
    for f in os.listdir(SALIDA):  # la entrega queda limpia: solo lo de esta corrida
        if f.endswith(".png"):
            os.remove(os.path.join(SALIDA, f))
    hechos = []
    for nombre, fn, h in PIEZAS:
        html = fn(h) if fn in (ticket, etiquetas, oferta) else fn()
        png = exportar(html, os.path.join(SALIDA, nombre + ".png"), h=h)
        hechos.append(png); print("ok", nombre)
    # Hoja de contacto para revisar todo de un vistazo
    ins = sum([["-i", p] for p in hechos], [])
    n = len(hechos)
    esc = "".join(f"[{i}]scale=360:480:force_original_aspect_ratio=decrease,pad=360:640:0:0:color=0x05070a[v{i}];" for i in range(n))
    fila1 = "".join(f"[v{i}]" for i in range(5)); fila2 = "".join(f"[v{i}]" for i in range(5, n))
    flt = esc + f"{fila1}hstack=5[a];{fila2}hstack={n-5}[b];[a][b]vstack=2"
    subprocess.run(["ffmpeg", "-v", "error", "-y", *ins, "-filter_complex", flt, os.path.join(AQUI, "hoja_contacto.jpg")], check=True)
    print("hoja_contacto.jpg")


if __name__ == "__main__":
    main()
