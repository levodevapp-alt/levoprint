package dev.levo.levoprint

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// [F2] Pruebas de unidad del diario anti-duplicado y de las reglas de red del
// servidor local (mismos casos que agente/test/unidades.test.js del .exe).
class DiarioRedTest {
  private fun archivo(): File = File.createTempFile("lp-diario", ".jsonl").also { it.delete(); it.deleteOnExit() }

  @Test fun diarioDedupePersistenciaYDudoso() {
    val f = archivo()
    val a = Diario(f)
    val k1 = Diario.claveDe("job-aaaa-1", "e1"); val k2 = Diario.claveDe("job-bbbb-2", "e1")
    a.poner(k1, e = "IMPRIMIENDO", o = "LAN", j = "job-aaaa-1", est = "e1")
    a.poner(k1, e = "IMPRESO")
    a.poner(k2, e = "IMPRIMIENDO", o = "LAN", j = "job-bbbb-2", est = "e1")   // se corta la luz
    f.appendText("{\"k\":\"roto\",")                                    // linea a medias
    val b = Diario(f)
    assertEquals("job-aaaa-1|e1", k1)
    assertEquals("IMPRESO", b.estado(k1))
    assertEquals("DUDOSO", b.estado(k2))
    assertEquals(listOf("job-aaaa-1" to "e1"), b.sinReportar().map { it.j to it.est })
    b.marcarReportados(b.sinReportar().map { it.k })
    assertTrue(Diario(f).sinReportar().isEmpty())
  }

  @Test fun claveYJobId() {
    assertEquals("abc-12345|e2", Diario.claveDeNube(JSONObject().put("id", 9).put("estacion", "e2").put("payload", JSONObject().put("jobId", "abc-12345"))))
    assertEquals("nube:9", Diario.jobIdDeNube(JSONObject().put("id", 9).put("payload", JSONObject())))
    assertTrue(Diario.jobIdValido("4f1c2b9e-1111-4222-8333-944455556666"))
    assertFalse(Diario.jobIdValido("corto"))
    assertFalse(Diario.jobIdValido("nube:12345678"))
    assertFalse(Diario.jobIdValido("con espacio 1"))
  }

  @Test fun reglasDeRed() {
    for (ip in listOf("192.168.1.5", "10.0.0.2", "172.16.3.4", "127.0.0.1", "::1", "::ffff:192.168.0.9", "fe80::1", "fd12::3", "/192.168.1.7"))
      assertTrue(ip, Red.esIpPrivada(ip))
    for (ip in listOf("8.8.8.8", "100.64.1.1", "172.32.0.1", "2800:200::1"))
      assertFalse(ip, Red.esIpPrivada(ip))
    assertTrue(Red.hostPermitido("192.168.1.20:9120"))
    assertTrue(Red.hostPermitido("localhost:9120"))
    assertTrue(Red.hostPermitido("caja.local"))
    assertFalse(Red.hostPermitido("evil.com:9120"))
    assertFalse(Red.hostPermitido(null))
    assertTrue(Red.origenPermitido("https://komo.levodev.app"))
    assertFalse(Red.origenPermitido("http://komo.levodev.app"))
    assertFalse(Red.origenPermitido("https://levodev.app.evil.com"))
    // [QA MEDIO-4] IP de impresora: privada, sin loopback ni link-local
    for (ip in listOf("192.168.1.5", "10.0.0.2", "172.16.3.4")) assertTrue(ip, Red.esIpImpresora(ip))
    for (ip in listOf("127.0.0.1", "169.254.1.1", "8.8.8.8", "192.168.1.300", "impresora.local")) assertFalse(ip, Red.esIpImpresora(ip))
    assertNull(null)
  }
}
