package dev.levo.levoprint

import org.json.JSONArray
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// [D8 · NUC-COM7 · 27-nov] Registro de apps del servidor (public.levoprint_apps): una app nueva entra sin publicar otro
// APK; la fabrica (K, P, T) no se pisa; filas raras no entran; nombres y consola salen del registro.
class ProyectosTest {
  private val registro = """[
    {"letra":"K","prefijo":"komo","nombre":"KOMO","seccion":"Estaciones","activa":true},
    {"letra":"W","prefijo":"kawa","nombre":"KAWA","seccion":"Impresoras","activa":false},
    {"letra":"A","prefijo":"kama","nombre":"KAMA","seccion":null,"activa":true},
    {"letra":"K","prefijo":"pirata","nombre":"PIRATA","seccion":"Impresoras"},
    {"letra":"Q","prefijo":"komo","nombre":"OTRA","seccion":"Impresoras"},
    {"letra":"Z","prefijo":"raro","nombre":"<b>RARO</b>","seccion":"Impresoras"},
    {"letra":"zz","prefijo":"mal","nombre":"MAL"},
    {"letra":"V","prefijo":"Mal-Pfx","nombre":"MAL"},
    {"letra":"W","prefijo":"kawa2","nombre":"KAWA DOS"}
  ]"""

  @After fun limpiar() { Proyectos.aplicar(emptyList()) }

  @Test fun desdeRegistroSoloFilasValidasYSinPisarLaFabrica() {
    val l = Proyectos.desdeRegistro(JSONArray(registro))
    assertEquals(listOf("W:kawa:KAWA:Impresoras", "A:kama:KAMA:"), l.map { it.letra + ":" + it.prefijo + ":" + it.nombre + ":" + it.seccion })
  }

  @Test fun unaAppNuevaSeConoceSinPublicarOtroApk() {
    assertNull(Proyectos.porLetra("W"))
    Proyectos.aplicar(Proyectos.desdeRegistro(JSONArray(registro)))
    assertEquals("kawa", Proyectos.porLetra("W")?.prefijo)
    assertEquals("komo", Proyectos.porLetra("K")?.prefijo)
    assertEquals("KAWA", Emparejamiento.nombreApp("w"))
    assertEquals("tu consola de KAWA › Impresoras", Emparejamiento.consolaDe("kawa"))
    assertEquals("tu consola de KAMA", Emparejamiento.consolaDe("kama"))
    assertEquals("tu consola de KOMO › Estaciones", Emparejamiento.consolaDe("komo"))
    assertTrue(Emparejamiento.FORMATO.matches("W2345ABCD"))
  }

  @Test fun guardarYLeerDaLoMismo() {
    val l = Proyectos.desdeRegistro(JSONArray(registro))
    assertEquals(l, Proyectos.desdeRegistro(JSONArray(Proyectos.aJson(l))))
  }

  @Test fun sinRegistroSoloLaFabrica() {
    assertEquals(listOf("K", "P", "T"), Proyectos.conocidos.map { it.letra })
    assertEquals("Z", Emparejamiento.nombreApp("Z"))
    assertTrue(Emparejamiento.mensajeError("CODIGO_FORMATO").contains("K de KOMO, P de KIPU, T de KUTI"))
    assertTrue(Emparejamiento.mensajeError("CODIGO_RESERVADO", app = "z").contains("«Z»"))
  }
}
