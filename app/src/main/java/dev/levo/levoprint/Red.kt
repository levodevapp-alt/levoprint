package dev.levo.levoprint

import android.content.Context
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

// [F2] Reglas de red del servidor local (mismas que agente/lib/red.js):
// IP de origen privada, Host IP literal/localhost/.local (anti DNS
// rebinding), CORS solo https://*.levodev.app. Mas el barrido de la LAN.
object Red {
  fun limpiar(ip: String?): String = (ip ?: "").removePrefix("/").removePrefix("::ffff:").substringBefore('%')

  fun esIpv4(a: String) = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$").matchEntire(a)?.groupValues?.drop(1)?.all { it.toInt() <= 255 } == true

  fun esIpPrivada(addr: String?): Boolean {
    val a = limpiar(addr).lowercase()
    if (esIpv4(a)) {
      val p = a.split('.').map { it.toInt() }
      return p[0] == 10 || p[0] == 127 || (p[0] == 172 && p[1] in 16..31) || (p[0] == 192 && p[1] == 168) || (p[0] == 169 && p[1] == 254)
    }
    return a == "::1" || a == "0:0:0:0:0:0:0:1" || Regex("^fe[89ab][0-9a-f]:").containsMatchIn(a) || Regex("^f[cd][0-9a-f]{2}:").containsMatchIn(a)
  }

  fun hostPermitido(host: String?): Boolean {
    var h = (host ?: "").trim().lowercase()
    if (h.startsWith("[")) h = h.substring(1, h.indexOf(']').coerceAtLeast(1)) else h = h.replace(Regex(":\\d+$"), "")
    if (h.isBlank()) return false
    return h == "localhost" || h.endsWith(".local") || esIpv4(h) || h.contains(':')
  }

  private val ORIGEN_LEVO = Regex("^https://([a-z0-9-]+\\.)*levodev\\.app$")
  fun origenPermitido(origin: String?): Boolean = origin != null && ORIGEN_LEVO.matches(origin.trim().lowercase())

  fun ipsLocales(): List<String> = try {
    NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp && !it.isLoopback }
      .flatMap { it.inetAddresses.toList() }.filterIsInstance<Inet4Address>()
      .map { it.hostAddress ?: "" }.filter { esIpPrivada(it) && !it.startsWith("169.254.") }
  } catch (_: Exception) { emptyList() }

  // Barrido del /24 de cada IP local al puerto 9100 (200 ms por host, 48 a la vez).
  fun barrer(puerto: Int = 9100, timeoutMs: Int = 200): List<String> {
    val hosts = ipsLocales().flatMap { ip -> val b = ip.substringBeforeLast('.'); (1..254).map { "$b.$it" } }.distinct()
    if (hosts.isEmpty()) return emptyList()
    val pool = Executors.newFixedThreadPool(48)
    val hallados = java.util.Collections.synchronizedList(ArrayList<String>())
    for (h in hosts) pool.submit {
      try { Socket().use { s -> s.connect(InetSocketAddress(h, puerto), timeoutMs); hallados.add(h) } } catch (_: Exception) {}
    }
    pool.shutdown()
    pool.awaitTermination(20, TimeUnit.SECONDS)
    return hallados.sortedBy { it.substringAfterLast('.').toIntOrNull() ?: 0 }
  }
}

// [F2] Emparejamiento de equipos de la red con PIN (como agente/lib/emparejar.js):
// PIN de 6 digitos en la pantalla de LevoPrint (10 min, un uso); el equipo
// recibe un token propio; se guarda solo su sha256. Freno: 5 fallos por IP
// -> 60 s; 20 fallos en 10 min -> el PIN se anula.
object Emparejador {
  data class Equipo(val id: String, val nombre: String, val hash: String, val ip: String, val creado: Long)
  private const val P = "levoprint_equipos"
  private val azar = SecureRandom()
  @Volatile var pin: String? = null
  @Volatile var pinVence = 0L
  private var cerrado = false
  private val porIp = HashMap<String, Pair<Int, Long>>()
  private val fallos = ArrayList<Long>()

