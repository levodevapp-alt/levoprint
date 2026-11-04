package dev.levo.levoprint

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.hardware.usb.UsbManager
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import com.google.android.material.materialswitch.MaterialSwitch
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

class MainActivity : AppCompatActivity() {
  private val h = Handler(Looper.getMainLooper())

  // Se registra en la construccion (requisito de la API), pero la logica
  // real vive en `alRecibirEmparejamiento`, que se asigna dentro de
  // onCreate (necesita las vistas y closures de ahi). Asi tanto el escaneo
  // como el deep-link (onNewIntent) comparten el mismo camino.
  private var alRecibirEmparejamiento: ((codigo: String, prefijo: String?, url: String?, anon: String?) -> Unit)? = null
  private val escanerQr = registerForActivityResult(ScanContract()) { r ->
    r.contents?.let { manejarTextoEscaneado(it) }
  }

  private fun manejarTextoEscaneado(texto: String) {
    val uri = try { Uri.parse(texto.trim()) } catch (_: Exception) { null }
    val datos = uri?.let { Emparejamiento.parseLink(it) }
    if (datos != null) {
      alRecibirEmparejamiento?.invoke(datos.codigo, datos.prefijo, datos.url, datos.anon)
    } else {
      // No es un link levoprint:// conocido: asume que el QR trae el codigo pelado.
      val cod = Emparejamiento.normalizar(texto).take(9)
      alRecibirEmparejamiento?.invoke(cod, null, null, null)
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    // [LP-F4] Se conecto una impresora USB (filtro res/xml/usb_impresoras.xml): buscar de nuevo.
    if (intent.action == UsbManager.ACTION_USB_DEVICE_ATTACHED) buscarEnFondo(false)
    intent.data?.let { uri -> Emparejamiento.parseLink(uri)?.let { d ->
      alRecibirEmparejamiento?.invoke(d.codigo, d.prefijo, d.url, d.anon)
    } }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.activity_main)

    val inUrl = findViewById<EditText>(R.id.inUrl)
    val inAnon = findViewById<EditText>(R.id.inAnon)
    val inDevice = findViewById<EditText>(R.id.inDevice)
    val inPrefijo = findViewById<EditText>(R.id.inPrefijo)
    val inAncho = findViewById<EditText>(R.id.inAncho)
    val swBt = findViewById<MaterialSwitch>(R.id.swBluetooth)
    // [MM3-01 · MM3-P1] Pie con logo: se apaga si la impresora no imprime imagenes (el pie sale en texto).
    val swImagen = findViewById<MaterialSwitch>(R.id.swImagen)
    swImagen.isChecked = Prefs.getImagen(this)
    swImagen.setOnCheckedChangeListener { _, on -> Prefs.setImagen(this, on) }
    val btn = findViewById<Button>(R.id.btnToggle)
    val estado = findViewById<TextView>(R.id.txtEstado)
    val log = findViewById<TextView>(R.id.txtLog)
    val inCodigo = findViewById<EditText>(R.id.inCodigo)
    val btnEmparejar = findViewById<Button>(R.id.btnEmparejar)
    val btnEscanear = findViewById<Button>(R.id.btnEscanear)
    val txtEmparejar = findViewById<TextView>(R.id.txtEmparejar)
    val txtVinculos = findViewById<TextView>(R.id.txtVinculos)

    // [MM4-08] Opciones avanzadas plegadas (cerradas al abrir): URL, clave, device, prefijo y ancho.
    val btnAvanzadas = findViewById<TextView>(R.id.btnAvanzadas)
    val boxAvanzadas = findViewById<View>(R.id.boxAvanzadas)
    btnAvanzadas.setOnClickListener {
      val abrir = boxAvanzadas.visibility != View.VISIBLE
      boxAvanzadas.visibility = if (abrir) View.VISIBLE else View.GONE
      btnAvanzadas.text = if (abrir) "▾ Opciones avanzadas" else "▸ Opciones avanzadas"
    }

    // [MM4-07] Tarjeta del ahorro de bateria (ver refrescarBateria).
    findViewById<Button>(R.id.btnBateria).setOnClickListener { pedirSinAhorroBateria() }

    // leerSinDevice: muestra lo guardado aunque la config este a medias.
    Prefs.leerSinDevice(this).let {
      inUrl.setText(it.url); inAnon.setText(it.anon); inDevice.setText(it.device)
      inPrefijo.setText(it.prefijo); inAncho.setText(it.ancho.toString())
    }
    val btnBt = findViewById<android.widget.Button>(R.id.btnBt)
    val txtBt = findViewById<TextView>(R.id.txtBt)

    fun refrescarBt() {
      val on = swBt.isChecked
      val vis = if (on) android.view.View.VISIBLE else android.view.View.GONE
      btnBt.visibility = vis
      txtBt.visibility = vis
      val nom = Prefs.getBtNombre(this)
      txtBt.text = if (nom.isNotBlank()) "Impresora BT: $nom" else "Ninguna impresora BT elegida"
    }

    swBt.isChecked = Prefs.getBluetooth(this)
    swBt.setOnCheckedChangeListener { _, on ->
      Prefs.setBluetooth(this, on)
      if (on && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) pedir(Manifest.permission.BLUETOOTH_CONNECT)
      refrescarBt()
    }
    btnBt.setOnClickListener {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) pedir(Manifest.permission.BLUETOOTH_CONNECT)
      val disp = Bt.emparejadas()
      if (disp.isEmpty()) {
        android.app.AlertDialog.Builder(this)
          .setTitle("Sin impresoras Bluetooth")
          .setMessage("Empareja la impresora en Ajustes de Android (Bluetooth) y vuelve a intentar.")
          .setPositiveButton("OK", null).show()
        return@setOnClickListener
      }
      val nombres = disp.map { it.nombre }.toTypedArray()
      android.app.AlertDialog.Builder(this)
        .setTitle("Elige la impresora")
        .setItems(nombres) { _, i ->
          Prefs.setBt(this, disp[i].mac, disp[i].nombre)
          refrescarBt()
        }.show()
    }
    refrescarBt()

