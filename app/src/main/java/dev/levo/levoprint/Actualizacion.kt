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
      if (codigo <= 0 || !url.startsWith("https://")) return null
      Info(codigo, o.optString("versionName").trim().take(20).ifBlank { codigo.toString() }, url,
        if (o.isNull("notas")) "" else o.optString("notas").trim().take(300))
    } catch (_: Exception) { null }
  }

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
