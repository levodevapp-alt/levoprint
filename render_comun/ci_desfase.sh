#!/usr/bin/env bash
# ============================================================
# LevoPrint · CI: ¿el render común del agente/APK está al día con levodev-modules (core/print/render.mjs)?
# ------------------------------------------------------------
# Entrada (variables): REF = commit/rama de levodev-modules (vacío = origin/main), SHA_URL = URL pública con el
# sha256 publicado del render del núcleo (variable del repo LEVO_RENDER_SHA_URL), MODULOS_URL (opcional, otro remoto).
#   1) clona levodev-modules sin credenciales y corre sincronizar.mjs --check --modulos <clon> --ref <REF>
#   2) si no se puede clonar (repo privado, CI sin secretos · RT-1) y hay SHA_URL: --check --sha-url
#   3) si no hay forma de verificar: con REF pedido FALLA; sin REF, avisa y sigue (solo hashes locales)
# Límite: hoy levodev-modules es privado y nadie publica el sha → este paso solo AVISA. La comparación real se hace
# en la PC con node render_comun/sincronizar.mjs --check --modulos <repo> --ref <commit> (docs/RUNBOOK_render_comun.md).
# ============================================================
set -u
AQUI="$(cd "$(dirname "$0")" && pwd)"
DESTINO="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/levodev-modules-rca"
URL="${MODULOS_URL:-https://github.com/Levo19/levodev-modules.git}"
rm -rf "$DESTINO"
if GIT_TERMINAL_PROMPT=0 git clone --quiet --filter=blob:none --no-checkout "$URL" "$DESTINO" 2>/dev/null; then
  node "$AQUI/sincronizar.mjs" --check --modulos "$DESTINO" --ref "${REF:-origin/main}"
  exit $?
fi
if [ -n "${SHA_URL:-}" ]; then
  node "$AQUI/sincronizar.mjs" --check --sha-url "$SHA_URL"
  exit $?
fi
if [ -n "${REF:-}" ]; then
  echo "::error::No se pudo comparar con levodev-modules@$REF: el repo es privado y no hay LEVO_RENDER_SHA_URL. Compara en la PC: node render_comun/sincronizar.mjs --check --modulos <repo> --ref $REF"
  exit 1
fi
echo "::warning::Desfase con levodev-modules NO verificado en el CI (repo privado, sin LEVO_RENDER_SHA_URL). Solo hashes locales; ver docs/RUNBOOK_render_comun.md."
node "$AQUI/sincronizar.mjs" --check