    fun refrescar() {
      val on = PrintService.activo
      btn.text = if (on) "Detener" else "Guardar y arrancar"
      // [qa4] Desactivado desde la consola (AGENTE_INVALIDO): el servicio
      // conserva el token y reintenta solo (backoff 60 s / 5 min / 15 min).
      // Se avisa claro y el dueno puede escanear/escribir un codigo nuevo.
      val desact = on && PrintService.desactivado
      val msg = if (desact) Emparejamiento.textoDesactivado(PrintService.desactivadoPrefijo.ifBlank { Prefs.leer(this)?.prefijo ?: "" }, PrintService.desactivadoDesde) else ""
      if (desact && (txtEmparejar.text.isBlank() || txtEmparejar.text.startsWith("Vinculado") || txtEmparejar.text.startsWith("Este equipo está desactivado"))) {
        txtEmparejar.text = msg
        txtEmparejar.setTextColor(COLOR_ERROR)
      }
      estado.text = when {
        desact -> msg
        on -> "Activo · escuchando impresion"
        else -> "Detenido"
      }
      // [LP-U1] Apps vinculadas en este equipo (una linea por app).
      val vs = Prefs.leerVinculosConNombre(this)
      txtVinculos.visibility = if (vs.isEmpty()) View.GONE else View.VISIBLE
      txtVinculos.text = "Imprime para:" + vs.joinToString("", prefix = "") { (c, nombre) ->
        "\n· " +
        Emparejamiento.nombreApp(Proyectos.conocidos.firstOrNull { it.prefijo.equals(c.prefijo, true) }?.letra ?: c.prefijo) +
          (if (nombre.isNotBlank()) " (" + nombre + ")" else "") +
          (if (PrintService.desactivadoPrefijo.equals(c.prefijo, true)) " · desactivado" else "")
      }
    }

