package dev.levo.levoprint

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// [LP-F3 · LP-F4] Logica pura de la busqueda y del destino por estacion (mismo criterio que el .exe 1.13).
class BusquedaLogicaTest {
  @Test fun subredPropiaSinLaPropiaNiLaDeDifusion() {
    val h = BusquedaLogica.hostsDeSubredes(listOf("192.168.1.37" to 24))
    assertEquals(253, h.size)
    assertEquals("192.168.1.1", h.first())
    assertEquals("192.168.1.254", h.last())
    assertFalse(h.contains("192.168.1.37"))
  }

  @Test fun mascaraAnchaSeRecortaASu24() {
    val h = BusquedaLogica.hostsDeSubredes(listOf("10.20.30.40" to 16))
    assertEquals(253, h.size)
    assertTrue(h.all { it.startsWith("10.20.30.") })
  }

  @Test fun sinApipaNiLoopbackYRedRepetidaUnaVez() {
    assertTrue(BusquedaLogica.hostsDeSubredes(listOf("169.254.10.2" to 16, "127.0.0.1" to 8)).isEmpty())
    // Dos direcciones de la misma red (Wi-Fi + cable): la /24 se recorre una vez y sin ninguna de las propias.
    val h = BusquedaLogica.hostsDeSubredes(listOf("192.168.1.5" to 24, "192.168.1.6" to 24))
    assertEquals(252, h.size)
    assertFalse(h.contains("192.168.1.5") || h.contains("192.168.1.6"))
  }

  @Test fun mascaraAngostaSoloSuRango() {
    val h = BusquedaLogica.hostsDeSubredes(listOf("192.168.1.130" to 26))
    assertEquals(61, h.size) // .129 a .190 sin la propia
    assertEquals("192.168.1.129", h.first())
  }

  @Test fun refUsbYCoincidencia() {
    assertEquals("0416:5011", BusquedaLogica.refUsb(0x0416, 0x5011, null))
    assertEquals("0416:5011:AB12", BusquedaLogica.refUsb(0x0416, 0x5011, "AB 12"))
    assertTrue(BusquedaLogica.coincideUsb("0416:5011", 0x0416, 0x5011, "XYZ"))
    assertTrue(BusquedaLogica.coincideUsb("0416:5011:AB12", 0x0416, 0x5011, null)) // sin permiso no se lee la serie
    assertTrue(BusquedaLogica.coincideUsb("0416:5011:ab12", 0x0416, 0x5011, "AB12"))
    assertFalse(BusquedaLogica.coincideUsb("0416:5011:AB12", 0x0416, 0x5011, "OTRA"))
    assertFalse(BusquedaLogica.coincideUsb("0416:5012", 0x0416, 0x5011, null))
  }

  @Test fun md5EstableSinImportarElOrden() {
    val a = Encontrada("red", "192.168.1.50:9100", "Impresora en 192.168.1.50")
    val b = Encontrada("usb", "0416:5011", "POS-80")
    assertEquals(BusquedaLogica.md5Lista(listOf(a, b)), BusquedaLogica.md5Lista(listOf(b, a)))
    assertNotEquals(BusquedaLogica.md5Lista(listOf(a)), BusquedaLogica.md5Lista(listOf(a, b)))
    assertEquals(32, BusquedaLogica.md5Lista(emptyList()).length)
  }

  @Test fun listaConTope() {
    val l = (1..80).map { Encontrada("red", "10.0.0.$it:9100", "x") }
    assertEquals(64, BusquedaLogica.listaJson(l).length())
  }

  @Test fun destinosDelServidor() {
    val arr = JSONArray()
      .put(JSONObject().put("estacion", "e1").put("nombre", "Cocina").put("transporte", "red").put("ip", "192.168.1.50").put("puerto", 9100).put("propio", true))
      .put(JSONObject().put("estacion", "e2").put("nombre", "Caja").put("transporte", "usb").put("ip", JSONObject.NULL).put("usbId", "0416:5011").put("propio", false))
      .put(JSONObject().put("estacion", "e3").put("transporte", "bluetooth").put("btMac", "aa:bb:cc:dd:ee:ff").put("propio", true))
    val m = BusquedaLogica.parseDestinos(arr)
    assertTrue(m["e1"]!!.imprimible)
    assertEquals("Red: 192.168.1.50:9100", m["e1"]!!.texto())
    assertFalse(m["e2"]!!.imprimible) // USB de otro equipo
    assertNull(m["e2"]!!.ip)
    assertTrue(m["e2"]!!.texto().startsWith("USB en otro equipo"))
    assertEquals("AA:BB:CC:DD:EE:FF", m["e3"]!!.btMac)
    assertTrue(m["e3"]!!.imprimible)
  }

  @Test fun sinDestinoUsaLaIpDeAgenteConfig() {
    val d = BusquedaLogica.destinoDe(Estacion("e1", "Cocina", "192.168.1.9", 9100), null)!!
    assertEquals("red", d.transporte)
    assertTrue(d.imprimible)
    assertFalse(BusquedaLogica.destinoDe(Estacion("e1", "Cocina", null, 9100), null)!!.imprimible)
    assertNull(BusquedaLogica.destinoDe(null, null))
  }

  @Test fun ipEscritaAMano() {
    assertEquals("192.168.1.50" to 9100, BusquedaLogica.refRed(" 192.168.1.50 "))
    assertEquals("192.168.1.50" to 9101, BusquedaLogica.refRed("192.168.1.50:9101"))
    assertNull(BusquedaLogica.refRed("192.168.1.500"))
    assertNull(BusquedaLogica.refRed("impresora"))
    assertNull(BusquedaLogica.refRed("192.168.1.5:0"))
    assertTrue(BusquedaLogica.macValida("AA:BB:CC:DD:EE:FF"))
    assertFalse(BusquedaLogica.macValida("AA:BB:CC:DD:EE"))
  }
}
