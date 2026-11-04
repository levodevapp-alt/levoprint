package dev.levo.levoprint

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Build
import androidx.core.app.NotificationCompat

// [LP-F4] Impresora USB conectada al celular o tablet (cable OTG). Se usa la interfaz de clase 7
// (impresora) o 0xFF (propia del fabricante, comun en termicas chinas) que tenga un extremo bulk de
// SALIDA, y se manda el ESC/POS en bloques de 16 KB con una pausa corta (algunas termicas pierden
// datos si llegan de golpe).
// Permiso: si el equipo se abrio desde «LevoPrint se abre al conectar esta impresora» (filtro
// res/xml/usb_impresoras.xml, clase 7) con «usar por defecto», Android lo recuerda. Si no, se pide
// con requestPermission (PendingIntent FLAG_MUTABLE: Android le agrega el resultado) y el trabajo
// falla con USB_SIN_PERMISO + una notificacion para abrir LevoPrint y aceptar.
// Ref de la impresora (usbId): "vvvv:pppp[:serie]" (BusquedaLogica.refUsb / coincideUsb).
object Usb {
  const val ACCION_PERMISO = "dev.levo.levoprint.USB_PERMISO"
  private const val BLOQUE = 16 * 1024
  private const val TIEMPO_MS = 5000
  private const val NOTIF_USB = 3

  private fun manager(ctx: Context): UsbManager? = ctx.getSystemService(UsbManager::class.java)

  // Interfaz + extremo bulk OUT de una impresora (clase 7 primero, luego 0xFF).
  private fun salida(dev: UsbDevice): Pair<UsbInterface, UsbEndpoint>? {
    for (claseBuscada in intArrayOf(UsbConstants.USB_CLASS_PRINTER, UsbConstants.USB_CLASS_VENDOR_SPEC)) {
      for (i in 0 until dev.interfaceCount) {
        val intf = dev.getInterface(i)
        if (intf.interfaceClass != claseBuscada) continue
        for (k in 0 until intf.endpointCount) {
          val ep = intf.getEndpoint(k)
          if (ep.type == UsbConstants.USB_ENDPOINT_XFER_BULK && ep.direction == UsbConstants.USB_DIR_OUT) return intf to ep
        }
      }
    }
    return null
  }

  private fun esImpresora(dev: UsbDevice): Boolean =
    dev.deviceClass == UsbConstants.USB_CLASS_PRINTER || (0 until dev.interfaceCount).any { dev.getInterface(it).interfaceClass == UsbConstants.USB_CLASS_PRINTER }

  // La serie solo se puede leer con permiso (Android 10+): sin el, la ref queda "vvvv:pppp".
  private fun serie(m: UsbManager, dev: UsbDevice): String? = try {
    if (m.hasPermission(dev)) dev.serialNumber else null
  } catch (_: Exception) { null }

  fun buscar(ctx: Context): List<Encontrada> {
    val m = manager(ctx) ?: return emptyList()
    val out = ArrayList<Encontrada>()
    for (dev in m.deviceList.values) {
      if (salida(dev) == null) continue
      val nombre = listOfNotNull(dev.manufacturerName?.trim(), dev.productName?.trim()).filter { it.isNotBlank() }.joinToString(" ")
        .ifBlank { "Impresora USB" }.take(80)
      out.add(Encontrada("usb", BusquedaLogica.refUsb(dev.vendorId, dev.productId, serie(m, dev)), nombre,
        org.json.JSONObject().put("vid", dev.vendorId).put("pid", dev.productId)
          .put("clase7", esImpresora(dev)).put("probableTermica", true).put("permiso", m.hasPermission(dev))))
    }
    return out
  }

  private fun buscarEquipo(m: UsbManager, usbId: String): UsbDevice? =
    m.deviceList.values.firstOrNull { BusquedaLogica.coincideUsb(usbId, it.vendorId, it.productId, serie(m, it)) && salida(it) != null }

  fun pedirPermiso(ctx: Context, usbId: String): Boolean {
    val m = manager(ctx) ?: return false
    val dev = buscarEquipo(m, usbId) ?: return false
    if (m.hasPermission(dev)) return true
    val flags = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
    val pi = PendingIntent.getBroadcast(ctx, 11, Intent(ACCION_PERMISO).setPackage(ctx.packageName), flags or PendingIntent.FLAG_UPDATE_CURRENT)
    try { m.requestPermission(dev, pi) } catch (_: Exception) { return false }
    return false
  }

  fun imprimir(ctx: Context, usbId: String, texto: String) {
    val m = manager(ctx) ?: throw RuntimeException("USB_NO_DISPONIBLE: este equipo no tiene USB host")
    val dev = buscarEquipo(m, usbId) ?: throw RuntimeException("USB_DESCONECTADA: la impresora USB no esta conectada a este equipo")
    if (!m.hasPermission(dev)) {
      pedirPermiso(ctx, usbId)
      avisarSinPermiso(ctx)
      throw RuntimeException("USB_SIN_PERMISO: abre LevoPrint y toca «Permitir» para la impresora USB")
    }
    val (intf, ep) = salida(dev) ?: throw RuntimeException("USB_NO_ES_IMPRESORA: el equipo USB no recibe impresion")
    val con = m.openDevice(dev) ?: throw RuntimeException("USB_NO_ABRE: no se pudo abrir la impresora USB")
    try {
      if (!con.claimInterface(intf, true)) throw RuntimeException("USB_OCUPADA: otra app esta usando la impresora USB")
      val datos = Agent.bytes(texto)
      var i = 0
      while (i < datos.size) {
        val n = minOf(BLOQUE, datos.size - i)
        val enviados = con.bulkTransfer(ep, datos, i, n, TIEMPO_MS)
        if (enviados <= 0) throw RuntimeException("USB_ERROR: la impresora USB no recibio los datos")
        i += enviados
        if (i < datos.size) try { Thread.sleep(30) } catch (_: InterruptedException) {}
      }
      try { con.releaseInterface(intf) } catch (_: Exception) {}
    } finally {
      try { con.close() } catch (_: Exception) {}
    }
  }

  // Notificacion «Toca para permitir la impresora USB» (abre LevoPrint, donde Android muestra el permiso).
  private fun avisarSinPermiso(ctx: Context) {
    try {
      val abrir = PendingIntent.getActivity(ctx, 12, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      val n = NotificationCompat.Builder(ctx, PrintService.CANAL)
        .setContentTitle("Falta permiso para la impresora USB")
        .setContentText("Toca aquí y acepta el permiso para que salgan los pedidos.")
        .setSmallIcon(R.drawable.ic_launcher_foreground)
        .setContentIntent(abrir)
        .setAutoCancel(true)
        .build()
      ctx.getSystemService(NotificationManager::class.java)?.notify(NOTIF_USB, n)
    } catch (_: Exception) {}
  }
}
