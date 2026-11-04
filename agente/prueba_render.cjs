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
  const ctx = { PREFIJO: prefijo, ANCHO: 48, CON_IMAGEN: true, process: { env: {} }, Buffer, console }
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
ok(texto(R.render({ tipo: 'COMANDA', payload: { mesa: '3', mozo: 'Ana', items: [], atrasada: true, hora: '12:00' } })).startsWith('*** ATRASADA ***'), 'COMANDA atrasada con su sello')
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

// ---------- [QA MEDIO-2] la versión que el agente manda en agente_config ----------
{
  const m = /const VERSION_AGENTE = '([0-9.]+)';/.exec(src)
  const cab = /Agente de impresión v([0-9.]+) /.exec(src)
  ok(m && cab && m[1] === cab[1] && src.includes("_agente_config`, { device: dev, version: 'exe/' + VERSION_AGENTE }"),
    'agente_config lleva version = exe/' + (m && m[1]) + ' (la misma de la cabecera)', { m: m && m[1], cab: cab && cab[1] })
}

console.log(fallas ? fallas + ' falla(s)' : 'render del agente: todo OK')
process.exit(fallas ? 1 : 0)