  private fun sha(t: String) = MessageDigest.getInstance("SHA-256").digest(t.toByteArray()).joinToString("") { "%02x".format(it) }

  @Synchronized fun nuevoPin(): String {
    val v = String.format(java.util.Locale.US, "%06d", azar.nextInt(1000000))
    pin = v; pinVence = System.currentTimeMillis() + 10 * 60000L; cerrado = false; fallos.clear()
    return v
  }

  @Synchronized fun pinVigente(): String? = if (!cerrado && pin != null && pinVence > System.currentTimeMillis()) pin else null

  fun equipos(ctx: Context): List<Equipo> {
    val arr = try { org.json.JSONArray(ctx.getSharedPreferences(P, Context.MODE_PRIVATE).getString("lista", "[]")) } catch (_: Exception) { org.json.JSONArray() }
    return (0 until arr.length()).map { val o = arr.getJSONObject(it); Equipo(o.optString("id"), o.optString("nombre"), o.optString("hash"), o.optString("ip"), o.optLong("creado")) }
  }

  private fun guardar(ctx: Context, l: List<Equipo>) {
    val arr = org.json.JSONArray()
    for (e in l) arr.put(org.json.JSONObject().put("id", e.id).put("nombre", e.nombre).put("hash", e.hash).put("ip", e.ip).put("creado", e.creado))
    ctx.getSharedPreferences(P, Context.MODE_PRIVATE).edit().putString("lista", arr.toString()).apply()
  }

  // Devuelve {ok, token} o {ok:false, error, mensaje}.
  @Synchronized fun intentar(ctx: Context, pinDado: String?, nombre: String?, ip: String): org.json.JSONObject {
    val ahora = System.currentTimeMillis()
    val reg = porIp[ip] ?: Pair(0, 0L)
    if (reg.second > ahora) return org.json.JSONObject().put("ok", false).put("error", "ESPERA").put("mensaje", "Demasiados intentos. Espera un minuto.")
    val v = pinVigente() ?: return org.json.JSONObject().put("ok", false).put("error", "SIN_PIN").put("mensaje", "Toca Emparejar un equipo en LevoPrint para ver un PIN nuevo.")
    val dado = (pinDado ?: "").filter { it.isDigit() }
    if (!MessageDigest.isEqual(dado.toByteArray(), v.toByteArray())) {
      val n = reg.first + 1
      porIp[ip] = if (n >= 5) Pair(0, ahora + 60000L) else Pair(n, 0L)
      fallos.removeAll { it < ahora - 10 * 60000L }; fallos.add(ahora)
      if (fallos.size >= 20) { cerrado = true; pin = null }
      return org.json.JSONObject().put("ok", false).put("error", "PIN_INVALIDO").put("mensaje", "PIN incorrecto o vencido. Revisa el que muestra LevoPrint.")
    }
    porIp.remove(ip); pin = null
    val b = ByteArray(24); azar.nextBytes(b)
    val token = android.util.Base64.encodeToString(b, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP)
    val idB = ByteArray(6); azar.nextBytes(idB)
    val eq = Equipo(idB.joinToString("") { "%02x".format(it) }, (nombre ?: "Equipo").filter { it.isLetterOrDigit() || it in " ._-" }.take(40).ifBlank { "Equipo" }, sha(token), ip, ahora)
    guardar(ctx, equipos(ctx) + eq)
    return org.json.JSONObject().put("ok", true).put("token", token).put("equipo", org.json.JSONObject().put("id", eq.id).put("nombre", eq.nombre))
  }

  fun validar(ctx: Context, token: String?): Equipo? {
    if (token == null || token.length < 20 || token.length > 100) return null
    val h = sha(token).toByteArray()
    return equipos(ctx).firstOrNull { MessageDigest.isEqual(h, it.hash.toByteArray()) }
  }

  fun quitar(ctx: Context, id: String) = guardar(ctx, equipos(ctx).filter { it.id != id })
}