    // ---- Emparejamiento por codigo (tecleado o via QR) ----
    fun intentarEmparejar(codigo: String, prefijo: String?, url: String?, anon: String?) {
      if (codigo.isBlank()) {
        txtEmparejar.text = Emparejamiento.mensajeError("SIN_CODIGO")
        txtEmparejar.setTextColor(COLOR_ERROR); vibrar(doble = true)
        return
      }
      inCodigo.setText(codigo)
      txtEmparejar.text = "Vinculando…"
      txtEmparejar.setTextColor(COLOR_NEUTRO)
      btnEmparejar.isEnabled = false
      btnEscanear.isEnabled = false
      Thread {
        val r = Emparejamiento.canjear(codigo, prefijo, url, anon)
        h.post {
          btnEmparejar.isEnabled = true
          btnEscanear.isEnabled = true
          when (r) {
            is CanjeResultado.Ok -> {
              // [LP-U1] Agrega el vinculo de esta app SIN borrar los de las otras (mismo camino
              // para lo tecleado, el QR y el deep link levoprint://emparejar?c=...&p=...).
              Prefs.guardar(this, r.cfg, r.nombre)
              inUrl.setText(r.cfg.url); inAnon.setText(r.cfg.anon); inDevice.setText(r.cfg.device)
              inPrefijo.setText(r.cfg.prefijo); inAncho.setText(r.cfg.ancho.toString())
              // El servidor apaga a los anteriores recien con el PRIMER trabajo impreso de este equipo.
              // [MM4-06] Vibracion corta de exito. [QA BAJO-3] Mientras sale el papel el texto va en
              // tono neutro ("Imprimiendo…"); el verde o el ambar llegan con el resultado.
              val exito = Emparejamiento.textoExito(r)
              vibrar(doble = false)
              val i = Intent(this, PrintService::class.java)
              if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i) else startService(i)
              h.postDelayed({ refrescar() }, 500)
              if (r.reintento) {
                // [QA BAJO-4] Recanje idempotente (misma IP, < 3 min): el papel ya salio la primera vez.
                txtEmparejar.text = exito
                txtEmparejar.setTextColor(COLOR_OK)
              } else {
                txtEmparejar.text = exito + " Imprimiendo un papel de prueba…"
                txtEmparejar.setTextColor(COLOR_NEUTRO)
                // [MM4-06] Papel de prueba local en un hilo (red/Bluetooth). Si no sale, el
                // vinculo igual quedo hecho: se avisa en ambar, sin vibrar otra vez.
                val cfg = r.cfg
                val nombre = r.nombre
                Thread {
                  // [LP-F3] Primero se buscan impresoras (red, Bluetooth emparejadas, USB) y se informan a la
                  // app; asi, si la estacion no tiene impresora, la pantalla pregunta donde esta.
                  try { Impresoras.buscar(applicationContext, false) } catch (_: Exception) {}
                  val papel = imprimirPapelVinculado(cfg, nombre)
                  h.post {
                    if (papel == null) {
                      txtEmparejar.text = exito + " Salió un papel de prueba: la impresora ya funciona."
                      txtEmparejar.setTextColor(COLOR_OK)
                    } else { txtEmparejar.text = exito + " " + papel; txtEmparejar.setTextColor(COLOR_AVISO) }
                  }
                }.start()
              }
              // [MM4-07] Recien vinculado: pedir quedar fuera del ahorro de bateria.
              refrescarBateria()
              if (r.reintento) buscarEnFondo(false)
            }
            is CanjeResultado.Error -> {
              // [MM4-06] Error en rojo con vibracion doble.
              txtEmparejar.text = r.mensaje
              txtEmparejar.setTextColor(COLOR_ERROR)
              vibrar(doble = true)
            }
          }
        }
      }.start()
    }
    alRecibirEmparejamiento = { codigo, prefijo, url, anon -> intentarEmparejar(codigo, prefijo, url, anon) }

    btnEmparejar.setOnClickListener { intentarEmparejar(inCodigo.text.toString(), null, null, null) }
    btnEscanear.setOnClickListener {
      pedir(Manifest.permission.CAMERA) // minSdk 26 > M: siempre aplica permiso en runtime
      escanerQr.launch(ScanOptions()
        .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
        .setPrompt("Apunta al código QR de la consola")
        .setBeepEnabled(true)
        .setOrientationLocked(true))
    }

    // Deep-link en frio: la app se abrio recien por el QR (levoprint://emparejar?c=...).
    intent?.data?.let { uri -> Emparejamiento.parseLink(uri)?.let { d ->
      intentarEmparejar(d.codigo, d.prefijo, d.url, d.anon)
    } }

    btn.setOnClickListener {
      if (PrintService.activo) {
        stopService(Intent(this, PrintService::class.java))
      } else {
        val ancho = Agent.anchoValido(inAncho.text.toString().toIntOrNull() ?: 48) // [Re-QA BAJO-1] 20-100
        inAncho.setText(ancho.toString())
        val manual = Cfg(
          inUrl.text.toString().trim(), inAnon.text.toString().trim(),
          inDevice.text.toString().trim(),
          inPrefijo.text.toString().trim().lowercase().ifBlank { "komo" }, ancho
        )
        // [LP-U1] Con datos a medias no se guarda (antes se pisaba la config): si ya hay
        // vinculos, solo se arranca con ellos.
        // [QA LP-U1 · MEDIO 4] Los campos avanzados muestran el PRIMER vinculo: se guardan solo
        // si el usuario cambio algo, con un prefijo conocido (komo/kipu/kuti) y sin reusar el
        // device de otra app (un token es de UNA app). Si no cambio nada, solo cuenta el ancho.
        val completos = manual.url.isNotBlank() && manual.anon.isNotBlank() && manual.device.isNotBlank()
        val actual = Prefs.leer(this)
        val cambio = completos && (actual == null || actual.url != manual.url || actual.anon != manual.anon ||
          actual.device != manual.device || !actual.prefijo.equals(manual.prefijo, ignoreCase = true))
        if (cambio) {
          // [QA LP-U1 · BAJO-c] Se acepta cualquier prefijo bien formado (una app nueva de LevoDev
          // puede no estar aún en Proyectos.conocidos); solo se avisa si no se reconoce.
          if (!Regex("^[a-z][a-z0-9_]{1,15}$").matches(manual.prefijo)) {
            estado.text = "Prefijo no válido: usa solo letras minúsculas, números o «_» (por ejemplo komo, kipu o kuti)."
            return@setOnClickListener
          }
          val otraApp = Prefs.leerVinculos(this).firstOrNull { it.device == manual.device && !it.prefijo.equals(manual.prefijo, ignoreCase = true) }
          if (otraApp != null) {
            estado.text = "Ese device ya es de " + otraApp.prefijo.uppercase() + ": usa el código de la otra app para vincularla."
            return@setOnClickListener
          }
          Prefs.guardar(this, manual)
          if (Proyectos.conocidos.none { it.prefijo == manual.prefijo }) {
            // Aviso suave (ambar): se guarda igual.
            txtEmparejar.text = "Ojo: «" + manual.prefijo + "» no es una app conocida por esta versión (komo, kipu, kuti). Se guardó igual; revisa que esté bien escrito."
            txtEmparejar.setTextColor(COLOR_AVISO)
          }
        } else Prefs.setAncho(this, ancho)
        if (Prefs.leer(this) == null) { estado.text = "Faltan datos: URL, clave y device"; return@setOnClickListener }
        val i = Intent(this, PrintService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i) else startService(i)
      }
      h.postDelayed({ refrescar() }, 500)
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) pedir(Manifest.permission.POST_NOTIFICATIONS)

    // ---- [LP-F3] «¿Dónde está la impresora de <estación>?» ----
    findViewById<Button>(R.id.btnBuscarImpresoras).setOnClickListener {
      pedirPermisosBt()
      val descubrir = puedeDescubrirBt()
      msgDestino(if (descubrir) "Buscando impresoras (unos 15 segundos)…" else "Buscando impresoras…", COLOR_NEUTRO)
      buscarEnFondo(descubrir)
    }
    findViewById<Button>(R.id.btnNoLaVeo).setOnClickListener {
      val b = findViewById<View>(R.id.boxNoLaVeo)
      b.visibility = if (b.visibility == View.VISIBLE) View.GONE else View.VISIBLE
    }
    findViewById<Button>(R.id.btnCerrarDestino).setOnClickListener { cerrarEleccion() }
    findViewById<Button>(R.id.btnProbarIp).setOnClickListener {
      val rr = BusquedaLogica.refRed(findViewById<EditText>(R.id.inIpManual).text.toString())
      if (rr == null) msgDestino("Esa IP no es válida. Ejemplo: 192.168.1.50", COLOR_ERROR)
      else probarEncontrada(Encontrada("red", rr.first + ":" + rr.second, "Impresora en " + rr.first))
    }
    if (intent?.action == UsbManager.ACTION_USB_DEVICE_ATTACHED) buscarEnFondo(false)

    // Arranque automático si ya hay configuración (tras reinicio/reapertura).
    // Si el servicio corre pero esta desactivado, abrir la app lo despierta
    // para reintentar al instante (onStartCommand).
    if (Prefs.leer(this) != null && (!PrintService.activo || PrintService.desactivado)) {
      val i = Intent(this, PrintService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i) else startService(i)
    }
    refrescar()
    tick = object : Runnable {
      override fun run() { log.text = PrintService.ultimoLog; refrescar(); refrescarDestinos(); h.postDelayed(this, 1500) }
    }
    h.post(tick!!)
  }

  private var tick: Runnable? = null
  override fun onDestroy() { tick?.let { h.removeCallbacks(it) }; super.onDestroy() }

  // [MM4-07] Al volver de Ajustes (o reabrir la app) la tarjeta se actualiza: verde si ya quedo.
  override fun onResume() { super.onResume(); refrescarBateria() }

  // ---- [MM4-07] Ahorro de bateria ----
  // Xiaomi, Samsung, Huawei y Motorola matan el servicio en primer plano a los minutos de apagar
  // la pantalla ("la cocina no recibio el pedido"). Con el equipo vinculado y Android pudiendo
  // dormirlo, se muestra la tarjeta con "Permitir"; si ya esta permitido y la tarjeta se mostro en
  // alguna vez (Prefs.getBateriaPedida, QA BAJO-7), queda en verde; si nunca hizo falta, no aparece.
  private fun sinAhorroBateria(): Boolean = try {
    (getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(packageName)
  } catch (_: Exception) { true }

  private fun refrescarBateria() {
    val card = findViewById<View>(R.id.cardBateria) ?: return
    val txt = findViewById<TextView>(R.id.txtBateria)
    val btn = findViewById<Button>(R.id.btnBateria)
    if (Prefs.leer(this) == null) { card.visibility = View.GONE; return }
    if (sinAhorroBateria()) {
      if (!Prefs.getBateriaPedida(this)) { card.visibility = View.GONE; return }
      card.visibility = View.VISIBLE
      txt.text = "Listo: el ahorro de batería ya no detiene a LevoPrint."
      txt.setTextColor(COLOR_OK)
      btn.visibility = View.GONE
    } else {
      Prefs.setBateriaPedida(this, true)
      card.visibility = View.VISIBLE
      txt.text = "Para que las comandas salgan siempre, deja a LevoPrint sin ahorro de batería. " +
        "Si no, el celular lo duerme a los minutos de apagar la pantalla."
      txt.setTextColor(COLOR_TEXTO)
      btn.visibility = View.VISIBLE
    }
  }

  private fun pedirSinAhorroBateria() {
    try {
      startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
    } catch (_: Exception) {
      // Algunas capas (MIUI, EMUI) no traen el dialogo directo: la lista general de Ajustes.
      try { startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) } catch (_: Exception) {}
    }
  }

  // ---- [MM4-06] Papel de prueba al vincular ----
  // Corre en un hilo (red/Bluetooth). [QA MEDIO-1] Sin adivinar: 1) la estacion del codigo (el canje
  // responde "<estacion> · <negocio>") si tiene IP; 2) la impresora Bluetooth si esta activada;
  // 3) la UNICA estacion con IP si hay exactamente una; si no, se avisa. Devuelve null si salio,
  // o el aviso para el cajero si no.
  // OJO: es local, no pasa por la cola: el servidor sigue apagando a los equipos anteriores
  // recien con el primer trabajo de la cola que imprima este equipo.
  private fun imprimirPapelVinculado(cfg: Cfg, nombre: String): String? {
    val hora = java.text.SimpleDateFormat("dd/MM/yyyy HH:mm", java.util.Locale.US).format(java.util.Date())
    val texto = Agent.renderVinculado(nombre, hora, cfg.ancho, cfg.prefijo, Prefs.getImagen(this))
    val st = Impresoras.app(cfg)
    val ests = try { Agent.estaciones(cfg).also { st.estaciones = it }.values.toList() } catch (_: Exception) { emptyList() }
    try { Impresoras.informar(this, cfg, false) } catch (_: Exception) {}
    val deCodigo = nombre.substringBefore(" · ").trim()
    // [LP-F3] La estacion del vinculo (estacionVinculo) o la del nombre del codigo, si este equipo alcanza su
    // impresora (red, Bluetooth o USB de este equipo); si no, la UNICA asi. Con varias o ninguna, la pantalla pregunta.
    val imprimibles = ests.mapNotNull { Impresoras.destino(cfg, it.id) }.filter { it.imprimible }
    val est = imprimibles.firstOrNull { it.estacion == st.estacionVinculo }
      ?: imprimibles.firstOrNull { it.nombre.trim().equals(deCodigo, ignoreCase = true) }
      ?: (if (imprimibles.size == 1 && st.estacionVinculo == null) imprimibles[0] else null)
    val btMac = Prefs.getBtMac(this)
    val bt = Prefs.getBluetooth(this) && btMac.isNotBlank()
    return when {
      est != null -> try { Impresoras.imprimir(this, est, texto); null } catch (_: Exception) {
        st.preguntar = true
        "No salió el papel de prueba: revisa que la impresora de " + est.nombre + " esté encendida y conectada."
      }
      bt -> try { Bt.imprimir(btMac, texto); null } catch (_: Exception) {
        // [QA BAJO-2] Mensaje propio de Bluetooth.
        "No salió el papel de prueba: revisa que la impresora Bluetooth esté encendida y emparejada con este celular."
      }
      st.transporte == false && imprimibles.isEmpty() -> {
        st.preguntar = true
        "No salió el papel de prueba: falta la IP de la impresora en " + Emparejamiento.consolaDe(cfg.prefijo) + "."
      }
      st.transporte == false -> "No salió el papel de prueba: hay varias impresoras y no se sabe cuál es la de esta estación. " +
        "Revisa el nombre de la estación en " + Emparejamiento.consolaDe(cfg.prefijo) + "."
      else -> {
        st.preguntar = true
        "Falta elegir la impresora: más abajo te mostramos las que encontramos."
      }
    }
  }

  // ---- [LP-F3] «¿Dónde está la impresora de <estación>?» ----
  // Lista de estaciones con su impresora y la tarjeta de eleccion (red / Bluetooth / USB). Se arma de
  // nuevo solo si cambio algo (firma), no en cada tick: asi no parpadea ni se pierde el toque.
  private data class Eleccion(val cfg: Cfg, val estacion: String, val nombre: String)
  private var eleccion: Eleccion? = null
  private val cerradas = HashSet<String>()
  private var firmaEstaciones = ""
  private var firmaEncontradas = ""
  @Volatile private var ocupado = false

  private fun msgDestino(texto: String, color: Int) {
    val t = findViewById<TextView>(R.id.txtDestinoMsg)
    t.text = texto
    t.setTextColor(color)
  }

  private fun buscarEnFondo(descubrirBt: Boolean) {
    val ctx = applicationContext
    firmaEncontradas = ""
    Thread {
      try { Impresoras.buscar(ctx, descubrirBt) } catch (_: Exception) {}
      h.post {
        firmaEncontradas = ""
        firmaEstaciones = ""
        val t = findViewById<TextView>(R.id.txtDestinoMsg)
        if (t.text.startsWith("Buscando")) msgDestino("", COLOR_NEUTRO)
      }
    }.start()
  }

  private fun puedeDescubrirBt(): Boolean = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
    checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED &&
      checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
  else checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

  private fun pedirPermisosBt() {
    val lista = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
      listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
    else listOf(Manifest.permission.ACCESS_FINE_LOCATION)
    val faltan = lista.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
    if (faltan.isNotEmpty()) ActivityCompat.requestPermissions(this, faltan.toTypedArray(), 2)
  }

  private fun abrirEleccion(c: Cfg, estacion: String, nombre: String) {
    eleccion = Eleccion(c, estacion, nombre)
    firmaEncontradas = ""
    findViewById<View>(R.id.cardDestino).visibility = View.VISIBLE
    findViewById<TextView>(R.id.txtDestinoTitulo).text = "¿Dónde está la impresora de " + nombre + "?"
    findViewById<View>(R.id.boxNoLaVeo).visibility = View.GONE
    msgDestino("", COLOR_NEUTRO)
    if (Impresoras.ts == 0L && !Impresoras.buscando) buscarEnFondo(false)
  }

  private fun cerrarEleccion() {
    eleccion?.let { cerradas.add(it.cfg.prefijo + "|" + it.estacion) }
    eleccion = null
    findViewById<View>(R.id.cardDestino).visibility = View.GONE
  }

  private fun refrescarDestinos() {
    val vs = Prefs.leerVinculos(this)
    // Se pregunta sola: la estacion del vinculo sin impresora que este equipo alcance, o (tras vincular
    // sin papel de prueba) la primera sin impresora. Una vez por estacion: «Cerrar» no la vuelve a abrir.
    if (eleccion == null && !ocupado) {
      for (c in vs) {
        val st = Impresoras.app(c)
        if (st.transporte == null && !st.preguntar) continue
        val sin = st.estaciones.values.filter { e ->
          Impresoras.destino(c, e.id)?.imprimible != true && (c.prefijo + "|" + e.id) !in cerradas
        }
        val est = sin.firstOrNull { it.id == st.estacionVinculo } ?: (if (st.preguntar) sin.firstOrNull() else null)
        if (est != null) {
          abrirEleccion(c, est.id, est.nombre)
          break
        }
      }
    }
    // Filas de estaciones (una por estacion de cada app).
    val filas = ArrayList<Triple<Cfg, Estacion, Destino?>>()
    for (c in vs) for (e in Impresoras.app(c).estaciones.values.sortedBy { it.nombre }) filas.add(Triple(c, e, Impresoras.destino(c, e.id)))
    val firma = filas.joinToString("|") { (c, e, d) -> c.prefijo + e.id + e.nombre + (d?.texto() ?: "") + Impresoras.app(c).transporte }
    if (firma != firmaEstaciones) {
      firmaEstaciones = firma
      val box = findViewById<LinearLayout>(R.id.boxEstaciones)
      box.removeAllViews()
      for ((c, e, d) in filas) {
        val st = Impresoras.app(c)
        val donde = d?.texto()?.ifBlank { null } ?: (if (st.transporte == false)
          "Falta la IP: escríbela en " + Emparejamiento.consolaDe(c.prefijo) else "Falta elegir la impresora")
        val fila = LinearLayout(this)
        fila.orientation = LinearLayout.HORIZONTAL
        fila.gravity = Gravity.CENTER_VERTICAL
        val tv = TextView(this)
        tv.text = Emparejamiento.nombreApp(Proyectos.conocidos.firstOrNull { it.prefijo.equals(c.prefijo, true) }?.letra ?: c.prefijo) +
          " · " + e.nombre + "\n" + donde
        tv.setTextColor(if (d?.imprimible == true) COLOR_TEXTO else COLOR_AVISO)
        tv.textSize = 13f
        fila.addView(tv, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        val b = Button(this)
        b.text = if (d?.texto().isNullOrBlank()) "Elegir" else "Cambiar"
        b.minHeight = (48 * resources.displayMetrics.density).toInt()
        b.setOnClickListener { abrirEleccion(c, e.id, e.nombre) }
        fila.addView(b)
        box.addView(fila)
      }
    }
    pintarEncontradas()
  }

  private fun textoChico(t: String, color: Int, arriba: Int): TextView {
    val v = TextView(this)
    v.text = t
    v.setTextColor(color)
    v.textSize = if (arriba > 0) 12f else 13f
    v.setPadding(0, (arriba * resources.displayMetrics.density).toInt(), 0, 0)
    return v
  }

  private fun pintarEncontradas() {
    val el = eleccion
    val card = findViewById<View>(R.id.cardDestino)
    if (el == null) {
      card.visibility = View.GONE
      return
    }
    val firma = Impresoras.ts.toString() + Impresoras.buscando + el + Impresoras.app(el.cfg).transporte + ocupado
    if (firma == firmaEncontradas) return
    firmaEncontradas = firma
    val box = findViewById<LinearLayout>(R.id.boxEncontradas)
    box.removeAllViews()
    val grupos = listOf(
      Triple("EN LA RED", Impresoras.red, "No encontramos impresoras de red."),
      Triple("BLUETOOTH", Impresoras.bt, "Ninguna. Toca «Buscar de nuevo» para buscar cerca."),
      Triple("USB (CABLE A ESTE EQUIPO)", Impresoras.usb, "Ninguna conectada.")
    )
    for ((titulo, lista, vacio) in grupos) {
      box.addView(textoChico(titulo, COLOR_NEUTRO, 10))
      if (lista.isEmpty()) {
        box.addView(textoChico(vacio, COLOR_TEXTO, 0))
        continue
      }
      for (e in lista) {
        val sub = when (e.transporte) {
          "red" -> e.ref
          "bluetooth" -> (if (e.detalle.optBoolean("emparejada", true)) "Emparejada" else "Sin emparejar: al tocarla se empareja") +
            (if (e.detalle.optBoolean("general")) " · la que usabas" else "")
          else -> if (e.detalle.optBoolean("permiso")) "Conectada por cable" else "Conectada por cable · pedirá permiso"
        }
        val b = Button(this)
        b.text = e.nombre + "\n" + sub
        b.isAllCaps = false
        b.isEnabled = !ocupado
        b.minHeight = (48 * resources.displayMetrics.density).toInt()
        b.setOnClickListener { probarEncontrada(e) }
        box.addView(b)
      }
    }
    if (Impresoras.buscando) box.addView(textoChico("Buscando…", COLOR_NEUTRO, 10))
    else if (Impresoras.ts == 0L) box.addView(textoChico("Toca «Buscar de nuevo».", COLOR_NEUTRO, 10))
  }

  // Prueba -> «¿Salió?» -> Sí = se guarda en la app (o, con la app sin actualizar, «Escribe esta IP en…»).
  private fun probarEncontrada(e: Encontrada) {
    val el = eleccion ?: return
    if (ocupado) return
    ocupado = true
    firmaEncontradas = ""
    val sinEmparejar = e.transporte == "bluetooth" && !e.detalle.optBoolean("emparejada", true)
    msgDestino(if (sinEmparejar) "Emparejando con " + e.nombre + "… si te pide un PIN, prueba 0000 o 1234."
      else "Enviando un papel de prueba a " + e.nombre + "…", COLOR_NEUTRO)
    val ctx = applicationContext
    Thread {
      val err = try { Impresoras.probar(ctx, el.cfg, e) } catch (x: Exception) { "No se pudo probar: " + (x.message ?: "error") }
      h.post {
        ocupado = false
        firmaEncontradas = ""
        if (isFinishing) return@post
        if (err != null) {
          msgDestino(err, COLOR_ERROR)
          vibrar(doble = true)
          return@post
        }
        msgDestino("", COLOR_NEUTRO)
        android.app.AlertDialog.Builder(this)
          .setTitle("¿Salió el papel?")
          .setMessage("Enviamos un papel de prueba a " + e.nombre + ".")
          .setPositiveButton("Sí, salió") { _, _ -> elegirEncontrada(el, e) }
          .setNegativeButton("No salió") { _, _ ->
            msgDestino("Prueba con otra de la lista. Si ninguna sale, revisa que esté encendida y conectada, y toca «Buscar de nuevo».", COLOR_AVISO)
          }
          .show()
      }
    }.start()
  }

  private fun elegirEncontrada(el: Eleccion, e: Encontrada) {
    ocupado = true
    firmaEncontradas = ""
    msgDestino("Guardando…", COLOR_NEUTRO)
    val ctx = applicationContext
    Thread {
      val r = try { Impresoras.elegir(ctx, el.cfg, el.estacion, el.nombre, e) } catch (x: Exception) {
        Impresoras.Resultado(false, "No se pudo guardar. Revisa tu internet e intenta de nuevo.")
      }
      h.post {
        ocupado = false
        firmaEncontradas = ""
        firmaEstaciones = ""
        msgDestino(r.mensaje, if (r.ok) COLOR_OK else if (r.modo16) COLOR_AVISO else COLOR_ERROR)
        vibrar(doble = !r.ok)
        if (r.ok) {
          cerradas.add(el.cfg.prefijo + "|" + el.estacion)
          h.postDelayed({ if (eleccion == el) cerrarEleccion() }, 2500)
        }
      }
    }.start()
  }

  // ---- [MM4-06] Vibracion: corta = exito, doble = error ----
  private fun vibrar(doble: Boolean) {
    try {
      val v: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
        getSystemService(VibratorManager::class.java)?.defaultVibrator
      else getSystemService(Vibrator::class.java)
      if (v == null || !v.hasVibrator()) return
      v.vibrate(
        if (doble) VibrationEffect.createWaveform(longArrayOf(0, 90, 110, 90), -1)
        else VibrationEffect.createOneShot(60, VibrationEffect.DEFAULT_AMPLITUDE)
      )
    } catch (_: Exception) {}
  }

  companion object {
    // [MM4-06] Colores del estado (antes siempre el mismo celeste): mismos tonos que la ventana del .exe.
    private val COLOR_OK = android.graphics.Color.parseColor("#5FE08A")
    private val COLOR_ERROR = android.graphics.Color.parseColor("#FF8080")
    private val COLOR_AVISO = android.graphics.Color.parseColor("#F2C14E")
    private val COLOR_NEUTRO = android.graphics.Color.parseColor("#8FB6D9")
    private val COLOR_TEXTO = android.graphics.Color.parseColor("#EAF4FF")
  }

  private fun pedir(p: String) {
    if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED)
      ActivityCompat.requestPermissions(this, arrayOf(p), 1)
  }
}
