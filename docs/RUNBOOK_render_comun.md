# RUNBOOK · Render común en el agente `.exe` y el APK (RCA · 25-nov-2026)

Rama `feat/render-comun-agentes` · agente `.exe` **1.16.0** · APK **1.8.0** (versionCode 15).

## Qué cambió
- El `.exe` (cuando cae al render local) y el APK (que siempre dibuja en local) arman el papel **byte a byte igual** que la Edge `<prefijo>-print`. Los tres salen de la misma fuente: `levodev-modules/core/print/render.mjs`.
- **Antes:** el agente difería de la Edge en 27 de los 90 fixtures (ticket de turno de KIPU, sello COPIA/REIMPRESION, recorte de ítems del CPE de KUTI). El CPE del APK 1.7.2 no imprimía «SON: … SOLES».
- **Ahora:** el agente y el APK coinciden en 90/90 fixtures de las Edges vivas y en 34/34 fixtures propios. El APK también da 118/118 por su camino real (`Agent.render` con org.json).
- **Ancho mínimo 24 columnas** en el `.exe` y el APK (antes 20). El render común ya imprimía a 24 como mínimo (igual que la Edge), así que con 20–23 el papel salía a 24 sin avisar. Ahora lo dice:
  - `.exe`: aviso en la consola y en la ventana (`/estado.avisoAncho`); además el valor se guarda como 24 en `levoprint.txt`. `POST /ancho` con menos de 24 responde `ANCHO_MINIMO` y un mensaje.
  - APK: un aviso al abrir la app (el ancho guardado se sube a 24) y otro al guardar un ancho menor.

## Por qué se quitó la copia congelada del render viejo
`app/src/test/.../original/Agent.kt` era una copia congelada del render de `canje-v3`. `AgentRenderTest` exigía que el APK la igualara byte a byte. Ese papel era justamente el que **difería de la Edge**: CPE sin monto en letras, QR de la precuenta en texto, ticket de KUTI distinto. Mantener la prueba obligaba a seguir imprimiendo el papel equivocado.

Ahora la referencia son los fixtures de las Edges vivas (`render_comun/fixtures.json`) en `RenderComunFixturesTest`. QA lo aceptó (GO, 25-nov).

## Piezas y candados
| Pieza | Qué es | Candado |
|---|---|---|
| `render_comun/render.mjs` | copia exacta de `core/print/render.mjs` | sha256 (LF) en `render_comun/ORIGEN.json` |
| `render_comun/fixtures.json` | fixtures de las Edges vivas + propios, con bytes esperados | sha256 en `ORIGEN.json` |
| `agente/lib/render_comun.js` | conversión CommonJS (`render_comun/convertir.cjs`) | `empaquetar.mjs` no arma el `.exe` si no es la conversión exacta |
| `app/.../RenderComun.kt` | port línea a línea a Kotlin | `RENDER_SHA256` = el render con el que se comparó; `RenderComunFixturesTest` |

## Cuando cambia el render en levodev-modules
1. `node render_comun/sincronizar.mjs --modulos <repo levodev-modules> --ref <commit>`
2. Portar el cambio a `RenderComun.kt` y actualizar `RENDER_SHA256`.
3. `cd agente && npm run prueba` y `gradle testReleaseUnitTest`. Ambas tienen que dar verde.
4. Subir la versión del `.exe` y del APK.

Hasta completar el paso 2, `--check`, `prueba_render.cjs` y la prueba del APK fallan a propósito.

## Desfase con el núcleo en la CI (y su límite)
- `render_comun/ci_desfase.sh` corre en los dos workflows, con la entrada opcional `modulos_ref` (vacío = `origin/main`):
  1. Intenta clonar levodev-modules **sin credenciales** y corre `sincronizar.mjs --check --modulos <clon> --ref <modulos_ref>`.
  2. Si no puede clonar y la variable del repo `LEVO_RENDER_SHA_URL` (no secreta) apunta a un texto público con el sha256 del render del núcleo, usa `--check --sha-url`.
  3. Si no hay forma de verificar: con un `modulos_ref` pedido, la CI **falla**; sin pedirlo, **avisa** (`::warning::`) y sigue solo con los hashes locales.
- **Límite actual:** levodev-modules es **privado** y este CI no usa secretos (RT-1). Además, nadie publica todavía el sha en un lugar público. Por eso hoy la CI solo avisa.
- **Mientras tanto**, antes de lanzar la CI, corre en la PC: `node render_comun/sincronizar.mjs --check --modulos C:/Users/ISO/levodev-modules --ref origin/main`. El 25-nov dio OK: `origin/main` = `f061ee1942aa`.
- **Mejora propuesta:** que levodev-modules publique `render_sha.txt` (sha256 de `core/print/render.mjs`) en un lugar público, por ejemplo el bucket `descargas/levoprint/`, al fusionar a main. Luego se define `LEVO_RENDER_SHA_URL`.

## Notas de versión (para el campo «notas» del workflow y la publicación)
- **LevoPrint para PC 1.16.0:** el comprobante sale igual que en el servidor, con el monto en letras; ancho mínimo 24.
- **LevoPrint Android 1.8.0:** el comprobante sale igual que en el servidor, con el monto en letras; ancho mínimo 24.

## Riesgos
- **Papel distinto al anterior en el APK.** KUTI dice «NOTA DE VENTA» y la nota va en grande. La precuenta lleva un QR gráfico, no texto. CIERRE de KOMO/KIPU sin líneas ahora sale como corte. Es lo que ya hace la Edge, pero conviene hacer una prueba física en una ticketera de 58 mm.
- **Semántica de números:** `RenderComun.kt` usa `Double.toString`. En JDK < 19 no siempre da los dígitos más cortos para valores raros. No afecta a los fixtures; solo podría verse en `fmtCant`/JSON de valores extremos.
- **Publicación:** no se publica nada desde esta rama. El `.exe` y el APK los publica Luis desde main, con `tools/publicar_bucket.mjs`.
