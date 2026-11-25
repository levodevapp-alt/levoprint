// ============================================================
// LevoPrint · prueba del render LOCAL del agente .exe (sin impresora, sin red, sin config)
// ------------------------------------------------------------
//   node agente/prueba_render.cjs        (el CI la corre antes de compilar el .exe: build-exe.yml)
// index.js arranca el agente al cargarse (lee levoprint.txt, abre la ventana, sale a la red), así que no se
// importa: se toma SOLO el bloque del render, desde «// --- ESC/POS ---» hasta «function imprimirRaw(», y se
// evalúa en un contexto aislado con PREFIJO y ANCHO propios. Si alguien mueve esas dos anclas, la prueba falla
// (a propósito) antes de dejar pasar un .exe sin probar.
// Cubre: [O-23] TURNO (definitivo, provisional, 0/1/n delante, COPIA, número largo, ancho de 32 y 48, ASCII
// puro en lo fijo), el pie de marca ASCII por app y en 58 mm, la nota de venta de KUTI, COPIA / ATRASADA y PRUEBA.
// Mismo papel que kuti-print (prueba_render.mjs) y que el APK (AgentRenderTest.kt).
// ============================================================
'use strict'
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')
const a = src.indexOf('// --- ESC/POS ---')
const b = src.indexOf('function imprimirRaw(')
if (a < 0 || b < 0 || b < a) { console.error('FALLA: no se encontraron las anclas del render en index.js'); process.exit(1) }

function cargar (prefijo) {
  // [RCA] el bloque hace require('./lib/render_comun'): se resuelve desde agente/ (lo mismo que hace empaquetar.mjs en el .exe)
  const ctx = { PREFIJO: prefijo, ANCHO: 48, CON_IMAGEN: true, process: { env: {} }, Buffer, console, require: (p) => require(p.startsWith('.') ? path.join(__dirname, p) : p) }
  vm.createContext(ctx)
  vm.runInContext('var PREFIJO = this.PREFIJO, ANCHO = this.ANCHO, CON_IMAGEN = this.CON_IMAGEN;\n' + src.slice(a, b).replace(/^const /gm, 'var ') +
    '\nthis.render = render; this.pieMarca = pieMarca; this.setAncho = (n) => { ANCHO = n }; this.setImagen = (v) => { CON_IMAGEN = v };', ctx)
  return ctx
}
const R = cargar('kuti')
let fallas = 0
const ok = (c, m, det) => { console.log((c ? 'OK    ' : 'FALLA ') + m + (c || det === undefined ? '' : '\n      ' + String(det).slice(0, 1200))); if (!c) fallas++ }
// Texto impreso sin los comandos ESC/POS (ESC @, ESC a n, ESC E n, ESC ! n, GS ! n, GS V n)
// [MM3-01] El isotipo (GS v 0 + 512 bytes de mapa de bits) también se quita: queda solo el texto impreso.
const RASTER = '\x1dv0\x00\x08\x00\x40\x00'
const sinImagen = (t) => { const i = t.indexOf(RASTER); return i < 0 ? t : t.slice(0, i) + t.slice(i + RASTER.length + 512) }
const texto = (t) => sinImagen(t).replace(/\x1b@|\x1b[aE!J][\s\S]|\x1d[!V][\s\S]/g, '')
const LEMA48 = 'Tu negocio, inteligente y bajo control.\n'
const LEMA32 = 'Tu negocio, inteligente\ny bajo control.\n'
const PROHIBIDO = ['Paracas', 'Peru', 'Ica', 'Pisco', 'Luis', 'S/ 39', 'S/ 40', 'Tu negocio tambien', 'Sistema ', '<Levodev', 'Hecho con carino']
const ascii = (s) => [...s].every((c) => c.charCodeAt(0) < 128)

