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

  // [QA F2 MEDIO-4] IPv4 donde puede haber una impresora: red privada del
  // local, SIN loopback (127/8) ni link-local (169.254/16). Misma regla que
  // el .exe (transportes.ipImpresoraValida) y la base (_il_ip_privada).
  fun esIpImpresora(ip: String?): Boolean {
    val a = limpiar(ip)
    if (!esIpv4(a)) return false
    val p = a.split('.').map { it.toInt() }
    return p[0] == 10 || (p[0] == 172 && p[1] in 16..31) || (p[0] == 192 && p[1] == 168)
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
// recibe un token propio; se guarda solo su sha256.
// [QA F2 MEDIO-6] El token vence a los 90 dias sin uso; cada uso lo renueva.
// [QA F2 BAJO] Freno: 5 fallos por IP -> 60 s; tope global de 30 fallos por
// minuto que FRENA pero no anula el PIN (antes cualquiera de la red podia
// impedir emparejar); mapa de IPs con tope de 1000; al cargar se descartan
// entradas cuyo hash no es un sha256.
object Emparejador {
  data class Equipo(val id: String, val nombre: String, val hash: String, val ip: String, val creado: Long, val visto: Long, val vence: Long)
  private const val P = "levoprint_equipos"
  private const val VIDA_MS = 90L * 86400000L
  private val azar = SecureRandom()
  @Volatile var pin: String? = null
  @Volatile var pinVence = 0L
  private var fallosPin = 0      // [re-QA F2] 150 fallos acumulados contra el mismo PIN lo anulan
  private val porIp = LinkedHashMap<String, Pair<Int, Long>>()
  private val fallos = ArrayList<Long>()

  private fun sha(t: String) = MessageDigest.getInstance("SHA-256").digest(t.toByteArray()).joinToString("") { "%02x".format(it) }

  @Synchronized fun nuevoPin(): String {
    val v = String.format(java.util.Locale.US, "%06d", azar.nextInt(1000000))
    pin = v; pinVence = System.currentTimeMillis() + 10 * 60000L; fallosPin = 0
    return v
  }

  @Synchronized fun pinVigente(): String? = if (pin != null && pinVence > System.currentTimeMillis()) pin else null

  @Synchronized fun equipos(ctx: Context): List<Equipo> {
    val arr = try { org.json.JSONArray(ctx.getSharedPreferences(P, Context.MODE_PRIVATE).getString("lista", "[]")) } catch (_: Exception) { org.json.JSONArray() }
    val ahora = System.currentTimeMillis()
    val todos = (0 until arr.length()).map {
      val o = arr.getJSONObject(it)
      val visto = o.optLong("visto", o.optLong("creado"))
      Equipo(o.optString("id"), o.optString("nombre"), o.optString("hash"), o.optString("ip"), o.optLong("creado"), visto, o.optLong("vence", visto + VIDA_MS))
    }
    val validos = todos.filter { Regex("^[0-9a-f]{64}$").matches(it.hash) && it.id.isNotBlank() && it.vence > ahora }
    if (validos.size != todos.size) guardar(ctx, validos)
    return validos
  }

  private fun guardar(ctx: Context, l: List<Equipo>) {
    val arr = org.json.JSONArray()
    for (e in l) arr.put(org.json.JSONObject().put("id", e.id).put("nombre", e.nombre).put("hash", e.hash).put("ip", e.ip)
      .put("creado", e.creado).put("visto", e.visto).put("vence", e.vence))
    ctx.getSharedPreferences(P, Context.MODE_PRIVATE).edit().putString("lista", arr.toString()).apply()
  }

  // Devuelve {ok, token} o {ok:false, error, mensaje}.
  @Synchronized fun intentar(ctx: Context, pinDado: String?, nombre: String?, ip: String): org.json.JSONObject {
    val ahora = System.currentTimeMillis()
    fallos.removeAll { it < ahora - 60000L }
    if (fallos.size >= 30) return org.json.JSONObject().put("ok", false).put("error", "ESPERA").put("mensaje", "Demasiados intentos en la red. Espera un minuto.")
    val reg = porIp[ip] ?: Pair(0, 0L)
    if (reg.second > ahora) return org.json.JSONObject().put("ok", false).put("error", "ESPERA").put("mensaje", "Demasiados intentos. Espera un minuto.")
    val v = pinVigente() ?: return org.json.JSONObject().put("ok", false).put("error", "SIN_PIN").put("mensaje", "Toca Activar impresion sin internet en LevoPrint para ver un PIN nuevo.")
    val dado = (pinDado ?: "").filter { it.isDigit() }
    if (!MessageDigest.isEqual(dado.toByteArray(), v.toByteArray())) {
      val n = reg.first + 1
      if (!porIp.containsKey(ip) && porIp.size >= 1000) {
        porIp.entries.removeIf { it.value.second <= ahora }
        if (porIp.size >= 1000) porIp.remove(porIp.keys.first())
      }
      porIp[ip] = if (n >= 5) Pair(0, ahora + 60000L) else Pair(n, 0L)
      fallos.add(ahora)
      if (++fallosPin >= 150) {
        pin = null
        return org.json.JSONObject().put("ok", false).put("error", "SIN_PIN").put("mensaje", "Demasiados intentos: el PIN se anulo. Toca Activar impresion sin internet para ver otro.")
      }
      return org.json.JSONObject().put("ok", false).put("error", "PIN_INVALIDO").put("mensaje", "PIN incorrecto o vencido. Revisa el que muestra LevoPrint.")
    }
    porIp.remove(ip); pin = null
    val b = ByteArray(24); azar.nextBytes(b)
    val token = android.util.Base64.encodeToString(b, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP)
    val idB = ByteArray(6); azar.nextBytes(idB)
    val eq = Equipo(idB.joinToString("") { "%02x".format(it) }, (nombre ?: "Equipo").filter { it.isLetterOrDigit() || it in " ._-" }.take(40).ifBlank { "Equipo" },
      sha(token), ip, ahora, ahora, ahora + VIDA_MS)
    guardar(ctx, equipos(ctx) + eq)
    return org.json.JSONObject().put("ok", true).put("token", token).put("equipo", org.json.JSONObject().put("id", eq.id).put("nombre", eq.nombre)).put("venceDias", 90)
  }

  // Token valido y vigente; el uso lo renueva (se guarda como mucho una vez por minuto).
  @Synchronized fun validar(ctx: Context, token: String?): Equipo? {
    if (token == null || token.length < 20 || token.length > 100) return null
    val h = sha(token).toByteArray()
    val lista = equipos(ctx)
    val e = lista.firstOrNull { MessageDigest.isEqual(h, it.hash.toByteArray()) } ?: return null
    val ahora = System.currentTimeMillis()
    if (ahora - e.visto > 60000L) guardar(ctx, lista.map { if (it.id == e.id) it.copy(visto = ahora, vence = ahora + VIDA_MS) else it })
    return e
  }

  @Synchronized fun quitar(ctx: Context, id: String) = guardar(ctx, equipos(ctx).filter { it.id != id })
}
