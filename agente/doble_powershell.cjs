// ============================================================
// LevoPrint · doble del proceso PowerShell de la impresión USB (solo pruebas)
// ------------------------------------------------------------
// index.js lo usa en vez de powershell.exe cuando corre como `node index.js`
// con LEVO_PRUEBA_PS=<ruta de este archivo> (el .exe lo ignora). Habla el mismo
// protocolo: la 1.ª línea es el script (se revisa que traiga Add-Type y que el
// C# llegue en LP_CS), responde {listo:true}; luego una línea JSON por pedido.
//   LP_DOBLE_MODO=restringido  → {listo:false, error:'POWERSHELL_RESTRINGIDO'} y sale
//   LP_DOBLE_SALIDA=<archivo>  → cada impresión se anota ahí (una línea JSON)
// La cola «CUELGA» nunca responde (prueba el tiempo máximo y el reinicio). «CUELGA_AL_CERRAR» manda los
// datos completos (aviso {escrito:true}) y se traba al cerrar el trabajo (no debe contarse como fallo).
// ============================================================
'use strict';
const fs = require('fs');
const readline = require('readline');

const sale = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const COLAS = [
  { nombre: 'POS-80 USB', driver: 'POS-80C', puerto: 'USB001' },
  { nombre: 'Caja \u00d1and\u00fa', driver: 'Generic / Text Only', puerto: 'USB002' },
  { nombre: 'CUELGA', driver: 'Generic / Text Only', puerto: 'USB003' },
  { nombre: 'CUELGA_AL_CERRAR', driver: 'Generic / Text Only', puerto: 'USB004' },
  { nombre: 'Microsoft Print to PDF', driver: 'Microsoft Print To PDF', puerto: 'PORTPROMPT:' },
  { nombre: 'Fax', driver: 'Microsoft Shared Fax Driver', puerto: 'SHRFAX:' },
];
let primera = true;
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (l) => {
  if (primera) {
    primera = false;
    process.stdout.write('PS C:\\> \n'); // ruido como el de PowerShell: el agente lo ignora
    if (process.env.LP_DOBLE_MODO === 'restringido') { sale({ listo: false, error: 'POWERSHELL_RESTRINGIDO', detalle: 'ConstrainedLanguage' }); process.exit(3); }
    if (!/Add-Type/.test(l) || !/LpRaw/.test(process.env.LP_CS || '')) { sale({ listo: false, error: 'POWERSHELL_RESTRINGIDO', detalle: 'script incompleto' }); process.exit(3); }
    sale({ listo: true });
    return;
  }
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.op === 'listar') return sale({ id: m.id, ok: true, impresoras: COLAS });
  if (m.op === 'imprimir') {
    if (m.cola === 'CUELGA') return; // no responde nunca
    if (m.cola === 'CUELGA_AL_CERRAR') return sale({ id: m.id, escrito: true }); // escribió todo y no cierra
    if (!COLAS.some((c) => c.nombre === m.cola)) return sale({ id: m.id, ok: false, error: 'WIN32_1801' });
    if (process.env.LP_DOBLE_SALIDA) {
      fs.appendFileSync(process.env.LP_DOBLE_SALIDA, JSON.stringify({ pid: process.pid, cola: m.cola, texto: Buffer.from(m.b64, 'base64').toString('latin1') }) + '\n');
    }
    return sale({ id: m.id, ok: true });
  }
  sale({ id: m.id, ok: false, error: 'OP_DESCONOCIDA' });
});
