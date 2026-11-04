package dev.levo.levoprint

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

// [Re-QA LP-F3 · MEDIO 1] Aviso de actualizacion. El CI (build-apk con «publicar») sube junto al APK
// descargas/levoprint/LevoPrint.json = {versionCode, versionName, url, notas}. LevoPrint lo lee al abrir la
// pantalla y cada 12 h desde el servicio; si versionCode es mayor que el propio, avisa «Hay una versión
// nueva de LevoPrint (X): Actualizar», que abre la url del APK en el navegador (se instala por sideload).
// Nunca frena la impresion: red caida, JSON invalido o url rara = no hay aviso. Sin permisos nuevos (INTERNET ya esta).
object Actualizacion {
  const val URL_JSON = "https://krfljsososdakbatevci.supabase.co/storage/v1/object/public/descargas/levoprint/LevoPrint.json"

  data class Info(val versionCode: Int, val versionName: String, val url: String, val notas: String)

  // Info valida o null: versionCode entero > 0 y url https.
  fun parse(texto: String?): Info? {
    if (texto.isNullOrBlank()) return null
    return try {
      val o = JSONObject(texto)
      val vc = o.opt("versionCode")
      val codigo = when (vc) {
        is Int -> vc
        is Long -> if (vc in 1..Int.MAX_VALUE.toLong()) vc.toInt() else 0
        is String -> vc.trim().toIntOrNull() ?: 0
        else -> 0
      }
      val url = o.optString("url").trim()
      if (codigo <= 0 || !urlPermitida(url)) return null
      Info(codigo, o.optString("versionName").trim().take(20).ifBlank { codigo.toString() }, url,
        if (o.isNull("notas")) "" else o.optString("notas").trim().take(300))
    } catch (_: Exception) { null }
  }

  // [QA LP-F3 · MEDIO] Solo se abre una url de las descargas de LevoDev: https, sin usuario ni puerto, y
  // host + carpeta conocidos. Un JSON alterado no puede mandar al navegador a otro sitio.
  private val ORIGENES = listOf(
    "krfljsososdakbatevci.supabase.co" to "/storage/v1/object/public/descargas/levoprint/",
    "archivos.levodev.app" to "/descargas/levoprint/"
  )

  fun urlPermitida(url: String): Boolean = try {
    val u = java.net.URI(url)
    val host = (u.host ?: "").lowercase()
    val ruta = u.path ?: ""
    u.scheme.equals("https", ignoreCase = true) && u.rawUserInfo == null && u.port == -1 &&
      !ruta.contains("..") && ORIGENES.any { (h, p) -> host == h && ruta.startsWith(p) && ruta.length > p.length }
  } catch (_: Exception) { false }

  fun hayNueva(info: Info?, propio: Int = Agent.VERSION_CODE): Boolean = info != null && info.versionCode > propio

  @Volatile var ultima: Info? = null
    private set
  @Volatile private var ultimaConsulta = 0L

  // GET del JSON (bloquea: llamar desde un hilo de fondo). Con tope: no mas de una consulta cada `minimoMs`.
  fun consultar(minimoMs: Long = 0L): Info? {
    val ahora = System.currentTimeMillis()
    if (minimoMs > 0 && ahora - ultimaConsulta < minimoMs) return ultima
    ultimaConsulta = ahora
    val info = try {
      val con = URL(URL_JSON).openConnection() as HttpURLConnection
      con.connectTimeout = 8000
      con.readTimeout = 8000
      con.useCaches = false
      con.setRequestProperty("Cache-Control", "no-cache")
      try {
        if (con.responseCode !in 200..299) null
        else parse(con.inputStream.bufferedReader().use { r -> r.readText().take(10000) })
      } finally { con.disconnect() }
    } catch (_: Exception) { null }
    if (info != null) ultima = info
    return ultima
  }

  fun texto(info: Info): String = "Hay una versión nueva de LevoPrint (" + info.versionName + ")." +
    (if (info.notas.isNotBlank()) " " + info.notas else "")
}
