// ============================================================
// LevoPrint · USB en Windows por la cola de impresion (spooler, RAW) (F2)
// ------------------------------------------------------------
// PORQUE: Node puro no habla con winspool. Con su driver (o con "Generic /
// Text Only" en el puerto USB001) la ticketera USB ES una impresora de
// Windows; le mandamos el ESC/POS tal cual (datatype RAW) con
// OpenPrinter/StartDocPrinter/WritePrinter, desde un helper PowerShell con
// C# embebido (Add-Type). Sin instalar nada: PowerShell 5.1 viene en Windows.
//
// Por que NO WebUSB en PC: usbprint.sys toma la impresora y claimInterface
// falla; cambiar a WinUSB (Zadig) rompe la impresion normal (PLAN §4.3).
//
// Los datos viajan por un archivo temporal y los nombres por variables de
// entorno (nada de comillas armadas a mano: un nombre de impresora con
// comillas o tildes no rompe el comando). Cada trabajo abre un PowerShell
// (~1-3 s con la compilacion del C#): aceptable para tickets; si hiciera
// falta, el siguiente paso es un PowerShell persistente.
//
// [QA F2 MEDIO-5] Endurecido:
//   · Los scripts son archivos .ps1 en la carpeta de LevoPrint (configurar),
//     que se reescriben al arrancar y se corren con -File (nada de
//     -EncodedCommand, que los antivirus miran con razon). Sigue haciendo
//     falta -ExecutionPolicy Bypass (de este proceso, no del equipo): Windows
//     trae "Restricted" y un .ps1 sin firma no correria. Con el .exe y los
//     .ps1 FIRMADOS se podria pasar a AllSigned (pendiente: certificado de
//     firma de codigo de LevoDev; ver docs/F2_IMPRESION_LOCAL.md).
//   · El proceso hijo recibe un entorno MINIMO (sistema + LP_*), no el
//     entorno completo del agente.
//   · Los .bin temporales viven en <tmp>/levoprint-raw, se borran en finally
//     (tambien si falla la escritura) y al arrancar se limpian los viejos.
// ============================================================
'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ES_WINDOWS = process.platform === 'win32';

const DIR_TMP = path.join(os.tmpdir(), 'levoprint-raw');
let dirScripts = path.join(os.tmpdir(), 'levoprint-ps');   // configurar() lo cambia a la carpeta de LevoPrint
const PRE = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r\n$ProgressPreference = "SilentlyContinue"\r\n';

// Escribe los .ps1 junto a LevoPrint y limpia temporales viejos (> 1 h).
function configurar(dir) {
  if (dir) dirScripts = dir;
  try {
    fs.mkdirSync(dirScripts, { recursive: true });
    for (const [nombre, cuerpo] of Object.entries(SCRIPTS)) {
      const f = path.join(dirScripts, nombre);
      const txt = '\uFEFF' + PRE + cuerpo.replace(/\r?\n/g, '\r\n');
      let actual = null;
      try { actual = fs.readFileSync(f, 'utf8'); } catch { actual = null; }
      if (actual !== txt) fs.writeFileSync(f, txt, 'utf8');
    }
  } catch { /* carpeta de solo lectura: falla al imprimir con un mensaje claro */ }
  try {
    const limite = Date.now() - 3600000;
    for (const f of fs.readdirSync(DIR_TMP)) {
      const p = path.join(DIR_TMP, f);
      try { if (fs.statSync(p).mtimeMs < limite) fs.unlinkSync(p); } catch { /* en uso */ }
    }
  } catch { /* no existe todavia */ }
}

// Entorno minimo del PowerShell hijo: lo justo para que arranque y cargue
// sus modulos (PrintManagement), mas las variables LP_* del trabajo.
function entornoMinimo(extra) {
  const e = {};
  for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'SystemDrive', 'ProgramFiles', 'ProgramData', 'TEMP', 'TMP', 'USERPROFILE', 'COMPUTERNAME', 'PATHEXT']) {
    if (process.env[k]) e[k] = process.env[k];
  }
  const raiz = process.env.SystemRoot || 'C:\\Windows';
  e.PATH = [raiz + '\\System32', raiz, raiz + '\\System32\\WindowsPowerShell\\v1.0'].join(';');
  return { ...e, ...(extra || {}) };
}