// ---------- [O-23] TURNO ----------
const def = { app: 'KUTI', negocio: 'Barbería Demo', local: 'Sede Centro', definitivo: true, numero: 15, provisional: '', nombre: 'Carlos P.', con: 'Jorge', fecha: '04/11/2026 10:05', delante: 2 }
const prov = { ...def, definitivo: false, numero: 'A-07', provisional: 'A-07', nombre: '', con: null, delante: null }
for (const an of [48, 32]) {
  R.setAncho(an)
  const crudo = R.render({ tipo: 'TURNO', payload: def }); const t = texto(crudo)
  ok(t.includes('BARBERÍA DEMO') && t.includes('Sede Centro') && t.includes('TURNO SIN CITA') && t.includes('Tu numero\n15\n') && crudo.includes('\x1d!\x22' + '15\n'), `TURNO ${an}: definitivo con el número de la cola en triple alto`, t)
  ok(t.includes('Carlos P.\nCon Jorge\n04/11/2026 10:05\n') && t.includes('Hay 2 personas delante.') && t.includes('Hecho con KUTI - levodev.app'), `TURNO ${an}: nombre, con quién, hora, cuántos delante y pie`, t)
  // [QA BAJO] sin punto ciego: ninguna línea pasa del ancho y el negocio (doble ancho) tampoco
  ok(t.split('\n').every((l) => l.length <= an) && t.split('\n')[0].length * 2 <= an, `TURNO ${an}: ninguna línea pasa del ancho`, t)
  const largo = texto(R.render({ tipo: 'TURNO', payload: { ...def, negocio: 'Barbería y Spa Los Hermanos del Centro Histórico' } })).split('\n')[0]
  ok(largo.length <= Math.floor(an / 2) && largo.startsWith('BARBERÍA Y SPA'), `TURNO ${an}: un negocio largo (doble ancho) se corta a la mitad de las columnas`, largo)
  ok(ascii(t.slice(t.indexOf('TURNO SIN CITA')).replace(/Carlos P\.|Jorge/g, '')), `TURNO ${an}: lo fijo y el pie en ASCII puro`)
  const p = texto(R.render({ tipo: 'TURNO', payload: prov }))
  ok(p.includes('Tu numero provisional\nA-07\n') && p.replace(/\n/g, ' ').includes('se tomo sin internet') && p.includes('\n15 - A-07 (el 15 es un ejemplo)\n') && !p.includes('Con ') && !p.includes('null') && !p.includes('delante'), `TURNO ${an}: provisional con su explicación, sin nombre ni profesional`, p)
  ok(texto(R.render({ tipo: 'TURNO', payload: { ...def, copia: true, reimpresion: true } })).startsWith('*** COPIA ***'), `TURNO ${an}: la reimpresión sale con COPIA`)
}
R.setAncho(48)
ok(texto(R.render({ tipo: 'TURNO', payload: { ...def, delante: 0 } })).includes('Es el siguiente en la cola.') && texto(R.render({ tipo: 'TURNO', payload: { ...def, delante: 1 } })).includes('Hay 1 persona delante.'), 'TURNO: 0 y 1 delante')
ok(!/siguiente|delante\./.test(texto(R.render({ tipo: 'TURNO', payload: { ...def, delante: 'x' } }))), 'TURNO: un «delante» que no es número no dice nada')
R.setAncho(32)
ok(texto(R.render({ tipo: 'TURNO', payload: { ...prov, provisional: 'ZZZZ-9999·xx' } })).includes('\nZZZZ-9999x\n'), 'TURNO: el número grande solo lleva ASCII visible y cabe en triple (32 columnas → 10)')

