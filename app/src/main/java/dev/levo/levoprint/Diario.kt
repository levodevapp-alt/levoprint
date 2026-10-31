package dev.levo.levoprint

import org.json.JSONObject
import java.io.File

// [F2] Diario local de trabajos: el mismo jobId nunca sale dos veces, venga
// por la red del local (ServidorLocal) o, al volver internet, desde la nube.
// Mismo contrato que agente/lib/diario.js del .exe:
//   IMPRIMIENDO (se escribe ANTES de mandar bytes) -> IMPRESO | ERROR.
//   Lo que quedo IMPRIMIENDO al morir la app pasa a DUDOSO: si vuelve a
//   llegar sale con sello REIMPRESION (cocina no lo toma por pedido nuevo).
// Archivo JSONL en filesDir; retencion 7 dias; se compacta al abrir.
// "r" = ya reportado a la nube (<p>_agente_lan).
class Diario(private val archivo: File) {
  data class Entrada(val k: String, var e: String, var o: String?, var est: String?, var t: String?, var via: String?, var r: Boolean, var ts: Long)

  private val mapa = LinkedHashMap<String, Entrada>()
  private val retencionMs = 7L * 86400000L

  init { cargar() }

  @Synchronized private fun cargar() {
    mapa.clear()
    if (archivo.exists()) {
      try {
        archivo.forEachLine { l ->
          if (l.isBlank()) return@forEachLine
          val j = try { JSONObject(l) } catch (_: Exception) { return@forEachLine } // linea cortada
          val k = j.optString("k"); if (k.isBlank()) return@forEachLine
          val prev = mapa[k]
          mapa[k] = Entrada(k,
            j.optString("e", prev?.e ?: "ERROR"),
            if (j.has("o")) j.optString("o") else prev?.o,
            if (j.has("est")) j.optString("est") else prev?.est,
            if (j.has("t")) j.optString("t") else prev?.t,
            if (j.has("via")) j.optString("via") else prev?.via,
            j.optBoolean("r", prev?.r ?: false),
            j.optLong("ts", System.currentTimeMillis()))
        }
      } catch (_: Exception) {}
    }
    for (e in mapa.values) if (e.e == "IMPRIMIENDO") e.e = "DUDOSO"
    compactar()
  }

  @Synchronized private fun compactar() {
    val limite = System.currentTimeMillis() - retencionMs
    mapa.entries.removeIf { it.value.ts < limite }
    try {
      val tmp = File(archivo.path + ".tmp")
      tmp.writeText(mapa.values.joinToString("") { json(it).toString() + "\n" })
      // Files.move reemplaza el archivo viejo (renameTo no lo hace en todos los sistemas).
      java.nio.file.Files.move(tmp.toPath(), archivo.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING)
    } catch (_: Exception) {}
  }

  private fun json(e: Entrada) = JSONObject().put("k", e.k).put("e", e.e).put("o", e.o).put("est", e.est)
    .put("t", e.t).put("via", e.via).put("r", e.r).put("ts", e.ts)

  @Synchronized fun estado(k: String): String? = mapa[k]?.e

  @Synchronized fun poner(k: String, e: String? = null, o: String? = null, est: String? = null, t: String? = null, via: String? = null, r: Boolean? = null) {
    val x = mapa[k] ?: Entrada(k, e ?: "ERROR", o, est, t, via, false, 0L)
    if (e != null) x.e = e
    if (o != null) x.o = o
    if (est != null) x.est = est
    if (t != null) x.t = t
    if (via != null) x.via = via
    if (r != null) x.r = r
    x.ts = System.currentTimeMillis()
    mapa[k] = x
    try {
      archivo.appendText(json(x).toString() + "\n")
      if (archivo.length() > 2L * 1024 * 1024) compactar()
    } catch (_: Exception) {}
  }

  // Impresos por la LAN que la nube aun no sabe.
  @Synchronized fun sinReportar(max: Int = 200): List<Entrada> =
    mapa.values.filter { it.e == "IMPRESO" && it.o == "LAN" && !it.r && !it.k.startsWith("nube:") }.take(max)

  @Synchronized fun marcarReportados(claves: List<String>) { for (k in claves) if (mapa[k]?.r == false) poner(k, r = true) }

  @Synchronized fun recientes(n: Int = 50): List<Entrada> = mapa.values.sortedByDescending { it.ts }.take(n)

  companion object {
    // Clave de dedupe de un trabajo de la nube: payload.jobId (lo pone el cliente).
    fun claveDeNube(job: JSONObject): String {
      val c = job.optString("clave").ifBlank { job.optJSONObject("payload")?.optString("jobId") ?: "" }.trim()
      return if (c.isNotBlank()) c.take(80) else "nube:" + job.optString("id")
    }
    fun jobIdValido(id: String?): Boolean = id != null && Regex("^[A-Za-z0-9:_\\-.]{8,80}$").matches(id) && !id.startsWith("nube:")
  }
}
