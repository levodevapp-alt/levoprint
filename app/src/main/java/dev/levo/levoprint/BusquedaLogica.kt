package dev.levo.levoprint

import org.json.JSONArray
import org.json.JSONObject

// [LP-F3 · LP-F4] Logica pura de la busqueda y del destino por estacion (sin Android: la prueban
// las pruebas de unidad, BusquedaLogicaTest). Mismo criterio que el .exe 1.13 (agente/index.js):
//   · Red: hosts de la /24 propia (mascara mas ancha se recorta a /24; sin 169.254), puerto 9100.
//   · USB Android: ref "vvvv:pppp[:serie]" en hexadecimal de 4 cifras.
//   · Bluetooth: MAC en mayusculas "AA:BB:CC:DD:EE:FF".
// El contrato con el backend (levoprint_transporte) esta en levodev-modules docs/LEVOPRINT.md §8.

// Impresora encontrada por este equipo (va en <prefijo>_agente_impresoras -> encontradas).
data class Encontrada(
  val transporte: String, val ref: String, val nombre: String,
  val detalle: JSONObject = JSONObject()
) {
  fun json(): JSONObject = JSONObject().put("transporte", transporte).put("ref", ref).put("nombre", nombre).put("detalle", detalle)
}

// Destino de una estacion (respuesta de <prefijo>_agente_impresoras -> destinos).
data class Destino(
  val estacion: String, val nombre: String, val transporte: String,
  val ip: String?, val puerto: Int, val btMac: String?, val usbId: String?,
  val impresoraNombre: String, val propio: Boolean
) {
  // ¿Este equipo puede imprimir ahi? (red con IP, o BT/USB que esta en este equipo)
  val imprimible: Boolean get() = when (transporte) {
    "red" -> ip != null
    "bluetooth" -> propio && btMac != null
    "usb" -> propio && usbId != null
    else -> false
  }
  val clave: String get() = if (transporte == "red") "red:" + ip + ":" + puerto else transporte + ":" + (usbId ?: btMac ?: "")
  fun texto(): String = when (transporte) {
    "usb" -> (if (propio) "USB en este equipo: " else "USB en otro equipo: ") + impresoraNombre.ifBlank { usbId ?: "" }
    "bluetooth" -> (if (propio) "Bluetooth: " else "Bluetooth en otro equipo: ") + impresoraNombre.ifBlank { btMac ?: "" }
    else -> if (ip != null) "Red: " + ip + ":" + puerto else ""
  }
}

object BusquedaLogica {
  const val PUERTO_IMPRESORA = 9100
  const val MAX_ENCONTRADAS = 64
  private val MAC = Regex("^([0-9A-F]{2}:){5}[0-9A-F]{2}$")
  private val IPV4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")

  fun ipANum(ip: String): Long {
    val m = IPV4.matchEntire(ip.trim()) ?: return -1L
    var n = 0L
    for (i in 1..4) { val x = m.groupValues[i].toInt(); if (x > 255) return -1L; n = n * 256 + x }
    return n
  }

  fun numAIp(n: Long): String = listOf((n shr 24) and 255, (n shr 16) and 255, (n shr 8) and 255, n and 255).joinToString(".")

  // [QA LP-F3 · MEDIO 2] Solo redes privadas (10/8, 172.16/12, 192.168/16): con IP publica no se sondea internet.
  fun esPrivada(ip: String): Boolean {
    val n = ipANum(ip)
    if (n < 0) return false
    return (n shr 24) == 10L || (n shr 20) == ((172L shl 4) or 1L) || (n shr 16) == ((192L shl 8) or 168L)
  }

  // Hosts a sondear de varias interfaces (ip, largo del prefijo). Solo privadas, sin la propia, tope /24, maximo 4 redes.
  fun hostsDeSubredes(ifaces: List<Pair<String, Int>>): List<String> {
    val out = ArrayList<String>()
    val propias = HashSet<String>()
    val redes = LinkedHashSet<Long>()
    for ((ip, prefijoIn) in ifaces) {
      val n = ipANum(ip)
      if (n < 0 || !esPrivada(ip)) continue
      propias.add(ip)
      val prefijo = prefijoIn.coerceIn(24, 32)
      val mascara = (0xFFFFFFFFL shl (32 - prefijo)) and 0xFFFFFFFFL
      val red = n and mascara
      val difusion = red or (mascara.inv() and 0xFFFFFFFFL)
      if (red in redes || redes.size >= 4) continue
      redes.add(red)
      var h = red + 1
      while (h < difusion) { out.add(numAIp(h)); h++ }
    }
    return out.filter { it !in propias }
  }

  // [§8 · 4065864] La lista se reenvia completa al menos cada 20 min aunque no cambie: print_tomar solo deja
  // tomar un trabajo BT/USB sin dueno vivo al agente que la informo en los ultimos 30 min.
  const val INFORMAR_CADA_MS = 20 * 60000L