// ---------- pie de marca (MM3-01 · MM3-P1) ----------
const pieTxt = (ap, an) => 'Hecho con ' + ap + ' - levodev.app\n' + (an >= 40 ? LEMA48 : LEMA32)
ok(['KOMO', 'KIPU', 'KUTI'].every((ap) => [32, 48, 64].every((an) => R.pieMarca(ap, an, false) === pieTxt(ap, an))) && R.pieMarca('otra', 48, false) === 'LevoDev - levodev.app\n' + LEMA48, 'pie de marca en texto: «Hecho con <APP> - levodev.app» + lema (una línea desde 40 columnas, dos en 58 mm)')
{
  const p = R.pieMarca('KUTI', 48, true)
  ok(p.startsWith('\x1bJ\x08' + RASTER) && p.endsWith('\x1bJ\x06' + pieTxt('KUTI', 48)) && p.length === 3 + RASTER.length + 512 + 3 + pieTxt('KUTI', 48).length, 'pie con imagen: isotipo GS v 0 de 64x64 (512 bytes) y debajo el mismo texto')
}
ok(['KOMO', 'KIPU', 'KUTI', 'x'].every((ap) => [32, 48].every((an) => ascii(R.pieMarca(ap, an, false)) && R.pieMarca(ap, an, false).split('\n').every((l) => l.length <= an))), 'pie de marca en ASCII puro y dentro del ancho')
{
  const b64 = /const ISOTIPO_B64 = '([^']+)'/.exec(src)[1]
  ok(Buffer.from(b64, 'base64').length === 512 && Buffer.from(b64, 'base64')[0] === 0x3f, 'ISOTIPO_B64 decodifica a 512 bytes (64x64 a 1 bit)')
}
for (const an of [48, 32]) {
  R.setAncho(an)
  for (const pref of ['kuti', 'komo', 'kipu']) {
    const Rp = cargar(pref); Rp.setAncho(an)
    const APP = pref.toUpperCase()
    const nvp = { negocio: 'Pollos Don Lucho', mesa: '3', items: [{ cantidad: 1, nombre: 'Lomo', precio: 28.5 }], total: 28.5, pagos: [], lema: 'Turnos y caja para barberias y salones', url: 'https://x.y', qr: 'q' }
    for (const tipo of ['TICKET', 'PRECUENTA', 'CARTA_QR', 'PRUEBA']) {
      const t = Rp.render({ tipo, payload: nvp }), s = texto(t)
      ok(t.includes(RASTER) && t.indexOf(RASTER) === t.lastIndexOf(RASTER), `${APP} ${tipo} ${an}: un solo isotipo en el pie`)
      ok(s.includes(pieTxt(APP, an)) && PROHIBIDO.every((p) => !t.includes(p)) && !s.includes('barberias'), `${APP} ${tipo} ${an}: «Hecho con ${APP} - levodev.app» + lema; sin ciudades, país, precios, invitación ni el eslogan viejo`)
      Rp.setImagen(false)
      const x = Rp.render({ tipo, payload: nvp }); Rp.setImagen(true)
      ok(!x.includes('\x1dv0') && texto(x) === s && Rp.render({ tipo, payload: { ...nvp, sinImagen: true } }) === x, `${APP} ${tipo} ${an}: fallback sin imagen (LEVO_IMAGEN=0 o payload.sinImagen): el mismo pie en texto`)
    }
    const tk = texto(Rp.render({ tipo: 'TICKET', payload: nvp }))
    ok(tk.indexOf('POLLOS DON LUCHO') >= 0 && tk.indexOf('POLLOS DON LUCHO') < tk.indexOf('Hecho con'), `${APP} TICKET ${an}: el negocio del cliente arriba y la marca al pie`)
  }
  const c = R.render({ tipo: 'COMANDA', payload: { mesa: '12', mozo: 'Ana', hora: '19:42', ronda: 2, items: [{ cantidad: 2, nombre: 'Lomo saltado con arroz chaufa y una porcion extra de papas fritas', nota: 'sin cebolla' }, { cantidad: 1.5, nombre: 'Chicha' }] } })
  ok(c.includes('\x1d!\x22MESA 12\n') && c.includes('Mozo: Ana') && c.includes('19:42') && c.includes('Ronda 2'), `COMANDA ${an}: MESA enorme, mozo, hora y ronda`)
  ok(c.includes('\x1bE\x01\x1d!\x012 x Lomo saltado') && /\x1d!\x01 {4}\S/.test(c) && c.includes('>> sin cebolla') && c.includes('1.500 x Chicha'), `COMANDA ${an}: ítems en doble alto y negrita, nombre largo con sangría, nota y cantidad fraccionada`)
  ok(!texto(c).split('\n').some((l) => l.length > an), `COMANDA ${an}: ningún renglón pasa del ancho`)
  ok(!c.includes('Hecho con') && !c.includes('levodev.app') && !c.includes('\x1dv0') && !c.includes('Tu negocio') && c.endsWith('='.repeat(an) + '\n\n\n\n\x1dV\x00'), `COMANDA ${an}: sin pie, sin isotipo, sin publicidad`)
}
ok(texto(R.render({ tipo: 'COMANDA', payload: { mesa: '5', correccion: true, items: [{ cantidad: 1, nombre: 'Lomo' }] } })).includes('*** CORRECCION ***\nMESA 5\n'), 'COMANDA corrección: título y mesa')

