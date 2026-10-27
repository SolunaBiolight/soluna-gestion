"""Arma la entrega entera: limpia LISTAS_PARA_SUBIR, corre las dos tandas y deja hoja_contacto.jpg
con cada anuncio en par (feed 4:5 al lado de su historia 9:16).

Uso:  python3 armar_todo.py

Nombres: NN_ETAPA_concepto_fecha_FEED-4x5.png y NN_ETAPA_concepto_fecha_HISTORIA-9x16.png.
Ordenados por nombre, las dos medidas de un anuncio quedan juntas: en Meta se eligen de a dos.
"""
import os, subprocess
from comun import AQUI
import armar_placas, armar_placas_claras

SALIDA = os.path.join(AQUI, "LISTAS_PARA_SUBIR")
POR_FILA = 4  # pares por fila en la hoja de contacto


def main():
    os.makedirs(SALIDA, exist_ok=True)
    for f in os.listdir(SALIDA):
        if f.endswith(".png"):
            os.remove(os.path.join(SALIDA, f))
    for f in os.listdir(os.path.join(AQUI, "html")) if os.path.isdir(os.path.join(AQUI, "html")) else []:
        os.remove(os.path.join(AQUI, "html", f))  # sin HTML de nombres viejos
    hechos = armar_placas.main() + armar_placas_claras.main()

    # Hoja de contacto: cada par = feed (384x480) + historia (270x480) con 12 px de aire
    pares = [hechos[i:i + 2] for i in range(0, len(hechos), 2)]
    ins, flt, celdas = [], "", []
    for k, (feed, hist) in enumerate(pares):
        ins += ["-i", feed, "-i", hist]
        a, b = 2 * k, 2 * k + 1
        flt += f"[{a}]scale=384:480[f{k}];[{b}]scale=270:480[h{k}];[f{k}][h{k}]hstack=2,pad=iw+40:ih+40:20:20:color=0x05070a[p{k}];"
        celdas.append(f"[p{k}]")
    filas = []
    for r in range(0, len(celdas), POR_FILA):
        fila = celdas[r:r + POR_FILA]
        while len(fila) < POR_FILA:  # completa la última fila para que el vstack tenga el mismo ancho
            fila.append(None)
        reales = [c for c in fila if c]
        nombre = f"[r{r}]"
        if len(reales) == POR_FILA:
            flt += "".join(reales) + f"hstack={POR_FILA}{nombre};"
        else:
            flt += "".join(reales) + (f"hstack={len(reales)}," if len(reales) > 1 else "null,") + f"pad={POR_FILA * 694}:520:0:0:color=0x05070a{nombre};"
        filas.append(nombre)
    flt += "".join(filas) + f"vstack={len(filas)}"
    subprocess.run(["ffmpeg", "-v", "error", "-y", *ins, "-filter_complex", flt, os.path.join(AQUI, "hoja_contacto.jpg")], check=True)
    print(len(hechos), "archivos ·", len(pares), "anuncios · hoja_contacto.jpg")


if __name__ == "__main__":
    main()
