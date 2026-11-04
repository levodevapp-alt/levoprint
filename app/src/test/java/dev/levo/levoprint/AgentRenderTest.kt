package dev.levo.levoprint

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Render local del APK:
//  1) KOMO y KIPU: BYTE A BYTE igual que canje-v3 (copia congelada en
//     dev.levo.levoprint.original.Agent), en 4 anchos y con los sellos de
//     siempre (mismos casos que la comparacion del .exe, cmprender.mjs de QA).
//  2) KUTI: nota de venta (VENTA / ALQUILER DE SILLA, nota, quien atendio,
//     cliente, profesional por servicio, propinas aparte), COPIA y corte.
//  3) [O-23] KUTI: ticket del cliente sin cita (TURNO), definitivo y provisional.
class AgentRenderTest {
  private fun o(s: String) = JSONObject(s)
  // Payload + extras (las extras pisan claves del payload, como el spread del .exe).
  private fun m(s: String, extra: String): JSONObject {
    val a = o(s)
    if (extra.isNotEmpty()) { val e = o("{" + extra.substring(1) + "}"); for (k in e.keys()) a.put(k, e.get(k)) }
    return a
  }
  private fun job(tipo: String, pl: JSONObject) = JSONObject().put("tipo", tipo).put("payload", pl)

  // Texto impreso sin los comandos ESC/POS (ESC @, ESC a n, ESC E n, ESC ! n, GS ! n, GS V n).
  private fun texto(t: String) = t.replace(Regex("\u001b@|\u001b[aE!][\\s\\S]|\u001d[!V][\\s\\S]"), "")

  private val items = """[{"cantidad":2,"nombre":"Lomo saltado","precio":28.5},{"cantidad":0.5,"nombre":"Arroz extra largo nombre de plato de prueba","precio":10.01}]"""
  private val base = """"negocio":"Chifa X","hora":"13:05","fecha":"24/10/2026 13:05","items":$items,"total":62.01,"pagos":[{"medio":"Efectivo","monto":62.01}],"app":"KOMO","lema":"POS""""