// ---------- nota de venta de KUTI, sellos y prueba ----------
R.setAncho(48)
const nv = { app: 'KUTI', refTipo: 'DIRECTO', nota: 'NV01-00000042', negocio: 'Barbería Demo', hora: '18:30', vendedor: 'Jorge', items: [{ cantidad: 1, nombre: 'Perfilado', precio: 13, profesional: 'Jorge' }], total: 13, pagos: [{ medio: 'Efectivo', monto: 13 }] }
const tn = texto(R.render({ tipo: 'TICKET', payload: nv }))
ok(tn.includes('VENTA') && tn.includes('NV01-00000042') && tn.includes('S/ 13.00') && tn.includes('NO ES COMPROBANTE DE PAGO') && !tn.includes('COPIA'), 'TICKET KUTI: nota de venta con total y sin COPIA', tn)
ok(texto(R.render({ tipo: 'TICKET', payload: { ...nv, copia: true, reimpresion: true } })).startsWith('*** COPIA ***'), 'TICKET KUTI: reimpresión con COPIA')
// [RCA] ATRASADA / REIMPRESION son de la familia pos (KOMO/KIPU/KAMA/KAWA), como en la Edge; KUTI sella COPIA.
ok(texto(cargar('komo').render({ tipo: 'COMANDA', payload: { mesa: '3', mozo: 'Ana', items: [], atrasada: true, hora: '12:00' } })).startsWith('*** ATRASADA ***'), 'COMANDA atrasada con su sello (KOMO)')
ok(texto(R.render({ tipo: 'COMANDA', payload: { mesa: '3', mozo: 'Ana', items: [], atrasada: true, reimpresion: true, hora: '12:00' } })).startsWith('*** COPIA ***'), 'KUTI: una reimpresión sale con COPIA (no REIMPRESION)')
ok(texto(R.render({ tipo: 'PRUEBA', payload: {} })).includes('PRUEBA LEVOPRINT OK'), 'PRUEBA')


// [QA M1 · M2 · 4-nov] ítem sin nombre y nombre de negocio largo en doble ancho: nunca se pierde nada.
const plano = (t) => t.replace(/\x1b@|\x1b[Ea!J][\x00-\xff]|\x1d[!V][\x00-\xff]/g, '')
const NEGOCIOS = ['Pollería Don Lucho', 'Distribuidora Inversiones Santa Rosa SAC', 'Cevichería y Pollería Los Hermanos del Centro Histórico', 'Supercalifragilisticoespialidosoextraordinariamente SAC']
for (const ancho of [48, 32]) {
  const cv = (() => { R.setAncho(ancho); return R.render({ tipo: 'COMANDA', payload: { mesa: '3', items: [{ cantidad: 2, nombre: '' }, { cantidad: 1 }, { cantidad: 1, nombre: '   ' }, { cantidad: 1, nombre: 'Chicha' }] } }) })()
  ok(cv.includes('2 x (sin nombre)') && (cv.match(/\(sin nombre\)/g) || []).length === 3 && cv.includes('1 x Chicha'), 'COMANDA ' + ancho + ': un ítem sin nombre sale igual con su cantidad (sin nombre)')
  for (const negocio of NEGOCIOS) {
    for (const tipo of ['TICKET', 'TURNO']) {
      const t = (() => { R.setAncho(ancho); return R.render({ tipo: tipo, payload: { ...nv, ...def, negocio, mesa: tipo === 'TURNO' ? undefined : '3', definitivo: true, numero: 15, refTipo: 'DIRECTO' } }) })()
      const cab = t.slice(0, t.search(/=====/))
      const lineas = cab.split('\n')
      const mitad = Math.floor(ancho / 2)
      const bien = lineas.every((l) => (/\x1d!\x11/.test(l) ? plano(l).replace(/\x1d!./g, '').length <= mitad : plano(l).replace(/\x1d!./g, '').length <= ancho))
      const sinEspacios = plano(cab).replace(/\x1d!./g, '').replace(/[\s]/g, '')
      const esperado = negocio.toUpperCase().replace(/\s/g, '')
      ok(sinEspacios.includes(esperado) && bien, tipo + ' ' + ancho + ': «' + negocio.slice(0, 22) + '…» en doble ancho entero, sin perder un carácter y sin pasar del ancho', cab)
    }
  }
  
}

