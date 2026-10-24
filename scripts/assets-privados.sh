#!/usr/bin/env bash
# Private-use copy of the copyrighted artwork the app runs with (WLM 8.5
# images and sounds, MSN emoticons, msn-js, Selawik). They are gitignored and
# never go to GitHub, so a fresh clone has none of them: this keeps a zip of
# them somewhere of your own (outside the repository) and puts them back.
#
#   scripts/assets-privados.sh exportar [arquivo.zip]   # default: ~/Documentos/WhatsMSN-assets-privados-<data>.zip
#   scripts/assets-privados.sh importar  arquivo.zip     # restores into this checkout
set -euo pipefail

cd "$(dirname "$0")/.."
PASTAS=(src/renderer/assets/wlm85 src/renderer/assets/original vendor)

case "${1:-}" in
  exportar)
    destino="${2:-$HOME/Documentos/WhatsMSN-assets-privados-$(date +%F).zip}"
    case "$destino" in "$PWD"/*) echo "Salve fora do repositório (para não ir parar no git)." >&2; exit 1 ;; esac
    existentes=()
    for p in "${PASTAS[@]}"; do [ -e "$p" ] && existentes+=("$p"); done
    [ ${#existentes[@]} -gt 0 ] || { echo "Nenhuma pasta de assets encontrada." >&2; exit 1; }
    rm -f "$destino"
    zip -qr -9 "$destino" "${existentes[@]}" -x '*/.git/*' '*/node_modules/*'
    echo "Exportado: $destino ($(du -h "$destino" | cut -f1), $(unzip -l "$destino" | tail -1 | awk '{print $2}') arquivos)"
    echo "Pastas: ${existentes[*]}"
    ;;
  importar)
    origem="${2:?informe o .zip}"
    # only the expected folders, never anything outside them
    if unzip -Z1 "$origem" | grep -vqE '^(src/renderer/assets/(wlm85|original)|vendor)/'; then
      echo "O zip tem arquivos fora das pastas de assets; não vou extrair." >&2; exit 1
    fi
    unzip -qo "$origem"
    echo "Restaurado de $origem: $(unzip -Z1 "$origem" | grep -vc '/$') arquivos."
    ;;
  *)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
