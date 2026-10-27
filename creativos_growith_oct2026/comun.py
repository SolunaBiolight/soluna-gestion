"""Piezas comunes de Growith: paleta, plantilla HTML, firma visual y exportación a PNG.

Firma visual: la flecha en zigzag que sube del logo (zig()). Fondo oscuro de la app,
un solo violeta de acento y el verde solo para la ganancia.
"""
import os, subprocess, tempfile

AQUI = os.path.dirname(os.path.abspath(__file__))
MARCA = "file://" + os.path.join(AQUI, "marca")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# Paleta (la misma de la app: DARK en src/shared.jsx + violeta del logo)
BG = "#0b0e14"
CARD = "#161b22"
BORDE = "#262c36"
BORDE_L = "#1d222b"
TEXTO = "#fafafa"
TEXTO_MD = "#a1a1aa"
TEXTO_SM = "#71717a"
VIOLETA = "#8455FB"      # logo
VIOLETA_SOLIDO = "#7c3aed"  # botones de la app
VERDE = "#4ade80"
NARANJA = "#f97316"
ROJO = "#f87171"
AMARILLO = "#eab308"

# Datos que se repiten en todas las piezas (unificados con la landing)
DATOS = {
    "prueba": "14 días gratis",
    "sin_tarjeta": "sin tarjeta",
    "web": "growithapp.com",
    "precio_desde": "USD 19",
    "venta": "$ 58.900",
    "costo": "− $ 16.400",
    "comision_mp": "− $ 3.590",
    "envio": "− $ 6.850",
    "publicidad": "− $ 9.700",
    "queda": "$ 22.360",
    "margen": "38 %",
    "anular_min": "30 minutos",
}


def zig(w=220, h=40, color=VIOLETA, grosor=6):
    """La flecha del logo como trazo."""
    return f'''<svg width="{w}" height="{h}" viewBox="0 0 140 26" preserveAspectRatio="none" fill="none" style="display:block;overflow:visible">
<path d="M2 22 L38 12 L58 19 L122 5" stroke="{color}" stroke-width="{grosor}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
<path d="M110 3.5 L124 4.5 L117 16" stroke="{color}" stroke-width="{grosor}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>'''


def check(color=VERDE, s=30):
    return f'<svg width="{s}" height="{s}" viewBox="0 0 24 24" fill="none" stroke="{color}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.2 4L19 7"/></svg>'


CSS = f"""
*{{box-sizing:border-box;margin:0;padding:0}}
html,body{{width:var(--w);height:var(--h);background:{BG};overflow:hidden}}
body{{font-family:'Inter',system-ui,sans-serif;color:{TEXTO};-webkit-font-smoothing:antialiased;position:relative}}
.glow{{position:absolute;inset:0;background:radial-gradient(circle at 78% 8%, {VIOLETA}2e 0%, transparent 46%),radial-gradient(circle at 10% 100%, {VIOLETA}14 0%, transparent 40%);pointer-events:none}}
.lienzo{{position:absolute;inset:0;padding:76px 80px;display:flex;flex-direction:column}}
.marca{{display:flex;align-items:center;gap:16px;font-size:34px;font-weight:700;letter-spacing:-.5px}}
.marca img{{width:48px;height:48px}}
.kicker{{display:inline-flex;align-items:center;gap:12px;font-size:24px;font-weight:600;letter-spacing:1.2px;text-transform:uppercase;color:{TEXTO_SM}}}
.kicker i{{width:12px;height:12px;border-radius:6px;display:inline-block}}
h1{{font-size:92px;line-height:1.02;letter-spacing:-3.4px;font-weight:700}}
h1 .gris{{color:{TEXTO_MD}}}
.sub{{font-size:34px;line-height:1.45;color:{TEXTO_MD};letter-spacing:-.2px}}
.card{{background:{CARD};border:1.5px solid {BORDE};border-radius:32px;box-shadow:0 50px 100px -50px rgba(0,0,0,.8)}}
.barra{{display:flex;align-items:center;gap:12px;padding:22px 30px;border-bottom:1.5px solid {BORDE_L};font-size:22px;color:{TEXTO_MD};font-weight:600}}
.barra .p{{width:13px;height:13px;border-radius:7px;background:{BORDE}}}
.barra .tag{{margin-left:auto;font-size:17px;letter-spacing:1px;text-transform:uppercase;color:{TEXTO_SM};font-weight:500}}
.num{{font-variant-numeric:tabular-nums}}
.medio{{flex:1;display:flex;flex-direction:column;justify-content:center;padding:20px 0 40px}}
.medio>:first-child{{margin-top:0!important}}
.pie{{display:flex;align-items:center;gap:22px}}
.cta{{background:{VIOLETA_SOLIDO};color:#fff;border-radius:999px;padding:24px 40px;font-size:30px;font-weight:600;white-space:nowrap}}
.pie .txt{{font-size:24px;color:{TEXTO_SM};line-height:1.4}}
.pie .txt b{{color:{TEXTO};font-weight:600}}
.chip{{display:inline-flex;align-items:center;gap:12px;border:1.5px solid {BORDE};border-radius:999px;padding:12px 22px;font-size:24px;color:{TEXTO_MD};font-weight:500;background:{BG}cc}}
.chip img{{height:28px}}
"""

# Historias 9:16: zona segura (Instagram tapa ~250 px arriba y abajo) y todo un poco más grande.
HIST = ".lienzo{padding:150px 80px 230px}.medio{zoom:1.14}.medio h1{font-size:80px!important;letter-spacing:-3px!important}"


def pagina(cuerpo, w=1080, h=1350, css_extra=""):
    return f"""<!doctype html><html lang="es"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=block">
<style>:root{{--w:{w}px;--h:{h}px}}{CSS}{HIST if h > 1400 else ""}{css_extra}</style></head>
<body><div class="glow"></div><div class="lienzo">{cuerpo}</div></body></html>"""


def marca_html():
    return f'<div class="marca"><img src="{MARCA}/logo-color.png" alt="">Growith</div>'


def pie_html(texto=None, cta="Probar gratis"):
    t = texto or f'<b>{DATOS["prueba"]}</b> · {DATOS["sin_tarjeta"]}<br>{DATOS["web"]}'
    return f'<div class="pie"><span class="cta">{cta}</span><span class="txt">{t}</span></div>'


def exportar(html, salida_png, w=1080, h=1350, escala=1):
    os.makedirs(os.path.join(AQUI, "html"), exist_ok=True)
    nombre = os.path.splitext(os.path.basename(salida_png))[0]
    ruta_html = os.path.join(AQUI, "html", nombre + ".html")
    with open(ruta_html, "w", encoding="utf-8") as f:
        f.write(html)
    subprocess.run([CHROME, "--headless=new", "--hide-scrollbars", "--allow-file-access-from-files",
                    f"--force-device-scale-factor={escala}", f"--window-size={w},{h}",
                    "--virtual-time-budget=6000", "--user-data-dir=" + os.path.join(tempfile.gettempdir(), "gh_creativos_chrome"),
                    f"--screenshot={salida_png}", "file://" + ruta_html],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return salida_png