// Corre uno de los .ps1 con -File y devuelve stdout (UTF-8).
function powershell(nombre, env, timeoutMs) {
  if (!SCRIPTS[nombre]) return Promise.reject(new Error('script desconocido'));
  const archivo = path.join(dirScripts, nombre);
  if (!fs.existsSync(archivo)) configurar();
  const raiz = process.env.SystemRoot || 'C:\\Windows';
  const exe = path.join(raiz, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    execFile(fs.existsSync(exe) ? exe : 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', archivo], {
      env: entornoMinimo(env), timeout: timeoutMs || 20000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error((stderr || err.message || 'powershell fallo').toString().trim().slice(0, 300)));
      resolve(String(stdout || '').trim());
    });
  });
}

const SCRIPT_LISTAR = `
$ErrorActionPreference = 'Stop'
$lista = @()
try {
  $lista = @(Get-Printer | ForEach-Object { [pscustomobject]@{ nombre = $_.Name; puerto = $_.PortName; driver = $_.DriverName; estado = [string]$_.PrinterStatus; compartida = [bool]$_.Shared } })
} catch {
  $lista = @(Get-CimInstance Win32_Printer | ForEach-Object { [pscustomobject]@{ nombre = $_.Name; puerto = $_.PortName; driver = $_.DriverName; estado = [string]$_.PrinterStatus; compartida = [bool]$_.Shared } })
}
ConvertTo-Json -InputObject @($lista) -Compress -Depth 3
`;

// C# minimo sobre winspool.drv. DOC_INFO_1.pOutputFile (LP_SALIDA) solo se usa
// en las pruebas (imprimir a archivo sin dialogo); en el local va vacio.
const SCRIPT_IMPRIMIR = `
$ErrorActionPreference = 'Stop'
if (-not ('LevoRaw' -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class LevoRaw {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool OpenPrinter(string nombre, out IntPtr h, IntPtr def);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern int StartDocPrinter(IntPtr h, int nivel, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, byte[] buf, int n, out int escritos);
  public static int Enviar(string impresora, byte[] datos, string doc, string salida) {
    IntPtr h;
    if (!OpenPrinter(impresora, out h, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenPrinter");
    try {
      DOCINFO di = new DOCINFO();
      di.pDocName = doc; di.pDataType = "RAW";
      di.pOutputFile = String.IsNullOrEmpty(salida) ? null : salida;
      if (StartDocPrinter(h, 1, di) == 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "StartDocPrinter");
      try {
        if (!StartPagePrinter(h)) throw new Win32Exception(Marshal.GetLastWin32Error(), "StartPagePrinter");
        int total = 0;
        while (total < datos.Length) {
          byte[] trozo = new byte[datos.Length - total];
          Array.Copy(datos, total, trozo, 0, trozo.Length);
          int escritos;
          if (!WritePrinter(h, trozo, trozo.Length, out escritos)) throw new Win32Exception(Marshal.GetLastWin32Error(), "WritePrinter");
          if (escritos <= 0) throw new Exception("WritePrinter no escribio nada");
          total += escritos;
        }
        EndPagePrinter(h);
        return total;
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
}
try {
  $datos = [System.IO.File]::ReadAllBytes($env:LP_ARCHIVO)
  $n = [LevoRaw]::Enviar($env:LP_IMPRESORA, $datos, $env:LP_DOC, $env:LP_SALIDA)
  ConvertTo-Json -InputObject ([pscustomobject]@{ ok = $true; bytes = $n }) -Compress
} catch {
  $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }
  $cod = 0; if ($e -is [System.ComponentModel.Win32Exception]) { $cod = $e.NativeErrorCode }
  ConvertTo-Json -InputObject ([pscustomobject]@{ ok = $false; error = $e.Message; codigo = $cod }) -Compress
}
`;

