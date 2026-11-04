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
import android.view.View
import android.widget.Button
import android.widget.EditText
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

    // Arranque automático si ya hay configuración (tras reinicio/reapertura).
    // Si el servicio corre pero esta desactivado, abrir la app lo despierta
    // para reintentar al instante (onStartCommand).
    if (Prefs.leer(this) != null && (!PrintService.activo || PrintService.desactivado)) {
      val i = Intent(this, PrintService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i) else startService(i)
    }
    refrescar()
    tick = object : Runnable {
      override fun run() { log.text = PrintService.ultimoLog; refrescar(); h.postDelayed(this, 1500) }
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
    val ests = try { Agent.estaciones(cfg).values.toList() } catch (_: Exception) { emptyList() }
    val deCodigo = nombre.substringBefore(" · ").trim()
    val conIp = ests.filter { it.ip != null }
    val est = conIp.firstOrNull { it.nombre.trim().equals(deCodigo, ignoreCase = true) }
    val btMac = Prefs.getBtMac(this)
    val bt = Prefs.getBluetooth(this) && btMac.isNotBlank()
    return when {
      est?.ip != null -> try { Agent.imprimirTcp(est.ip, est.puerto, texto); null } catch (_: Exception) {
        "No salió el papel de prueba: revisa que la impresora de " + est.nombre + " esté encendida y en la misma red."
      }
      bt -> try { Bt.imprimir(btMac, texto); null } catch (_: Exception) {
        // [QA BAJO-2] Mensaje propio de Bluetooth.
        "No salió el papel de prueba: revisa que la impresora Bluetooth esté encendida y emparejada con este celular."
      }
      conIp.size == 1 -> {
        val u = conIp[0]
        try { Agent.imprimirTcp(u.ip!!, u.puerto, texto); null } catch (_: Exception) {
          "No salió el papel de prueba: revisa que la impresora de " + u.nombre + " esté encendida y en la misma red."
        }
      }
      conIp.isEmpty() -> "No salió el papel de prueba: falta la IP de la impresora en " + Emparejamiento.consolaDe(cfg.prefijo) + "."
      else -> "No salió el papel de prueba: hay varias impresoras y no se sabe cuál es la de esta estación. " +
        "Revisa el nombre de la estación en " + Emparejamiento.consolaDe(cfg.prefijo) + "."
    }
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
