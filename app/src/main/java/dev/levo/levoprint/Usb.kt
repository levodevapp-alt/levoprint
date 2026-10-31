package dev.levo.levoprint

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager

// [F2] Ticketera USB por OTG (USB host). PLAN §4.3: "principal en Android".
//   · res/xml/device_filter.xml + intent-filter USB_DEVICE_ATTACHED en el
//     manifiesto: al ENCHUFAR la impresora, Android ofrece abrir LevoPrint y
//     el permiso queda recordado para ese equipo ("Usar por defecto").
//   · Destino guardado en la estacion: "VID:PID" en hex (p. ej. 04B8:0E15).
//     Se busca por VID:PID (no por deviceName, que cambia al reconectar).
//   · Envio: interfaz clase 7 (impresora) o, si no hay, la primera con un
//     endpoint BULK OUT (muchas POS-58 chinas se anuncian como "vendor").
//     bulkTransfer en trozos de 16 KB con tope de 5 s cada uno.
object Usb {
  const val ACCION_PERMISO = "dev.levo.levoprint.USB_PERMISO"

  data class Disp(val nombre: String, val destino: String, val esImpresora: Boolean, val conPermiso: Boolean)

  private fun hex4(n: Int) = String.format(java.util.Locale.US, "%04X", n)
  fun destinoDe(d: UsbDevice) = hex4(d.vendorId) + ":" + hex4(d.productId)

  private fun claseImpresora(d: UsbDevice): Boolean {
    if (d.deviceClass == UsbConstants.USB_CLASS_PRINTER) return true
    for (i in 0 until d.interfaceCount) if (d.getInterface(i).interfaceClass == UsbConstants.USB_CLASS_PRINTER) return true
    return false
  }

  private fun tieneBulkOut(d: UsbDevice): Boolean {
    for (i in 0 until d.interfaceCount) {
      val itf = d.getInterface(i)
      for (e in 0 until itf.endpointCount) {
        val ep = itf.getEndpoint(e)
        if (ep.type == UsbConstants.USB_ENDPOINT_XFER_BULK && ep.direction == UsbConstants.USB_DIR_OUT) return true
      }
    }
    return false
  }

  fun listar(ctx: Context): List<Disp> {
    val um = ctx.getSystemService(Context.USB_SERVICE) as? UsbManager ?: return emptyList()
    return um.deviceList.values.filter { claseImpresora(it) || tieneBulkOut(it) }.map { d ->
      val nombre = listOfNotNull(d.manufacturerNameSeguro(), d.productNameSeguro()).joinToString(" ").ifBlank { "Impresora USB " + destinoDe(d) }
      Disp(nombre, destinoDe(d), claseImpresora(d), um.hasPermission(d))
    }
  }

  // Nombres: en algunos equipos leerlos sin permiso lanza SecurityException.
  private fun UsbDevice.manufacturerNameSeguro(): String? = try { manufacturerName } catch (_: Exception) { null }
  private fun UsbDevice.productNameSeguro(): String? = try { productName } catch (_: Exception) { null }

  private fun buscar(um: UsbManager, destino: String): UsbDevice? =
    um.deviceList.values.firstOrNull { destinoDe(it).equals(destino.trim(), ignoreCase = true) }

  // Pide el permiso (dialogo del sistema). El resultado llega a quien escuche ACCION_PERMISO.
  fun pedirPermiso(ctx: Context, destino: String): Boolean {
    val um = ctx.getSystemService(Context.USB_SERVICE) as? UsbManager ?: return false
    val d = buscar(um, destino) ?: return false
    if (um.hasPermission(d)) return true
    val flags = if (android.os.Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
    val pi = PendingIntent.getBroadcast(ctx, 11, Intent(ACCION_PERMISO).setPackage(ctx.packageName), flags)
    um.requestPermission(d, pi)
    return false
  }

  fun imprimir(ctx: Context, destino: String, datos: ByteArray) {
    val um = ctx.getSystemService(Context.USB_SERVICE) as? UsbManager ?: throw RuntimeException("este equipo no tiene USB host (OTG)")
    val d = buscar(um, destino) ?: throw RuntimeException("impresora USB $destino no conectada (revisa el cable OTG)")
    if (!um.hasPermission(d)) { pedirPermiso(ctx, destino); throw RuntimeException("falta el permiso USB: abre LevoPrint y toca Permitir") }
    // Interfaz de impresora primero; si no, cualquiera con BULK OUT.
    var itf: android.hardware.usb.UsbInterface? = null
    var ep: android.hardware.usb.UsbEndpoint? = null
    val orden = (0 until d.interfaceCount).sortedBy { if (d.getInterface(it).interfaceClass == UsbConstants.USB_CLASS_PRINTER) 0 else 1 }
    loop@ for (i in orden) {
      val x = d.getInterface(i)
      for (e in 0 until x.endpointCount) {
        val y = x.getEndpoint(e)
        if (y.type == UsbConstants.USB_ENDPOINT_XFER_BULK && y.direction == UsbConstants.USB_DIR_OUT) { itf = x; ep = y; break@loop }
      }
    }
    if (itf == null || ep == null) throw RuntimeException("la impresora USB no tiene salida de datos (BULK OUT)")
    val con = um.openDevice(d) ?: throw RuntimeException("no se pudo abrir la impresora USB")
    try {
      if (!con.claimInterface(itf, true)) throw RuntimeException("otra app tiene tomada la impresora USB")
      var off = 0
      while (off < datos.size) {
        val n = minOf(16384, datos.size - off)
        // bulkTransfer con offset existe desde API 28; en 26-27 se copia el trozo.
        val escritos = if (android.os.Build.VERSION.SDK_INT >= 28) con.bulkTransfer(ep, datos, off, n, 5000)
          else con.bulkTransfer(ep, datos.copyOfRange(off, off + n), n, 5000)
        if (escritos <= 0) throw RuntimeException("la impresora USB no acepto los datos (timeout)")
        off += escritos
      }
      try { con.releaseInterface(itf) } catch (_: Exception) {}
    } finally {
      con.close()
    }
  }
}
