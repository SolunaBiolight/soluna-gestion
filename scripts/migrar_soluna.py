"""
Migración: Soluna App (JSONBin) → Growith (Firestore via API)
=============================================================
Copia tandas, creativos, ideas y editores del bin de JSONBin
al sistema de producción de Growith.

Uso:
    python scripts/migrar_soluna.py

Prerequisitos:
    - pip install urllib3   (incluido en Python 3.x stdlib con urllib)
    - Completar las variables de configuración abajo
"""

import json
import urllib.request
import urllib.error
import sys
import time

# ─── CONFIGURACIÓN — completar estos valores ───────────────────────────────
JSONBIN_BIN_ID  = "TU_BIN_ID_AQUI"          # ej: 6a0ddb9bee5a733b12ef5521
JSONBIN_KEY     = "TU_MASTER_KEY_AQUI"       # ej: $2a$10$...
GROWITH_API_URL = "https://soluna-gestion.vercel.app/api/tareas"
USER_UID        = "WJH3ArqDPQcNLha9lOinvkVi9uJ2"  # uid del owner en Growith
# ───────────────────────────────────────────────────────────────────────────


def jsonbin_read(bin_id, key):
    url = f"https://api.jsonbin.io/v3/b/{bin_id}/latest"
    req = urllib.request.Request(url, headers={
        "X-Master-Key": key,
        "User-Agent": "Mozilla/5.0",
    })
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                return json.loads(res.read())["record"]
        except urllib.error.HTTPError as e:
            if e.code == 502 and attempt < 2:
                print(f"⚠ JSONBin 502, reintentando ({attempt+1}/3)...")
                time.sleep(2)
            else:
                raise


def growith_save(api_url, uid, data):
    body = json.dumps({"action": "saveProduccion", "uid": uid, "data": data}).encode()
    req = urllib.request.Request(
        api_url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read())


def main():
    print("─" * 60)
    print("  Migración Soluna App → Growith Producción")
    print("─" * 60)

    # Validaciones
    if JSONBIN_BIN_ID.startswith("TU_"):
        print("❌ Completá JSONBIN_BIN_ID y JSONBIN_KEY en el script")
        sys.exit(1)

    # 1. Leer desde JSONBin
    print(f"\n📥 Leyendo bin {JSONBIN_BIN_ID}...")
    try:
        soluna_data = jsonbin_read(JSONBIN_BIN_ID, JSONBIN_KEY)
    except Exception as e:
        print(f"❌ Error al leer JSONBin: {e}")
        sys.exit(1)

    editores  = soluna_data.get("editores", [])
    tandas    = soluna_data.get("tandas", [])
    creativos = soluna_data.get("creativos", [])
    ideas     = soluna_data.get("ideas", [])

    print(f"   ✅ {len(editores)} editores")
    print(f"   ✅ {len(tandas)} tandas")
    print(f"   ✅ {len(creativos)} creativos")
    print(f"   ✅ {len(ideas)} ideas")

    # 2. Preparar payload para Growith
    produccion = {
        "editores":  editores,
        "tandas":    tandas,
        "creativos": creativos,
        "ideas":     ideas,
    }

    # 3. Confirmación
    print(f"\n⚠  Esto SOBREESCRIBIRÁ la data de producción del usuario {USER_UID}")
    print("   (Los datos anteriores en Growith se perderán)")
    resp = input("   ¿Continuar? [s/N]: ").strip().lower()
    if resp not in ("s", "si", "sí", "y", "yes"):
        print("Operación cancelada.")
        sys.exit(0)

    # 4. Guardar en Growith
    print(f"\n📤 Guardando en Growith ({GROWITH_API_URL})...")
    try:
        result = growith_save(GROWITH_API_URL, USER_UID, produccion)
        if result.get("ok"):
            print("   ✅ Migración completada exitosamente")
        else:
            print(f"   ❌ Error de API: {result}")
            sys.exit(1)
    except Exception as e:
        print(f"❌ Error al guardar: {e}")
        sys.exit(1)

    print("\n─" * 60)
    print("  ✅ Todo listo. Abrí Growith → Tareas → Creativos")
    print("─" * 60)


if __name__ == "__main__":
    main()
