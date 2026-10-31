package dev.levo.levoprint

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

// [F2] Asistente "Buscar impresoras" del APK (PLAN §4.3.2): USB por OTG,
// Bluetooth emparejadas y red (puerto 9100 del /24). Cada hallazgo trae
// transporte/destino listos para asignar a una estacion con un toque.
// Mismo formato de respuesta que el .exe (/v1/impresoras).
object Buscar {
  data class Hallazgo(val via: String, val transporte: String, val destino: String, val nombre: String, val detalle: String, val ticketera: Boolean)

  fun lista(ctx: Context): List<Hallazgo> {
    val out = ArrayList<Hallazgo>()
    for (u in Usb.listar(ctx)) out.add(Hallazgo("USB", "USB_ANDROID", u.destino, u.nombre, u.destino + (if (u.conPermiso) "" else " · falta permiso"), u.esImpresora))
    for (b in Bt.emparejadas()) out.add(Hallazgo("BT", "BT", b.mac, b.nombre, b.mac, Regex("(?i)print|pos|pt-|mtp|xp-|rpp|58|80").containsMatchIn(b.nombre)))
    for (ip in Red.barrer()) out.add(Hallazgo("RED", "TCP", "$ip:9100", "Impresora de red $ip", "$ip:9100", true))
    return out.sortedWith(compareByDescending<Hallazgo> { it.ticketera }.thenBy { it.via }.thenBy { it.nombre })
  }

  fun todo(ctx: Context): JSONObject {
    val arr = JSONArray()
    val l = try { lista(ctx) } catch (e: Exception) { return JSONObject().put("ok", false).put("impresoras", arr).put("avisos", JSONArray().put(e.message)) }
    for (h in l) arr.put(JSONObject().put("id", h.transporte + ":" + h.destino).put("via", h.via).put("transporte", h.transporte)
      .put("destino", h.destino).put("nombre", h.nombre).put("detalle", h.detalle).put("ticketera", h.ticketera))
    return JSONObject().put("ok", true).put("impresoras", arr).put("avisos", JSONArray()).put("ts", System.currentTimeMillis())
  }
}
