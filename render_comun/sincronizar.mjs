// ============================================================
// LevoPrint · SINCRONIZA el render común desde levodev-modules (core/print/render.mjs + fixtures)
// ------------------------------------------------------------
//   node render_comun/sincronizar.mjs --modulos <repo levodev-modules> [--ref <commit|rama>]
//        copia render.mjs EXACTO, junta los fixtures (core/print/fixtures = Edges vivas, y fixtures_propios si
//        existen) en render_comun/fixtures.json, escribe ORIGEN.json (hashes + commit) y regenera
//        agente/lib/render_comun.js. Con --ref lee del commit con «git show» (no del disco): queda fijado.
//   node render_comun/sincronizar.mjs --regenerar   solo regenera agente/lib/render_comun.js desde render.mjs
//   node render_comun/sincronizar.mjs --check [--modulos <repo> [--ref <x>]]
//        verifica hashes (lo mismo que empaquetar.mjs antes de armar el .exe); con --modulos compara además con
//        la fuente: si levodev-modules cambió el render, sale 1 («resincroniza»).
// Tras sincronizar un render NUEVO: el port Kotlin del APK (RenderComun.kt) declara el sha con el que se comparó;
// --check falla hasta revisar el port, actualizar RENDER_SHA256 y pasar RenderComunFixturesTest.
// No toca la red ni ninguna base. LevoDev
// ============================================================
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { aCjs, sha256, lf, verificar, RUTAS } = require('./convertir.cjs')

const args = process.argv.slice(2)
const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
const MODULOS = val('--modulos') || process.env.LEVO_MODULES || ''
const REF = val('--ref') || ''

function leerFuente (rel) {
  if (REF) return execFileSync('git', ['-C', MODULOS, 'show', REF + ':' + rel], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return fs.readFileSync(path.join(MODULOS, ...rel.split('/')), 'utf8')
}
function listar (relDir) {
  if (REF) {
    let out = ''
    try { out = execFileSync('git', ['-C', MODULOS, 'ls-tree', '--name-only', REF + ':' + relDir], { encoding: 'utf8' }) } catch (_) { return [] }
    return out.split('\n').map((s) => s.trim()).filter(Boolean)
  }
  const d = path.join(MODULOS, ...relDir.split('/'))
  return fs.existsSync(d) ? fs.readdirSync(d) : []
}
function commitDe () {
  try { return execFileSync('git', ['-C', MODULOS, 'rev-parse', REF || 'HEAD'], { encoding: 'utf8' }).trim() } catch (_) { return '' }
}
function juntarFixtures () {
  const todos = []
  for (const [dir, grupo] of [['core/print/fixtures', 'edges_vivas'], ['core/print/fixtures_propios', 'propios']]) {
    for (const f of listar(dir).filter((x) => x.endsWith('.json')).sort()) {
      const hexRel = dir + '/' + f.replace(/\.json$/, '.hex')
      let hex
      try { hex = leerFuente(hexRel).trim() } catch (_) { continue } // sin .hex = caso sin bytes esperados (p. ej. que debe fallar)
      const x = JSON.parse(leerFuente(dir + '/' + f))
      todos.push({ f: f.replace(/\.json$/, ''), grupo, app: x.app, tipo: x.tipo, payload: x.payload, ancho: x.ancho, imagen: x.imagen, hex })
    }
  }
  return '[\n' + todos.map((x) => JSON.stringify(x)).join(',\n') + '\n]\n'
}

if (args.includes('--regenerar')) {
  fs.writeFileSync(RUTAS.cjs, aCjs(fs.readFileSync(RUTAS.render, 'utf8')))
  console.log('regenerado agente/lib/render_comun.js')
  process.exit(0)
}

if (args.includes('--check')) {
  const v = verificar()
  for (const e of v.errores) console.log('FALLA ' + e)
  let fuenteOk = true
  if (MODULOS) {
    const s = sha256(leerFuente('core/print/render.mjs'))
    fuenteOk = s === v.origen.sha256_render
    console.log((fuenteOk ? 'OK    ' : 'FALLA ') + 'levodev-modules' + (REF ? '@' + REF : '') + ' core/print/render.mjs ' + (fuenteOk ? '= copia del agente' : 'cambió (' + s.slice(0, 12) + '): resincroniza con --modulos'))
  } else console.log('AVISO sin --modulos/LEVO_MODULES: no se compara con la fuente (solo hashes locales)')
  console.log(v.ok && fuenteOk ? 'render común: OK (' + String(v.origen.sha256_render).slice(0, 12) + ', ' + v.origen.fixtures + ' fixtures)' : 'render común: FALLA')
  process.exit(v.ok && fuenteOk ? 0 : 1)
}

if (!MODULOS) { console.error('uso: node render_comun/sincronizar.mjs --modulos <repo levodev-modules> [--ref <commit|rama>] | --check | --regenerar'); process.exit(2) }
const fuente = lf(leerFuente('core/print/render.mjs'))
const cjs = aCjs(fuente) // lanza si la forma cambió: no se escribe nada
const fixtures = juntarFixtures()
const lista = JSON.parse(fixtures)
fs.writeFileSync(RUTAS.render, fuente)
fs.writeFileSync(RUTAS.fixtures, fixtures)
fs.writeFileSync(RUTAS.cjs, cjs)
const origen = {
  fuente: 'levodev-modules/core/print/render.mjs',
  commit: commitDe(),
  ref: REF || '(disco)',
  sha256_render: sha256(fuente),
  sha256_fixtures: sha256(fixtures),
  fixtures: lista.length,
  fixtures_edges_vivas: lista.filter((x) => x.grupo === 'edges_vivas').length,
  fixtures_propios: lista.filter((x) => x.grupo === 'propios').length,
  sincronizado: new Date().toISOString().slice(0, 10)
}
fs.writeFileSync(RUTAS.origen, JSON.stringify(origen, null, 2) + '\n')
console.log('sincronizado: render ' + origen.sha256_render.slice(0, 12) + ' (' + (origen.commit || '?').slice(0, 10) + '), ' + origen.fixtures + ' fixtures (' + origen.fixtures_edges_vivas + ' Edges vivas + ' + origen.fixtures_propios + ' propios)')
