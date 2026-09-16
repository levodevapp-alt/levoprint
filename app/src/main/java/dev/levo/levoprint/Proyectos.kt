package dev.levo.levoprint

// Proyectos LevoDev conocidos por este build de LevoPrint. Se usan como
// respaldo cuando el codigo se escribe A MANO (sin QR), porque para armar
// la URL de la RPC ("<prefijo>_estacion_codigo_canjear") hace falta saber
// el prefijo ANTES de canjear.
//
// Hoy KOMO y KIPU comparten el MISMO proyecto Supabase (url/anon PUBLICOS,
// identicos: ver levoprint.sql "lp_supabase_url"/"lp_anon_key" en ambos
// repos). Por eso alcanza con probar el codigo contra cada prefijo conocido
// (ver Emparejamiento.kt) sin pedirle nada al usuario. Si algun dia un
// proyecto nuevo usa OTRO Supabase, la solucion de fondo es que el QR/
// deep-link de la consola traiga tambien url+anon+prefijo (parametros
// &p=&u=&a= que Emparejamiento.parseLink ya sabe leer) — asi el APK no
// necesita conocer de antemano ese proyecto. Mientras tanto, si hiciera
// falta, se agrega una fila mas aca.
data class ProyectoLP(val prefijo: String, val nombre: String, val url: String, val anon: String)

object Proyectos {
  private const val URL_COMPARTIDA = "https://krfljsososdakbatevci.supabase.co"
  private const val ANON_COMPARTIDO =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtyZmxqc29zb3NkYWtiYXRldmNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgxOTU4MjQsImV4cCI6MjEwMzc3MTgyNH0.nYjVS4UW3jcOC_ho8UKt6H8j1ix_WgoMDyywdfBNlMs"

  val conocidos = listOf(
    ProyectoLP("komo", "KOMO", URL_COMPARTIDA, ANON_COMPARTIDO),
    ProyectoLP("kipu", "KIPU", URL_COMPARTIDA, ANON_COMPARTIDO)
  )
}
