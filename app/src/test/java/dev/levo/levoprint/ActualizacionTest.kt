package dev.levo.levoprint

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// [Re-QA LP-F3 · MEDIO 1] Lectura de LevoPrint.json y comparacion con la version propia.
class ActualizacionTest {
  private val url = "https://krfljsososdakbatevci.supabase.co/storage/v1/object/public/descargas/levoprint/LevoPrint.apk"

  @Test fun jsonValido() {
    val i = Actualizacion.parse("""{"versionCode":13,"versionName":"1.8.0","url":"$url","notas":"Mejoras"}""")!!
    assertEquals(13, i.versionCode)
    assertEquals("1.8.0", i.versionName)
    assertEquals("Mejoras", i.notas)
    assertTrue(Actualizacion.hayNueva(i, 12))
    assertFalse(Actualizacion.hayNueva(i, 13))
    assertFalse(Actualizacion.hayNueva(i, 14))
  }

  @Test fun versionCodeComoTextoYSinNotas() {
    val i = Actualizacion.parse("""{"versionCode":"14","url":"$url","notas":null}""")!!
    assertEquals(14, i.versionCode)
    assertEquals("14", i.versionName)
    assertEquals("", i.notas)
  }

  @Test fun invalidosNoAvisan() {
    assertNull(Actualizacion.parse(null))
    assertNull(Actualizacion.parse(""))
    assertNull(Actualizacion.parse("<html>404</html>"))
    assertNull(Actualizacion.parse("""{"versionName":"1.8.0","url":"$url"}"""))
    assertNull(Actualizacion.parse("""{"versionCode":0,"url":"$url"}"""))
    assertNull(Actualizacion.parse("""{"versionCode":-3,"url":"$url"}"""))
    assertNull(Actualizacion.parse("""{"versionCode":13,"url":"http://inseguro/LevoPrint.apk"}"""))
    assertNull(Actualizacion.parse("""{"versionCode":13}"""))
    assertFalse(Actualizacion.hayNueva(null, 1))
  }

  @Test fun soloUrlsDeLasDescargasDeLevoDev() {
    assertTrue(Actualizacion.urlPermitida(url))
    assertTrue(Actualizacion.urlPermitida("https://archivos.levodev.app/descargas/levoprint/LevoPrint.apk"))
    assertFalse(Actualizacion.urlPermitida("https://evil.example/storage/v1/object/public/descargas/levoprint/LevoPrint.apk"))
    assertFalse(Actualizacion.urlPermitida("https://krfljsososdakbatevci.supabase.co/storage/v1/object/public/otra/LevoPrint.apk"))
    assertFalse(Actualizacion.urlPermitida("https://krfljsososdakbatevci.supabase.co.evil.example/storage/v1/object/public/descargas/levoprint/x.apk"))
    assertFalse(Actualizacion.urlPermitida("https://user@krfljsososdakbatevci.supabase.co/storage/v1/object/public/descargas/levoprint/x.apk"))
    assertFalse(Actualizacion.urlPermitida("https://archivos.levodev.app:8443/descargas/levoprint/x.apk"))
    assertFalse(Actualizacion.urlPermitida("https://archivos.levodev.app/descargas/levoprint/../../x.apk"))
    assertFalse(Actualizacion.urlPermitida("http://archivos.levodev.app/descargas/levoprint/x.apk"))
    assertFalse(Actualizacion.urlPermitida("https://archivos.levodev.app/descargas/levoprint/"))
    assertNull(Actualizacion.parse("""{"versionCode":13,"url":"https://evil.example/LevoPrint.apk"}"""))
  }

  @Test fun versionPropiaEsLaDelGradle() {
    assertEquals(12, Agent.VERSION_CODE)
  }
}