// B3: modo consola sin basura
{
  const m = /function paraConsola\(t, sep\) \{[\s\S]*?\r?\n\}\r?\n/.exec(src)
  const paraConsola = new Function(m[0] + 'return paraConsola;')()
  const papel = R.render({ tipo: 'PRUEBA', payload: {} })
  const c = paraConsola(papel)
  ok(papel.includes('\x1dv0') && c.includes('[logo]') && !/[\x00-\x1f\x80-\xff]/.test(c) && c.includes('Hecho con'), 'B3: en modo consola el logo sale «[logo]» y no sus bytes', c.slice(0, 200))
}

// [Re-QA MEDIO-1 · B4] anchos absurdos no cuelgan, el pie cabe a 24 y a 20 columnas y las mayúsculas fuera de latin1 salen «?»
{
  const K = cargar('komo')
  for (const an of [20, 24, 100]) {
    K.setAncho(an)
    const t = K.render({ tipo: 'TICKET', payload: { negocio: 'Pollería Don Lucho SAC ' + 'X'.repeat(60), mesa: '3', items: [], total: 0, pagos: [] } })
    ok(t.includes('COBRADO') && K.render({ tipo: 'COMANDA', payload: { mesa: '3', items: [{ cantidad: 1, nombre: 'Y'.repeat(90) }] } }).includes('1 x Y'), 'ancho ' + an + ': el render termina (negocio y nombre larguísimos)')
  }
}
// [RCA] El render común acota el ancho a 24–80 columnas como la Edge: con 20 en la ventana el papel sale a 24, igual
// que cuando lo arma la Edge (antes el local y la nube daban papeles distintos).
for (const an of [24, 20]) {
  R.setAncho(an)
  const sinImg = texto(R.render({ tipo: 'PRUEBA', payload: { app: 'KOMO' } }))
  const pie = sinImg.slice(sinImg.indexOf('Hecho con ')).split('\n').slice(0, 4)
  ok(sinImg.includes('Hecho con KUTI\nlevodev.app\n') && pie.every((l) => l.length <= 24) && sinImg.startsWith('PRUEBA LEVOPRINT OK'), 'ancho ' + an + ': el pie cabe en 24 columnas (la dirección baja a su renglón)', pie)
}
R.setAncho(48)
{
  const t = R.render({ tipo: 'TICKET', payload: { negocio: 'Ωmega Pollería', mesa: '3', items: [], total: 0, pagos: [] } })
  ok(t.includes('?MEGA') && t.includes('POLLER') && !/[^\x00-\xff]/.test(t), 'mayúsculas: «Ωmega» sale «?MEGA» (latin1)')
}

// ---------- [KS-09 ICBPER] boleta con bolsas: línea ICBPER aparte del IGV; sin bolsas, nada nuevo ----------
{
  R.setAncho(48)
  const cpe = { tipo: 'BOLETA DE VENTA ELECTRONICA', serie: 'B001', numero: 1, estado: 'EMITIDO', empresa: { razonSocial: 'DEMO SAC', ruc: '20000000001' },
    cliente: { nombre: 'CLIENTE VARIOS', doc: '0' }, fecha: '09/11/2026 10:00',
    items: [{ cantidad: '2.000', nombre: 'Arroz Costeño 1kg', total: '25.00' }, { cantidad: '2.000', nombre: 'Bolsa plástica', total: '0.20' }],
    totales: { gravada: 21.36, igv: 3.84, icbper: 1.00 }, total: 26.20, pagos: [{ medio: 'EFECTIVO', monto: 26.2 }] }
  const t = texto(R.render({ tipo: 'CPE', payload: cpe }))
  ok(/IGV 18%\s+S\/ 3\.84\n/.test(t) && /ICBPER \(bolsas\)\s+S\/ 1\.00\n/.test(t) && /TOTAL\s+S\/ 26\.20\n/.test(t) && t.indexOf('ICBPER') > t.indexOf('IGV 18%') && t.indexOf('ICBPER') < t.indexOf('TOTAL'),
    'CPE con bolsas: «ICBPER (bolsas) S/ 1.00» entre el IGV y el TOTAL', t)
  const s = texto(R.render({ tipo: 'CPE', payload: { ...cpe, totales: { gravada: 21.19, igv: 3.81 }, total: 25 } }))
  ok(!s.includes('ICBPER'), 'CPE sin bolsas: no aparece ICBPER', s)
}