  private fun casosKomoKipu(): List<JSONObject> {
    val r = ArrayList<JSONObject>()
    for (extra in listOf("", ""","reimpresion":true""", ""","atrasada":true,"hora":"12:00"""", ""","reimpresion":true,"atrasada":true""")) {
      r.add(job("TICKET", m("""{$base,"mesa":"5","mozo":"Ana"}""", extra)))
      r.add(job("TICKET", m("""{$base,"nota":"NV-1","vendedor":"Luis"}""", extra)))
      r.add(job("COMANDA", m("""{"mesa":"3","mozo":"Ana","items":$items,"hora":"12:30","ronda":2,"mensaje":"sin aji","nota":"rapido"}""", extra)))
      r.add(job("PRECUENTA", m("""{$base,"mesa":"3","cuenta":{"n":1,"de":2},"qr":"x"}""", extra)))
      r.add(job("CPE", m("""{"tipo":"BOLETA DE VENTA ELECTRONICA","serie":"B001","numero":7,"estado":"EMITIDO","empresa":{"razonSocial":"X SAC","ruc":"20123456789","direccion":"Av 1"},"cliente":{"nombre":"Juan","doc":"12345678","tipoDoc":"DNI"},"mesa":"4","mozo":"Ana","items":[{"cantidad":1,"nombre":"Lomo","total":28.5}],"totales":{"gravada":24.15,"igv":4.35},"total":28.5,"pagos":[{"medio":"Efectivo","monto":28.5}],"qr":"a|b","hash":"abcdefghijklmnopqrstuvwxyz0123456789"}""", extra)))
      r.add(job("CARTA_QR", m("""{"titulo":"Carta","url":"https://x.y/z"}""", extra)))
      r.add(job("PRUEBA", m("""{"x":1}""", extra)))
      r.add(job("CIERRE", m("""{"caja":"x","total":5,"items":$items}""", extra)))
      r.add(job("OTRO", m("""{"items":$items}""", extra)))
    }
    return r
  }

  @Test fun komoYKipuByteAByteIgualQueCanjeV3() {
    var n = 0
    for (ancho in listOf(32, 42, 48, 64)) for (j in casosKomoKipu()) {
      n++
      // [MM3-01] bajo 36 columnas el pie de marca va en su forma corta; la copia congelada solo
      // tiene la larga, asi que se cambia ahi antes de comparar (el resto, byte a byte).
      val orig = dev.levo.levoprint.original.Agent.render(j, ancho).let {
        if (ancho >= 36) it else it.replace(Agent.pieTexto("KOMO", 48), Agent.pieTexto("KOMO", ancho))
      }
      assertEquals("difiere ${j.optString("tipo")} ancho $ancho", orig, Agent.render(j, ancho, "KOMO"))
    }
    assertEquals(144, n)
  }

  private val kuti = """{"app":"KUTI","lema":"Turnos y caja para barberias y salones","ticket":"t","refTipo":"DIRECTO","nota":"NV01-00000042","negocio":"Barbería Demo","local":null,"hora":"18:30","fecha":"24/10/2026 18:30","vendedor":"Jorge, Luis","cliente":null,"items":[{"cantidad":1.000,"nombre":"Perfilado","precio":13.00,"profesional":"Jorge"},{"cantidad":2.000,"nombre":"Ceja","precio":10.01,"profesional":"Luis"},{"cantidad":1,"nombre":"Descuento","precio":-5.01}],"total":28.01,"pagos":[{"medio":"Efectivo","monto":28.01}],"propinas":[{"profesional":"Luis","medio":"Yape","monto":5.00}],"propinaTotal":5.00}"""

  @Test fun kutiNotaDeVenta() {
    for (ancho in listOf(32, 48)) {
      val t = texto(Agent.render(job("TICKET", o(kuti)), ancho))
      assertTrue(t, t.contains("BARBERÍA DEMO") && t.contains("VENTA") && t.contains("Nota: NV01-00000042"))
      assertTrue(t, t.contains("Atendio: Jorge, Luis") && !t.contains("Cliente:") && !t.contains("MESA") && !t.contains("Mozo") && !t.contains("null"))
      assertTrue(t, t.contains("1 Perfilado") && t.contains("   - Jorge") && t.contains("   - Luis") && t.contains("S/ -5.01") && t.contains("S/ 20.02"))
      assertTrue(t, t.contains("S/ 28.01") && t.contains("PROPINAS (aparte, no suman al total)") && t.contains("Luis (Yape)") && t.contains("S/ 5.00"))
      assertFalse(t, t.contains("COPIA"))
    }
  }

  @Test fun kutiAlquilerCopiaYCorte() {
    val alq = o(kuti).put("refTipo", "ALQUILER").put("vendedor", JSONObject.NULL).put("cliente", "Ana").put("propinas", JSONArray())
    val t = texto(Agent.render(job("TICKET", alq), 48))
    assertTrue(t, t.contains("ALQUILER DE SILLA") && t.contains("Cliente: Ana") && !t.contains("Atendio") && !t.contains("PROPINAS") && !t.contains("null"))
    val c = texto(Agent.render(job("TICKET", o(kuti).put("copia", true).put("reimpresion", true)), 48))
    assertTrue(c, c.startsWith("*** COPIA ***") && c.contains("NV01-00000042"))
    val k = texto(Agent.render(job("CIERRE", o("""{"negocio":"Barbería Demo","lineas":[{"izq":"Ventas (3)","der":"S/ 105.00","negrita":true},{"sep":"-"},{"izq":"Diferencia","der":"S/ -0.50"}]}""")), 32))
    assertTrue(k, k.contains("CORTE DE CAJA") && k.contains("Ventas (3)") && k.contains("S/ -0.50") && k.contains("-".repeat(32)))
  }

  // [MM3-01] Pie de marca: el nombre sale de la configuracion del local (prefijo), si no del payload.
  @Test fun pieDeMarcaPorApp() {
    // [QA MM3 M1] ASCII puro: ningun byte > 0x7F en el pie
    // [MM4-10 · P4] Una sola direccion con gancho; bajo 36 columnas la direccion baja a su linea.
    assertEquals("Sistema KUTI - LevoDev\nTu negocio tambien: kuti.levodev.app\n", Agent.pieTexto("kuti"))
    assertEquals("Sistema KIPU - LevoDev\nTu negocio tambien: kipu.levodev.app\n", Agent.pieTexto("KIPU"))
    assertEquals("LevoDev - levodev.app\n", Agent.pieTexto("otra"))
    assertEquals("Sistema KOMO - LevoDev\nTu negocio tambien:\nkomo.levodev.app\n", Agent.pieTexto("komo", 32))
    for (an in listOf(32, 42, 48, 64)) for (l in Agent.pieTexto("kipu", an).split("\n")) assertTrue(l, l.length <= an)
    for (ap in listOf("komo", "kipu", "kuti", "x")) for (an in listOf(32, 48)) assertTrue(Agent.pieTexto(ap, an).all { it.code < 128 })
    val t = Agent.render(job("PRUEBA", o("""{"x":1}""")), 32, "kipu")
    assertTrue(t, t.contains("Sistema KIPU") && t.contains("kipu.levodev.app") && !t.contains("Paracas"))
    val p = Agent.render(job("PRUEBA", o("""{"app":"KUTI"}""")), 32)
    assertTrue(p, p.contains("Sistema KUTI"))
  }

  // [MM4-09 · P6] La comanda sale sin pie de marca: termina en la linea "=" y el corte.
  @Test fun comandaSinPie() {
    for (ancho in listOf(32, 48)) {
      val t = Agent.render(job("COMANDA", o("""{"mesa":"3","mozo":"Ana","items":$items,"lema":"POS"}""")), ancho, "komo")
      assertFalse(t, t.contains("Sistema ") || t.contains("levodev.app"))
      assertTrue(t, t.endsWith("=".repeat(ancho) + "\n\n\n\n" + 29.toChar() + "V" + 0.toChar()))
    }
  }

  // [O-23] Ticket del cliente sin cita de KUTI (TURNO): mismo papel que kuti-print (prueba_render.mjs).
  private val turnoDef = """{"app":"KUTI","negocio":"Barbería Demo","local":"Sede Centro","definitivo":true,"numero":15,"provisional":"","nombre":"Carlos P.","con":"Jorge","fecha":"04/11/2026 10:05","delante":2}"""

  @Test fun kutiTurnoDefinitivo() {
    for (ancho in listOf(32, 48)) {
      val crudo = Agent.render(job("TURNO", o(turnoDef)), ancho, "kuti")
      val t = texto(crudo)
      assertTrue(t, t.contains("BARBERÍA DEMO") && t.contains("Sede Centro") && t.contains("TURNO SIN CITA") && t.contains("Tu numero\n15\n"))
      // triple alto (GS ! 0x22) para el numero
      assertTrue(crudo, crudo.contains(29.toChar() + "!" + 34.toChar() + "15\n"))
      assertTrue(t, t.contains("Carlos P.\nCon Jorge\n04/11/2026 10:05\n") && t.contains("Hay 2 personas delante.") && !t.contains("null") && !t.contains("COPIA"))
      assertTrue(t, t.contains("Sistema KUTI - LevoDev") && t.contains("kuti.levodev.app"))
      // ninguna linea pasa del ancho (salvo el nombre del negocio en doble ancho) y lo fijo es ASCII puro
      assertTrue(t, t.split("\n").filter { !it.startsWith("BARBER") }.all { it.length <= ancho })
      val fijo = t.substring(t.indexOf("TURNO SIN CITA")).replace("Carlos P.", "").replace("Jorge", "")
      assertTrue(fijo, fijo.all { it.code < 128 })
    }
    val cero = texto(Agent.render(job("TURNO", o(turnoDef).put("delante", 0)), 48, "kuti"))
    assertTrue(cero, cero.contains("Es el siguiente en la cola."))
    val uno = texto(Agent.render(job("TURNO", o(turnoDef).put("delante", 1)), 48, "kuti"))
    assertTrue(uno, uno.contains("Hay 1 persona delante."))
    val raro = texto(Agent.render(job("TURNO", o(turnoDef).put("delante", "x")), 48, "kuti"))
    assertTrue(raro, !raro.contains("siguiente") && !raro.contains("delante."))
  }

  @Test fun kutiTurnoProvisionalYCopia() {
    val prov = o(turnoDef).put("definitivo", false).put("numero", "A-07").put("provisional", "A-07").put("nombre", "").put("con", JSONObject.NULL).put("delante", JSONObject.NULL)
    for (ancho in listOf(32, 48)) {
      val t = texto(Agent.render(job("TURNO", prov), ancho, "kuti"))
      val u = t.replace("\n", " ")
      assertTrue(t, t.contains("Tu numero provisional\nA-07\n") && u.contains("se tomo sin internet") && t.contains("\n15 - A-07 (el 15 es un ejemplo)\n"))
      assertTrue(t, u.contains("No pierdes tu lugar") && !t.contains("Con ") && !t.contains("delante") && !t.contains("null"))
      assertTrue(t, t.split("\n").filter { !it.startsWith("BARBER") }.all { it.length <= ancho })
    }
    val c = texto(Agent.render(job("TURNO", o(turnoDef).put("copia", true)), 48, "kuti"))
    assertTrue(c, c.startsWith("*** COPIA ***") && c.contains("TURNO SIN CITA"))
    // el numero grande solo lleva ASCII visible y cabe en triple (32 columnas -> 10)
    val largo = texto(Agent.render(job("TURNO", prov.put("provisional", "ZZZZ-9999·xx")), 32, "kuti"))
    assertTrue(largo, largo.contains("\nZZZZ-9999x\n"))
  }

  @Test fun envolverPorPalabra() {
    assertEquals(listOf("hola que", "tal"), Agent.envolver("hola  que tal", 8))
    assertEquals(listOf("abcdefgh", "ij x"), Agent.envolver("abcdefghij x", 8))
    assertEquals(emptyList<String>(), Agent.envolver("   ", 8))
  }

  // [MM4-06] Papel al vincular: titulo, estacion y negocio en lineas aparte (sin el punto medio), hora y pie.
  @Test fun papelVinculado() {
    for (ancho in listOf(32, 48)) {
      val t = texto(Agent.renderVinculado("Cocina · Pollería Doña Ana", "03/11/2026 21:05", ancho, "komo"))
      assertTrue(t, t.contains("LevoPrint\nVINCULADO\n") && t.contains("Cocina\nPollería Doña Ana\n") && t.contains("03/11/2026 21:05"))
      assertTrue(t, !t.contains("·") && t.contains("Tu negocio tambien:") && t.contains("komo.levodev.app"))
      assertTrue(t, t.split("\n").all { it.length <= ancho })
    }
  }
}
