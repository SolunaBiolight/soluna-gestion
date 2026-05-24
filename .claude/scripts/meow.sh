#!/usr/bin/env bash
# Reproduce un maullido cuando Claude termina una tarea.
# Uso: ./.claude/scripts/meow.sh
# El script usa `say` (macOS TTS) con voces variadas para sonar más natural.
# Si querés cambiar el sonido, podés reemplazar por afplay con un .wav de gato.

# Variantes random para que no suene siempre igual
phrases=(
  "miau"
  "miauu"
  "meowww"
  "miaaau miau"
  "miau miau"
  "prrr miau"
)
voices=(
  "Mónica"
  "Paulina"
  "Diego"
  "Eddy (es_MX)"
  "Flo (es_ES)"
)

phrase="${phrases[$RANDOM % ${#phrases[@]}]}"
voice="${voices[$RANDOM % ${#voices[@]}]}"

# Hablar en pitch alto para sonar más felino
say -v "$voice" -r 130 "$phrase" 2>/dev/null || say "$phrase"