// ---------- [KCAP-PRINT] reimpresión a ciegas: leyenda con montosOcultos; payloads viejos sin cambio ----------
{
  const ley = 'Medios de pago: al contar la caja'
  const casos = [
    { tipo: 'TICKET', payload: { negocio: 'Chifa X', mesa: '5', mozo: 'Ana', hora: '13:05', items: [{ cantidad: 1, nombre: 'Lomo', precio: 28.5 }], total: 28.5, pagos: [] } },
    { tipo: 'TICKET', payload: { negocio: 'Bodega X', nota: 'NV-1', vendedor: 'Luis', items: [{ cantidad: 1, nombre: 'Arroz', precio: 5 }], total: 5, pagos: [] } },
    { tipo: 'CPE', payload: { tipo: 'BOLETA', serie: 'B001', numero: 1, empresa: { razonSocial: 'X SAC', ruc: '20123456789' }, cliente: { nombre: 'CLIENTE VARIOS', doc: '0' },
      items: [{ cantidad: 1, nombre: 'Lomo', total: 28.5 }], totales: { gravada: 24.15, igv: 4.35 }, total: 28.5, pagos: [] } },
  ]
  for (const c of casos) {
    const sin = texto(R.render(c))
    const con = texto(R.render({ tipo: c.tipo, payload: { ...c.payload, montosOcultos: true } }))
    ok(!sin.includes(ley) && con.includes(ley + '\n') && con.indexOf(ley) > con.indexOf('TOTAL'),
      c.tipo + (c.payload.mesa ? ' (mesa)' : '') + ': «' + ley + '» solo con montosOcultos, después del TOTAL', con)
  }
}

// ---------- [QA MEDIO-2] la versión que el agente manda en agente_config ----------
{
  const m = /const VERSION_AGENTE = '([0-9.]+)';/.exec(src)
  const cab = /Agente de impresión v([0-9.]+) /.exec(src)
  ok(m && cab && m[1] === cab[1] && src.includes("_agente_config`, { device: dev, version: 'exe/' + VERSION_AGENTE }"),
    'agente_config lleva version = exe/' + (m && m[1]) + ' (la misma de la cabecera)', { m: m && m[1], cab: cab && cab[1] })
}

