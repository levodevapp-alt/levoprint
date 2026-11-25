package dev.levo.levoprint

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.MessageDigest

// [RCA · 25-nov] El APK dibuja IGUAL que la Edge <prefijo>-print: render_comun/fixtures.json trae los papeles que dan
// HOY las Edges vivas (90, de levodev-modules core/print/fixtures) y los propios del render común (QA LP-U1R), con sus
// bytes esperados. Se comparan BYTE A BYTE:
//   1) RenderComun directo (payload leido con JsonOrdenado: mismo orden de claves que JSON.parse de JS);
//   2) Agent.render, el camino real del APK (JSONObject de org.json → desdeOrgJson → RenderComun), salvo el tipo
//      desconocido (su papel es JSON.stringify del payload y el org.json de las pruebas no conserva el orden de las
//      claves; el de Android si) y los anchos que no son enteros (el APK siempre manda un Int).
// Y el hash: RenderComun.RENDER_SHA256 = sha256 (LF) de render_comun/render.mjs = render_comun/ORIGEN.json.
class RenderComunFixturesTest {
  private fun archivo(rel: String): File =
    listOf(File("../$rel"), File(rel)).firstOrNull { it.exists() } ?: throw AssertionError("no se encontro $rel (cwd " + File(".").absolutePath + ")")
  private fun hex(b: ByteArray) = b.joinToString("") { String.format("%02x", it.toInt() and 0xff) }
  private fun sha256(s: String) = hex(MessageDigest.getInstance("SHA-256").digest(s.replace("\r\n", "\n").toByteArray(Charsets.UTF_8)))

  @Suppress("UNCHECKED_CAST")
  private val fixtures: List<Map<String, Any?>> by lazy { JsonOrdenado.parse(archivo("render_comun/fixtures.json").readText(Charsets.UTF_8)) as List<Map<String, Any?>> }

  @Test fun hashDelRenderComun() {
    val origen = JsonOrdenado.parse(archivo("render_comun/ORIGEN.json").readText(Charsets.UTF_8)) as Map<*, *>
    val s = sha256(archivo("render_comun/render.mjs").readText(Charsets.UTF_8))
    assertEquals("render_comun/render.mjs = ORIGEN.json", origen["sha256_render"], s)
    assertEquals("RenderComun.kt esta portado de OTRO render.mjs: revisar el port contra el nuevo y actualizar RENDER_SHA256", s, RenderComun.RENDER_SHA256)
    assertEquals("fixtures.json = ORIGEN.json", origen["sha256_fixtures"], sha256(archivo("render_comun/fixtures.json").readText(Charsets.UTF_8)))
  }

  @Test fun fixturesByteAByteConRenderComun() {
    val por = LinkedHashMap<String, IntArray>()
    val malos = ArrayList<String>()
    for (x in fixtures) {
      val got = hex(RenderComun(x["app"] as String).renderBytes(x["tipo"], x["payload"], x["ancho"], x["imagen"]))
      val g = por.getOrPut(x["grupo"] as String) { IntArray(2) }
      g[1]++
      if (got == x["hex"]) g[0]++ else malos.add(x["f"] as String)
    }
    println("RESUMEN fixtures APK (RenderComun): " + por.entries.joinToString(", ") { it.key + " " + it.value[0] + "/" + it.value[1] })
    assertTrue("faltan fixtures de las Edges vivas", (por["edges_vivas"]?.get(1) ?: 0) >= 90)
    assertEquals("fixtures distintos: $malos", emptyList<String>(), malos)
  }

  @Test fun fixturesPorElCaminoRealDelApk() {
    var n = 0
    val malos = ArrayList<String>()
    for (x in fixtures) {
      val ancho = x["ancho"]
      if (x["tipo"] == "OTRO" || x["tipo"] !is String || ancho !is Double || ancho % 1.0 != 0.0 || x["imagen"] !is Boolean) continue
      val pl = JSONObject(Js.stringify(x["payload"], "") ?: "{}")
      val job = JSONObject().put("tipo", x["tipo"]).put("payload", pl)
      val got = hex(Agent.bytes(Agent.render(job, ancho.toInt(), x["app"] as String, x["imagen"] as Boolean)))
      n++
      if (got != x["hex"]) malos.add(x["f"] as String)
    }
    println("RESUMEN fixtures APK (Agent.render + org.json): " + (n - malos.size) + "/" + n)
    assertTrue(n >= 80)
    assertEquals("fixtures distintos: $malos", emptyList<String>(), malos)
  }

  // Lo que pidio QA (MEDIO-1) en el CPE del APK, explicito ademas de los bytes: «SON: … SOLES» con la misma conversion.
  @Test fun cpeMontoEnLetras() {
    val casos = mapOf(
      43.5 to "CUARENTA Y TRES CON 50/100 SOLES", 1.0 to "UNO CON 00/100 SOLES", 100.0 to "CIEN CON 00/100 SOLES",
      121.21 to "CIENTO VEINTIUNO CON 21/100 SOLES", 1000.0 to "MIL CON 00/100 SOLES", 2500000.99 to "DOS MILLONES QUINIENTOS MIL CON 99/100 SOLES",
      0.1 to "CERO CON 10/100 SOLES", 29.2 to "VEINTINUEVE CON 20/100 SOLES", 1000001.0 to "UN MILLON UNO CON 00/100 SOLES"
    )
    for (app in listOf("KOMO", "KIPU", "KUTI", "KAMA", "KAWA")) for ((total, letras) in casos) {
      val pl = linkedMapOf<String, Any?>("tipo" to "BOLETA", "serie" to "B001", "numero" to 1.0, "items" to emptyList<Any?>(), "totales" to linkedMapOf("gravada" to total), "total" to total)
      val t = RenderComun(app).render("CPE", pl, 48.0, false)
      // va justo después del TOTAL, en su renglón (ESC a 0 = vuelve a la izquierda)
      assertTrue("$app $total: $t", t.contains("\u001ba\u0000SON: $letras\n"))
    }
  }
}