  // ¿Va `encontradas` en esta llamada? Forzado, md5 distinto o >= 20 min desde el ultimo envio.
  fun debeMandarLista(hayBusqueda: Boolean, forzar: Boolean, md5: String, md5Informado: String, informadoTs: Long, ahora: Long): Boolean =
    hayBusqueda && (forzar || md5 != md5Informado || ahora - informadoTs >= INFORMAR_CADA_MS)

  fun macValida(mac: String?): Boolean = mac != null && MAC.matches(mac)

  // Equipo USB: "vvvv:pppp" y, si se pudo leer, ":serie" (sin ":" ni espacios, hasta 60).
  fun refUsb(vid: Int, pid: Int, serie: String?): String {
    val base = String.format(java.util.Locale.US, "%04x:%04x", vid and 0xFFFF, pid and 0xFFFF)
    val s = serie?.filter { it.isLetterOrDigit() || it == '-' || it == '_' }?.take(60)
    return if (s.isNullOrBlank()) base else "$base:$s"
  }

  // ¿El equipo (vid, pid, serie leida o null) es el del usbId guardado? Coincide vid:pid; si lo
  // guardado trae serie y la del equipo se pudo leer, tambien la serie (dos impresoras iguales).
  fun coincideUsb(usbId: String, vid: Int, pid: Int, serie: String?): Boolean {
    val partes = usbId.trim().lowercase().split(":")
    if (partes.size < 2) return false
    val vp = String.format(java.util.Locale.US, "%04x:%04x", vid and 0xFFFF, pid and 0xFFFF)
    if (partes[0] + ":" + partes[1] != vp) return false
    if (partes.size < 3 || partes[2].isBlank()) return true
    val s = serie?.filter { it.isLetterOrDigit() || it == '-' || it == '_' }?.take(60)?.lowercase()
    return s.isNullOrBlank() || s == partes[2]
  }

  // md5 de la lista (orden estable): si no cambia, no se reenvia (salvo cada 30 min).
  fun md5Lista(lista: List<Encontrada>): String {
    val orden = lista.map { it.transporte + "|" + it.ref + "|" + it.nombre }.sorted().joinToString("\n")
    val d = java.security.MessageDigest.getInstance("MD5").digest(orden.toByteArray(Charsets.UTF_8))
    return d.joinToString("") { String.format(java.util.Locale.US, "%02x", it.toInt() and 0xff) }
  }

  fun listaJson(lista: List<Encontrada>): JSONArray {
    val a = JSONArray()
    for (e in lista.take(MAX_ENCONTRADAS)) a.put(e.json())
    return a
  }

  private fun txtONull(o: JSONObject, k: String): String? = if (!o.has(k) || o.isNull(k)) null else o.optString(k).trim().ifBlank { null }

  // destinos de <prefijo>_agente_impresoras -> mapa por estacion.
  fun parseDestinos(arr: JSONArray?): Map<String, Destino> {
    val m = LinkedHashMap<String, Destino>()
    if (arr == null) return m
    for (i in 0 until arr.length()) {
      val o = arr.optJSONObject(i) ?: continue
      val est = txtONull(o, "estacion") ?: continue
      m[est] = Destino(
        estacion = est, nombre = txtONull(o, "nombre") ?: "",
        transporte = (txtONull(o, "transporte") ?: "red").lowercase(),
        ip = txtONull(o, "ip"), puerto = if (o.isNull("puerto")) PUERTO_IMPRESORA else o.optInt("puerto", PUERTO_IMPRESORA),
        btMac = txtONull(o, "btMac")?.uppercase(), usbId = txtONull(o, "usbId"),
        impresoraNombre = txtONull(o, "impresoraNombre") ?: "",
        propio = if (o.has("propio") && !o.isNull("propio")) o.optBoolean("propio", true) else true
      )
    }
    return m
  }

  // Destino de una estacion: el de agente_impresoras si vino; si no, la IP de agente_config (como la 1.6).
  fun destinoDe(est: Estacion?, d: Destino?): Destino? {
    if (d != null) return d.copy(nombre = d.nombre.ifBlank { est?.nombre ?: "" })
    if (est == null) return null
    return Destino(est.id, est.nombre, "red", est.ip, est.puerto, null, null, "", true)
  }

  // Ref de red valida escrita a mano ("192.168.1.50" o "192.168.1.50:9100") -> (ip, puerto) o null.
  fun refRed(ref: String): Pair<String, Int>? {
    val partes = ref.trim().split(":")
    if (partes.size > 2) return null
    val n = ipANum(partes[0])
    if (n < 0) return null
    var puerto = PUERTO_IMPRESORA
    if (partes.size == 2) {
      puerto = partes[1].toIntOrNull() ?: return null
    }
    if (puerto !in 1..65535) return null
    return numAIp(n) to puerto
  }
}