// ---------- [RCA · 25-nov] render común: hash y fixtures de las Edges vivas, byte a byte ----------
{
  const { verificar, aCjs, sha256 } = require('../render_comun/convertir.cjs')
  const v = verificar()
  ok(v.ok, 'hash: render_comun/render.mjs = ORIGEN.json, lib/render_comun.js = su conversión exacta, fixtures y RenderComun.kt (APK) al día', v.errores.join(' | '))
  // el candado rechaza un render tocado a mano (lib), una fuente cambiada sin resincronizar y un port Kotlin desfasado
  {
    const os = require('os')
    const { RUTAS } = require('../render_comun/convertir.cjs')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-rca-'))
    const copia = {}
    for (const [k, r] of Object.entries(RUTAS)) { copia[k] = path.join(tmp, k + path.extname(r)); fs.copyFileSync(r, copia[k]) }
    const toca = (k, de, a) => { const s = fs.readFileSync(RUTAS[k], 'utf8'); fs.writeFileSync(copia[k], s.replace(de, a)); const r = verificar(copia); fs.copyFileSync(RUTAS[k], copia[k]); return r }
    ok(verificar(copia).ok, 'candado: la copia intacta pasa')
    const r1 = toca('cjs', "'SON: '", "'SON:  '")
    const r2 = toca('render', "'SON: '", "'SON:  '")
    const r3 = toca('kotlin', /RENDER_SHA256 = "[0-9a-f]{64}"/, 'RENDER_SHA256 = "' + '0'.repeat(64) + '"')
    const r4 = toca('fixtures', '"hex":"', '"hex":"00')
    ok(!r1.ok && !r2.ok && !r3.ok && !r4.ok && /conversión exacta/.test(r1.errores.join()) && /ORIGEN/.test(r2.errores.join()) && /RenderComun\.kt/.test(r3.errores.join()) && /fixtures/.test(r4.errores.join()),
      'candado: rechaza lib/render_comun.js tocado, render.mjs cambiado, RenderComun.kt de otro render y fixtures alterados', [r1, r2, r3, r4].map((r) => r.errores.join(' | ')).join(' || '))
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  const lib = require('./lib/render_comun')
  ok(lib.RENDER_SHA256 === v.origen.sha256_render && aCjs(fs.readFileSync(path.join(__dirname, '..', 'render_comun', 'render.mjs'), 'utf8')).includes("const RENDER_SHA256 = '" + sha256(fs.readFileSync(path.join(__dirname, '..', 'render_comun', 'render.mjs'), 'utf8')) + "'"),
    'el agente lleva el sha del render común (' + String(lib.RENDER_SHA256).slice(0, 12) + ')')
  ok(src.includes("const RENDER_COMUN = require('./lib/render_comun');") && !/function render(Cpe|Ticket|Comanda|Precuenta|CartaQr|Turno|Cierre)\(/.test(src) && !/function numeroALetras\(/.test(src),
    'index.js ya no tiene un render propio de papeles (solo el común; queda VINCULADO)')
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'render_comun', 'fixtures.json'), 'utf8'))
  const cache = {}
  const por = { edges_vivas: [0, 0, []], propios: [0, 0, []] }
  for (const x of fx) {
    const A = cache[x.app] || (cache[x.app] = cargar(x.app.toLowerCase()))
    A.setAncho(x.ancho); A.setImagen(x.imagen)
    const hex = Buffer.from(A.render({ tipo: x.tipo, payload: x.payload }), 'binary').toString('hex')
    const g = por[x.grupo] || (por[x.grupo] = [0, 0, []])
    g[1]++; if (hex === x.hex) g[0]++; else g[2].push(x.f)
  }
  const [okV, nV, malV] = por.edges_vivas
  ok(nV >= 90 && okV === nV, 'fixtures de las Edges vivas: ' + okV + ' de ' + nV + ' iguales byte a byte por el render local del agente', malV.join(', '))
  const [okP, nP, malP] = por.propios
  ok(okP === nP, 'fixtures propios del render común (QA LP-U1R): ' + okP + ' de ' + nP + ' iguales', malP.join(', '))
  // CPE: monto en letras (SUNAT) en todo comprobante con total válido; nada de «S/ NaN»
  const cpes = fx.filter((x) => x.tipo === 'CPE')
  const sinSon = cpes.filter((x) => { const t = texto(cargar(x.app.toLowerCase()).render({ tipo: 'CPE', payload: x.payload })); return Number.isFinite(Number(x.payload.total)) && x.payload.total !== null && x.payload.total !== '' && !/\nSON: [A-Z ]+ CON \d\d\/100 SOLES\n/.test(t) })
  ok(cpes.length > 20 && sinSon.length === 0, 'CPE: «SON: … SOLES» en los ' + cpes.length + ' comprobantes de los fixtures con total válido', sinSon.map((x) => x.f).join(', '))
  console.log('RESUMEN fixtures agente .exe: ' + okV + '/' + nV + ' Edges vivas, ' + okP + '/' + nP + ' propios')
}

console.log(fallas ? fallas + ' falla(s)' : 'render del agente: todo OK')
process.exit(fallas ? 1 : 0)
