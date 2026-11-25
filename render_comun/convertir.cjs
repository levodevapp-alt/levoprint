// ============================================================
// LevoPrint · RENDER COMÚN: render.mjs (ESM, copia EXACTA de levodev-modules core/print/render.mjs) → CommonJS
// ------------------------------------------------------------
// El .exe es un Node SEA: su script principal es CommonJS y solo puede hacer require() de módulos de Node o de lo
// que empaquetar.mjs junta de agente/lib/. Por eso el render común entra al agente como agente/lib/render_comun.js,
// GENERADO desde render_comun/render.mjs con tres cambios mecánicos y verificables:
//   1) import { Buffer } from 'node:buffer'  →  const { Buffer } = require('buffer')
//   2) «export function» / «export const»    →  «function» / «const»
//   3) al final: module.exports = { crearRender, envolver, MAX_FILAS, RENDER_SHA256 }
// El cuerpo del render NO se toca: los mismos bytes que la Edge <prefijo>-print. Si la fuente cambia de forma (otro
// import, otro export), aCjs() lanza y la sincronización se detiene (nada de adivinar).
// Hash: sha256 del texto de render.mjs con saltos LF (independiente de core.autocrlf). Lo usan sincronizar.mjs,
// agente/empaquetar.mjs (no arma el .exe si no cuadra), agente/prueba_render.cjs y la prueba del APK.
// LevoDev
// ============================================================
'use strict'
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const RAIZ = path.resolve(__dirname, '..')
const RUTAS_REPO = {
  render: path.join(RAIZ, 'render_comun', 'render.mjs'),
  fixtures: path.join(RAIZ, 'render_comun', 'fixtures.json'),
  origen: path.join(RAIZ, 'render_comun', 'ORIGEN.json'),
  cjs: path.join(RAIZ, 'agente', 'lib', 'render_comun.js'),
  kotlin: path.join(RAIZ, 'app', 'src', 'main', 'java', 'dev', 'levo', 'levoprint', 'RenderComun.kt')
}

const lf = (s) => String(s).replace(/\r\n/g, '\n')
const sha256 = (s) => crypto.createHash('sha256').update(lf(s), 'utf8').digest('hex')

const IMPORT = "import { Buffer } from 'node:buffer'\n"
function aCjs (fuenteMjs) {
  const f = lf(fuenteMjs)
  const sha = sha256(f)
  const partes = f.split(IMPORT)
  if (partes.length !== 2) throw new Error('render.mjs: se esperaba UN «' + IMPORT.trim() + '» (encontrados ' + (partes.length - 1) + ')')
  let cuerpo = partes[0] + "const { Buffer } = require('buffer')\n" + partes[1]
  const exportados = []
  cuerpo = cuerpo.replace(/^export (function|const) ([A-Za-z_$][\w$]*)/gm, (_, k, n) => { exportados.push(n); return k + ' ' + n })
  const esperados = ['MAX_FILAS', 'envolver', 'crearRender']
  if (JSON.stringify(exportados.slice().sort()) !== JSON.stringify(esperados.slice().sort())) throw new Error('render.mjs: exports inesperados: ' + exportados.join(', '))
  if (/^\s*(import|export)\b/m.test(cuerpo)) throw new Error('render.mjs: quedó un import/export sin convertir')
  return '// GENERADO por render_comun/sincronizar.mjs desde render_comun/render.mjs (= levodev-modules core/print/render.mjs).\n' +
    '// NO editar: se reescribe al sincronizar y empaquetar.mjs no arma el .exe si no cuadra con el hash.\n' +
    '// sha256 de render.mjs (LF): ' + sha + '\n' +
    "'use strict'\n" + cuerpo +
    "\nconst RENDER_SHA256 = '" + sha + "'\nmodule.exports = { crearRender, envolver, MAX_FILAS, RENDER_SHA256 }\n"
}

// Verifica lo que va al .exe y al APK. Devuelve { ok, errores[], origen }. «rutas» solo cambia en las pruebas
// (copias tocadas a propósito para ver que el candado las rechaza).
function verificar (RUTAS = RUTAS_REPO) {
  const errores = []
  let origen = {}
  try { origen = JSON.parse(fs.readFileSync(RUTAS.origen, 'utf8')) } catch (e) { errores.push('ORIGEN.json ilegible: ' + e.message); return { ok: false, errores, origen } }
  const fuente = fs.readFileSync(RUTAS.render, 'utf8')
  if (sha256(fuente) !== origen.sha256_render) errores.push('render_comun/render.mjs no coincide con ORIGEN.json (sha256 ' + sha256(fuente) + ' ≠ ' + origen.sha256_render + ')')
  let cjs = ''
  try { cjs = fs.readFileSync(RUTAS.cjs, 'utf8') } catch (_) { errores.push('falta agente/lib/render_comun.js') }
  let esperado = ''
  try { esperado = aCjs(fuente) } catch (e) { errores.push(e.message) }
  if (cjs && esperado && lf(cjs) !== esperado) errores.push('agente/lib/render_comun.js no es la conversión exacta de render_comun/render.mjs (corre: node render_comun/sincronizar.mjs --regenerar)')
  if (sha256(fs.readFileSync(RUTAS.fixtures, 'utf8')) !== origen.sha256_fixtures) errores.push('render_comun/fixtures.json no coincide con ORIGEN.json')
  // El port Kotlin del APK declara la versión del render con la que se comparó (RenderComun.RENDER_SHA256).
  try {
    const kt = fs.readFileSync(RUTAS.kotlin, 'utf8')
    const m = /const val RENDER_SHA256 = "([0-9a-f]{64})"/.exec(kt)
    if (!m) errores.push('RenderComun.kt sin RENDER_SHA256')
    else if (m[1] !== origen.sha256_render) errores.push('RenderComun.kt (APK) está portado de otro render.mjs (' + m[1].slice(0, 12) + ' ≠ ' + String(origen.sha256_render).slice(0, 12) + '): revisar el port y correr las pruebas del APK')
  } catch (_) { errores.push('falta app/.../RenderComun.kt') }
  return { ok: errores.length === 0, errores, origen }
}

module.exports = { aCjs, sha256, lf, verificar, RUTAS: RUTAS_REPO }
