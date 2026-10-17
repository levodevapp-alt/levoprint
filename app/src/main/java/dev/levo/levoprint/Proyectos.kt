package dev.levo.levoprint

// Proyectos LevoDev conocidos por este build de LevoPrint. Para armar la
// URL de la RPC ("<prefijo>_estacion_codigo_canjear") hace falta saber el
// prefijo ANTES de canjear: desde la rev 4 lo dice la PRIMERA LETRA del
// codigo (ver porLetra y Emparejamiento.kt), tecleado o por QR.
//
// Hoy KOMO y KIPU comparten el MISMO proyecto Supabase (url/anon PUBLICOS,
// identicos: ver levoprint.sql "lp_supabase_url"/"lp_anon_key"). Si algun
// dia una app nueva (p. ej. KUTI, letra T) usa otro Supabase, se agrega su
// fila aca con su letra; mientras no este, su codigo se rechaza con un
// mensaje claro en vez de llamar al proyecto equivocado.
// [canje-v4] "letra": primera letra del codigo de estacion de esa app
// (apps.json -> __LP_COD__ en levodev-modules). T queda reservada (KUTI) y
// no se lista hasta que exista su proyecto.
data class ProyectoLP(val prefijo: String, val nombre: String, val url: String, val anon: String, val letra: String)

object Proyectos {
  private const val URL_COMPARTIDA = "https://krfljsososdakbatevci.supabase.co"
  private const val ANON_COMPARTIDO =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtyZmxqc29zb3NkYWtiYXRldmNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgxOTU4MjQsImV4cCI6MjEwMzc3MTgyNH0.nYjVS4UW3jcOC_ho8UKt6H8j1ix_WgoMDyywdfBNlMs"

  val conocidos = listOf(
    ProyectoLP("komo", "KOMO", URL_COMPARTIDA, ANON_COMPARTIDO, "K"),
    ProyectoLP("kipu", "KIPU", URL_COMPARTIDA, ANON_COMPARTIDO, "P")
  )

  fun porLetra(letra: String): ProyectoLP? = conocidos.firstOrNull { it.letra.equals(letra, ignoreCase = true) }
}
