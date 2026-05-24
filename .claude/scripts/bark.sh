#!/usr/bin/env bash
# Ladrido — para usar cuando Claude necesita una respuesta yes/no del user.
phrases=(
  "guau"
  "guau guau"
  "wof wof"
  "guauu"
  "grrr guau"
  "grrr"
  "auu"
)
voices=(
  "Diego"
  "Eddy (es_MX)"
  "Flo (es_ES)"
  "Paulina"
)
phrase="${phrases[$RANDOM % ${#phrases[@]}]}"
voice="${voices[$RANDOM % ${#voices[@]}]}"
say -v "$voice" -r 110 "$phrase" 2>/dev/null || say "$phrase"
