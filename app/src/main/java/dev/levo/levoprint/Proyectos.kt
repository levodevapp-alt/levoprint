package dev.levo.levoprint

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

// Proyectos LevoDev conocidos por este LevoPrint. Para armar la URL de la RPC
// ("<prefijo>_estacion_codigo_canjear") hace falta saber el prefijo ANTES de
// canjear: desde la rev 4 lo dice la PRIMERA LETRA del codigo (ver porLetra y
// Emparejamiento.kt), tecleado o por QR.
//
// Hoy todas las apps comparten el MISMO proyecto Supabase (url/anon PUBLICOS,
// identicos: ver levoprint.sql "lp_supabase_url"/"lp_anon_key").
// [canje-v4] "letra": primera letra del codigo de estacion de esa app
// (apps.json -> __LP_COD__ en levodev-modules). [kuti] T = KUTI desde la 1.4.0.
// [D8 · NUC-COM7 · 27-nov · 1.9.0] Las letras ya no estan solo aca: ademas de las de FABRICA (K, P, T), el
// SERVIDOR da las de cada app nueva (public.levoprint_apps, modulo levoprint_registro de levodev-modules). Crear
// una app no pide publicar otro APK. Lo recibido se guarda en las preferencias para arrancar sin red. Las de
// fabrica nunca se pisan (un registro mal armado no desvia K, P ni T) y cada prefijo tiene una sola letra.
data class ProyectoLP(
  val prefijo: String, val nombre: String, val url: String, val anon: String, val letra: String, val seccion: String = ""
)

object Proyectos {
  private const val URL_COMPARTIDA = "https://krfljsososdakbatevci.supabase.co"
  private const val ANON_COMPARTIDO =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtyZmxqc29zb3NkYWtiYXRldmNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgxOTU4MjQsImV4cCI6MjEwMzc3MTgyNH0.nYjVS4UW3jcOC_ho8UKt6H8j1ix_WgoMDyywdfBNlMs"
  private const val PREF = "levoprint"
  private const val CLAVE_PREF = "registro_apps"
  private const val CADA_MS = 6 * 3600_000L
  private const val MIN_FORZADO_MS = 30_000L
  private val TEXTO = Regex("^[0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ .&-]{1,40}$")
  private val PREFIJO = Regex("^[a-z][a-z0-9]{1,15}$")
  private val LETRA = Regex("^[A-Z]$")

  val FABRICA: List<ProyectoLP> = listOf(
    ProyectoLP("komo", "KOMO", URL_COMPARTIDA, ANON_COMPARTIDO, "K", "Estaciones"),
    ProyectoLP("kipu", "KIPU", URL_COMPARTIDA, ANON_COMPARTIDO, "P", "Impresoras"),
    ProyectoLP("kuti", "KUTI", URL_COMPARTIDA, ANON_COMPARTIDO, "T", "Impresoras")
  )

  @Volatile private var delServidor: List<ProyectoLP> = emptyList()
  @Volatile private var ctxApp: Context? = null
  @Volatile private var ultimoOk = 0L
  @Volatile private var ultimoIntento = 0L
  /** true si el ultimo intento fue un backend SIN el modulo (404): la letra desconocida no es culpa de la red. */
  @Volatile var ausente = false
    private set

  val conocidos: List<ProyectoLP> get() = FABRICA + delServidor

  fun porLetra(letra: String): ProyectoLP? = conocidos.firstOrNull { it.letra.equals(letra, ignoreCase = true) }
  fun porPrefijo(prefijo: String): ProyectoLP? = conocidos.firstOrNull { it.prefijo.equals(prefijo, ignoreCase = true) }
  /** Nombre visible de la app de un prefijo (o el prefijo en mayusculas si no se conoce). */
  fun nombreDe(prefijo: String): String = porPrefijo(prefijo)?.nombre ?: prefijo.uppercase()
  /** true si alguna vez se leyo el registro del servidor en este proceso. */
  val registroLeido: Boolean get() = ultimoOk > 0L

  /** Filas validas del registro (pura: la prueban los tests). Sin pisar las de fabrica; una letra y un prefijo por app. */
  fun desdeRegistro(apps: JSONArray?): List<ProyectoLP> {
    val out = ArrayList<ProyectoLP>()
    if (apps == null) return out
    for (i in 0 until apps.length()) {
      val a = apps.optJSONObject(i) ?: continue
      val letra = a.optString("letra"); val prefijo = a.optString("prefijo"); val nombre = a.optString("nombre")
      val seccion = if (a.isNull("seccion")) "" else a.optString("seccion")
      if (!LETRA.matches(letra) || !PREFIJO.matches(prefijo) || !TEXTO.matches(nombre)) continue
      if (seccion.isNotEmpty() && !TEXTO.matches(seccion)) continue
      if (FABRICA.any { it.letra == letra || it.prefijo == prefijo } || out.any { it.letra == letra || it.prefijo == prefijo }) continue
      out.add(ProyectoLP(prefijo, nombre, URL_COMPARTIDA, ANON_COMPARTIDO, letra, seccion))
    }
    return out
  }

  fun aplicar(lista: List<ProyectoLP>) { delServidor = lista.filter { p -> FABRICA.none { it.letra == p.letra || it.prefijo == p.prefijo } } }

  fun aJson(lista: List<ProyectoLP>): String = JSONArray().also { arr ->
    for (p in lista) arr.put(JSONObject().put("letra", p.letra).put("prefijo", p.prefijo).put("nombre", p.nombre).put("seccion", p.seccion))
  }.toString()

  /** Carga lo guardado (arranque sin red). Llamar en onCreate de la pantalla y del servicio. */
  fun iniciar(ctx: Context) {
    ctxApp = ctx.applicationContext
    try {
      val s = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(CLAVE_PREF, null)
      if (s != null) aplicar(desdeRegistro(JSONArray(s)))
    } catch (_: Exception) { }
  }

  /**
   * Lee public.levoprint_apps del proyecto compartido (RED: nunca en el hilo principal). forzar = letra desconocida
   * al canjear (como mucho cada 30 s); si no, cada 6 h. Nunca lanza: devuelve true si leyo el registro.
   */
  fun actualizar(forzar: Boolean = false): Boolean {
    val ahora = System.currentTimeMillis()
    if (forzar && ahora - ultimoIntento < MIN_FORZADO_MS) return false
    if (!forzar && ultimoOk > 0L && ahora - ultimoOk < CADA_MS) return false
    ultimoIntento = ahora
    return try {
      val r = Agent.rpc(Cfg(URL_COMPARTIDA, ANON_COMPARTIDO, "", "", 48), "levoprint_apps", JSONObject())
      if (!r.optBoolean("ok")) return false
      val lista = desdeRegistro(r.optJSONArray("apps"))
      aplicar(lista)
      ultimoOk = System.currentTimeMillis(); ausente = false
      ctxApp?.getSharedPreferences(PREF, Context.MODE_PRIVATE)?.edit()?.putString(CLAVE_PREF, aJson(lista))?.apply()
      true
    } catch (e: RpcError) {
      ausente = e.ausente
      false
    } catch (_: Exception) {
      false
    }
  }
}