// Que tipo de impresora es, por su puerto y driver.
function clasificar(p) {
  const puerto = String(p.puerto || '');
  const driver = String(p.driver || '');
  let via = 'OTRA';
  if (/^USB\d+/i.test(puerto)) via = 'USB';
  else if (/^(BTH|BT)/i.test(puerto) || /bluetooth/i.test(driver)) via = 'BT';
  else if (/^COM\d+/i.test(puerto)) via = 'SERIAL';
  else if (/^(IP_)?\d{1,3}(\.\d{1,3}){3}(_\d+)?$/i.test(puerto) || /^WSD-/i.test(puerto)) via = 'RED';
  else if (/^(PORTPROMPT:|nul:|SHRFAX:|FILE:|XPSPORT:|OneNote|Microsoft)/i.test(puerto)) via = 'VIRTUAL';
  const ticketera = /POS|XP-|TM-|Generic|Text Only|Thermal|T[eé]rmica|80 ?mm|58 ?mm|EPSON TM|Xprinter|BIXOLON|Star |SRP-|RONGTA|HPRT|3nStar|Sewoo/i.test(driver + ' ' + (p.nombre || ''));
  const ipRed = via === 'RED' ? (puerto.match(/\d{1,3}(\.\d{1,3}){3}/) || [null])[0] : null;
  return { ...p, via, ticketera, ipRed };
}

const SCRIPTS = { 'levoprint-listar.ps1': SCRIPT_LISTAR, 'levoprint-raw.ps1': SCRIPT_IMPRIMIR };

async function listar() {
  if (!ES_WINDOWS) return [];
  const out = await powershell('levoprint-listar.ps1', null, 20000);
  let lista = [];
  try { lista = JSON.parse(out || '[]'); } catch { throw new Error('no pude leer la lista de impresoras de Windows'); }
  if (!Array.isArray(lista)) lista = lista ? [lista] : [];
  return lista.map(clasificar);
}

// Manda bytes RAW a una impresora de Windows por su nombre.
async function imprimir(nombre, datos, opciones = {}) {
  if (!ES_WINDOWS) throw new Error('USB por la cola de Windows solo existe en el .exe de PC');
  if (!nombre) throw new Error('falta el nombre de la impresora de Windows');
  const archivo = path.join(DIR_TMP, 'levoprint-' + crypto.randomBytes(6).toString('hex') + '.bin');
  try {
    fs.mkdirSync(DIR_TMP, { recursive: true });
    fs.writeFileSync(archivo, Buffer.isBuffer(datos) ? datos : Buffer.from(String(datos), 'binary'));
    const out = await powershell('levoprint-raw.ps1', {
      LP_ARCHIVO: archivo, LP_IMPRESORA: String(nombre), LP_DOC: opciones.documento || 'LevoPrint', LP_SALIDA: opciones.archivoSalida || '',
    }, opciones.timeoutMs || 25000);
    let r;
    try { r = JSON.parse(out.split(/\r?\n/).filter(Boolean).pop() || '{}'); } catch { r = { ok: false, error: out.slice(0, 200) }; }
    if (!r.ok) {
      const e = new Error(`impresora USB "${nombre}": ${r.error || 'fallo'}${r.codigo ? ' (' + r.codigo + ')' : ''}`);
      e.codigo = r.codigo;
      // No se abrio la impresora o no empezo el documento: no salio nada.
      e.sinEnviar = /OpenPrinter|StartDocPrinter|StartPagePrinter/.test(String(r.error || ''));
      throw e;
    }
    return r.bytes;
  } finally {
    try { fs.unlinkSync(archivo); } catch { /* lo borra el sistema luego */ }
  }
}

module.exports = { listar, imprimir, clasificar, configurar, ES_WINDOWS, DIR_TMP, entornoMinimo };
