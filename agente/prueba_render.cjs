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
  const ctx = { PREFIJO: prefijo, ANCHO: 48, process: { env: {} }, Buffer, console }
  vm.createContext(ctx)
  vm.runInContext('var PREFIJO = this.PREFIJO, ANCHO = this.ANCHO;\n' + src.slice(a, b).replace(/^const /gm, 'var ') +
    '\nthis.render = render; this.pieMarca = pieMarca; this.setAncho = (n) => { ANCHO = n };', ctx)
  return ctx
}
const R = cargar('kuti')
let fallas = 0
const ok = (c, m, det) => { console.log((c ? 'OK    ' : 'FALLA ') + m + (c || det === undefined ? '' : '\n      ' + String(det).slice(0, 1200))); if (!c) fallas++ }
// Texto impreso sin los comandos ESC/POS (ESC @, ESC a n, ESC E n, ESC ! n, GS ! n, GS V n)
const texto = (t) => t.replace(/\x1b@|\x1b[aE!][\s\S]|\x1d[!V][\s\S]/g, '')
const ascii = (s) => [...s].every((c) => c.charCodeAt(0) < 128)

// ---------- [O-23] TURNO ----------
const def = { app: 'KUTI', negocio: 'Barbería Demo', local: 'Sede Centro', definitivo: true, numero: 15, provisional: '', nombre: 'Carlos P.', con: 'Jorge', fecha: '04/11/2026 10:05', delante: 2 }
const prov = { ...def, definitivo: false, numero: 'A-07', provisional: 'A-07', nombre: '', con: null, delante: null }
for (const an of [48, 32]) {
  R.setAncho(an)
  const crudo = R.render({ tipo: 'TURNO', payload: def }); const t = texto(crudo)
  ok(t.includes('BARBERÍA DEMO') && t.includes('Sede Centro') && t.includes('TURNO SIN CITA') && t.includes('Tu numero\n15\n') && crudo.includes('\x1d!\x22' + '15\n'), `TURNO ${an}: definitivo con el número de la cola en triple alto`, t)
  ok(t.includes('Carlos P.\nCon Jorge\n04/11/2026 10:05\n') && t.includes('Hay 2 personas delante.') && t.includes('Sistema KUTI - LevoDev'), `TURNO ${an}: nombre, con quién, hora, cuántos delante y pie`, t)
  ok(t.split('\n').filter((l) => !l.startsWith('BARBER')).every((l) => l.length <= an), `TURNO ${an}: ninguna línea pasa del ancho`, t)
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

// ---------- pie de marca ----------
ok(R.pieMarca('KUTI', 48) === 'Sistema KUTI - LevoDev\nTu negocio tambien: kuti.levodev.app\n' && R.pieMarca('KOMO', 32) === 'Sistema KOMO - LevoDev\nTu negocio tambien:\nkomo.levodev.app\n' && R.pieMarca('otra', 48) === 'LevoDev - levodev.app\n', 'pie de marca por app y partido en 58 mm')
ok(['KOMO', 'KIPU', 'KUTI', 'x'].every((ap) => [32, 48].every((an) => ascii(R.pieMarca(ap, an)) && R.pieMarca(ap, an).split('\n').every((l) => l.length <= an))), 'pie de marca en ASCII puro y dentro del ancho')

// ---------- nota de venta de KUTI, sellos y prueba ----------
R.setAncho(48)
const nv = { app: 'KUTI', refTipo: 'DIRECTO', nota: 'NV01-00000042', negocio: 'Barbería Demo', hora: '18:30', vendedor: 'Jorge', items: [{ cantidad: 1, nombre: 'Perfilado', precio: 13, profesional: 'Jorge' }], total: 13, pagos: [{ medio: 'Efectivo', monto: 13 }] }
const tn = texto(R.render({ tipo: 'TICKET', payload: nv }))
ok(tn.includes('VENTA') && tn.includes('NV01-00000042') && tn.includes('S/ 13.00') && tn.includes('NO ES COMPROBANTE DE PAGO') && !tn.includes('COPIA'), 'TICKET KUTI: nota de venta con total y sin COPIA', tn)
ok(texto(R.render({ tipo: 'TICKET', payload: { ...nv, copia: true, reimpresion: true } })).startsWith('*** COPIA ***'), 'TICKET KUTI: reimpresión con COPIA')
ok(texto(R.render({ tipo: 'COMANDA', payload: { mesa: '3', mozo: 'Ana', items: [], atrasada: true, hora: '12:00' } })).startsWith('*** ATRASADA ***'), 'COMANDA atrasada con su sello')
ok(texto(R.render({ tipo: 'PRUEBA', payload: {} })).includes('PRUEBA LEVOPRINT OK'), 'PRUEBA')

console.log(fallas ? fallas + ' falla(s)' : 'render del agente: todo OK')
process.exit(fallas ? 1 : 0)
