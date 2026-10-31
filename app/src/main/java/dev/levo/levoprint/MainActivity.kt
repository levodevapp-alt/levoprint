package dev.levo.levoprint

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
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
      val cod = texto.trim().uppercase().filter { it.isLetterOrDigit() }.take(9)
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
    val btn = findViewById<Button>(R.id.btnToggle)
    val estado = findViewById<TextView>(R.id.txtEstado)
    val log = findViewById<TextView>(R.id.txtLog)
    val inCodigo = findViewById<EditText>(R.id.inCodigo)
    val btnEmparejar = findViewById<Button>(R.id.btnEmparejar)
    val btnEscanear = findViewById<Button>(R.id.btnEscanear)
    val txtEmparejar = findViewById<TextView>(R.id.txtEmparejar)

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
      val msg = if (desact) Emparejamiento.textoDesactivado(Prefs.leer(this)?.prefijo ?: "", PrintService.desactivadoDesde) else ""
      if (desact && (txtEmparejar.text.isBlank() || txtEmparejar.text.startsWith("Emparejado") || txtEmparejar.text.startsWith("Este equipo está desactivado")))
        txtEmparejar.text = msg
      estado.text = when {
        desact -> msg
        on -> "Activo · escuchando impresion"
        else -> "Detenido"
      }
    }

    // ---- Emparejamiento por codigo (tecleado o via QR) ----
    fun intentarEmparejar(codigo: String, prefijo: String?, url: String?, anon: String?) {
      if (codigo.isBlank()) { txtEmparejar.text = Emparejamiento.mensajeError("SIN_CODIGO"); return }
      inCodigo.setText(codigo)
      txtEmparejar.text = "Emparejando..."
      btnEmparejar.isEnabled = false
      btnEscanear.isEnabled = false
      Thread {
        val r = Emparejamiento.canjear(codigo, prefijo, url, anon)
        h.post {
          btnEmparejar.isEnabled = true
          btnEscanear.isEnabled = true
          when (r) {
            is CanjeResultado.Ok -> {
              Prefs.guardar(this, r.cfg)
              inUrl.setText(r.cfg.url); inAnon.setText(r.cfg.anon); inDevice.setText(r.cfg.device)
              inPrefijo.setText(r.cfg.prefijo); inAncho.setText(r.cfg.ancho.toString())
              // El servidor apaga a los anteriores recien con el PRIMER trabajo impreso de este equipo.
              txtEmparejar.text = Emparejamiento.textoExito(r)
              val i = Intent(this, PrintService::class.java)
              if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i) else startService(i)
              h.postDelayed({ refrescar() }, 500)
            }
            is CanjeResultado.Error -> txtEmparejar.text = r.mensaje
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
        val ancho = inAncho.text.toString().toIntOrNull() ?: 48
        Prefs.guardar(this, Cfg(
          inUrl.text.toString().trim(), inAnon.text.toString().trim(),
          inDevice.text.toString().trim(),
          inPrefijo.text.toString().trim().ifBlank { "komo" }, ancho
        ))
        if (Prefs.leer(this) == null) { estado.text = "Faltan datos: URL, clave y device"; return@setOnClickListener }
        val i = Intent(this, PrintService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i) else startService(i)
      }
      h.postDelayed({ refrescar() }, 500)
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) pedir(Manifest.permission.POST_NOTIFICATIONS)

    // ---- [F2] Impresion sin internet: emparejar equipos y buscar impresoras ----
    Motor.iniciar(this)
    val txtLan = findViewById<TextView>(R.id.txtLan)
    val txtPinLan = findViewById<TextView>(R.id.txtPinLan)
    val txtBuscar = findViewById<TextView>(R.id.txtBuscar)
    refrescarLan = {
      val ips = Red.ipsLocales()
      txtLan.text = when {
        !PrintService.activo -> "Arranca LevoPrint para recibir impresiones por la WiFi del local."
        PrintService.lanError != null -> "Red del local: " + PrintService.lanError
        ips.isEmpty() -> "Escuchando en este equipo (127.0.0.1:" + PrintService.PUERTO_LAN + "). Conecta la WiFi del local para los demas equipos."
        else -> "Escuchando en " + ips.joinToString(" · ") { "http://$it:" + PrintService.PUERTO_LAN } +
          " · " + Emparejador.equipos(this).size + " equipos emparejados"
      }
      val pin = Emparejador.pinVigente()
      txtPinLan.visibility = if (pin != null) android.view.View.VISIBLE else android.view.View.GONE
      txtPinLan.text = pin ?: ""
    }
    findViewById<Button>(R.id.btnPinLan).setOnClickListener {
      Emparejador.nuevoPin()
      txtBuscar.text = "En la app: Estaciones > LevoPrint en esta red > escribe este PIN (vence en 10 min, sirve una vez)."
      refrescarLan?.invoke()
    }
    findViewById<Button>(R.id.btnBuscar).setOnClickListener { b ->
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) pedir(Manifest.permission.BLUETOOTH_CONNECT)
      b.isEnabled = false
      txtBuscar.text = "Buscando en USB, Bluetooth y la red..."
      Thread {
        val l = try { Buscar.lista(this) } catch (e: Exception) { emptyList() }
        h.post {
          b.isEnabled = true
          txtBuscar.text = if (l.isEmpty()) "No se encontro ninguna. Revisa el cable OTG, el Bluetooth emparejado o que la impresora este en la misma WiFi." else l.size.toString() + " encontradas."
          if (l.isNotEmpty()) elegirHallazgo(l)
        }
      }.start()
    }
    // Abierta por enchufar una ticketera USB (USB_DEVICE_ATTACHED).
    if (intent?.action == android.hardware.usb.UsbManager.ACTION_USB_DEVICE_ATTACHED)
      txtBuscar.text = "Impresora USB conectada. Toca Buscar impresoras para asignarla a una estacion."

    // Arranque automático si ya hay configuración (tras reinicio/reapertura).
    // Si el servicio corre pero esta desactivado, abrir la app lo despierta
    // para reintentar al instante (onStartCommand).
    if (Prefs.leer(this) != null && (!PrintService.activo || PrintService.desactivado)) {
      val i = Intent(this, PrintService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i) else startService(i)
    }
    refrescar()
    tick = object : Runnable {
      override fun run() { log.text = PrintService.ultimoLog; refrescar(); refrescarLan?.invoke(); h.postDelayed(this, 1500) }
    }
    h.post(tick!!)
  }

  private var tick: Runnable? = null
  private var refrescarLan: (() -> Unit)? = null

  // [F2] Hallazgo de "Buscar impresoras": Probar o Asignar a una estacion con un toque.
  private fun elegirHallazgo(l: List<Buscar.Hallazgo>) {
    val nombres = l.map { it.nombre + "  ·  " + it.via + (if (it.ticketera) "" else " (¿impresora?)") }.toTypedArray()
    android.app.AlertDialog.Builder(this).setTitle("Impresoras encontradas").setItems(nombres) { _, i ->
      val hz = l[i]
      val ruta = Motor.Ruta(hz.transporte, hz.destino)
      val ests = Motor.estaciones.values.sortedBy { it.nombre }
      val opciones = arrayOf("Imprimir prueba") + ests.map { "Asignar a " + it.nombre }.toTypedArray()
      android.app.AlertDialog.Builder(this).setTitle(hz.nombre).setItems(opciones) { _, j ->
        val txt = findViewById<TextView>(R.id.txtBuscar)
        if (hz.transporte == "USB_ANDROID") Usb.pedirPermiso(this, hz.destino)
        if (j == 0) {
          txt.text = "Imprimiendo prueba en " + hz.nombre + "..."
          Thread {
            val ancho = Prefs.leer(this)?.ancho ?: 48
            val r = try { Motor.enviar(ruta, Agent.render(org.json.JSONObject().put("tipo", "PRUEBA").put("payload", org.json.JSONObject()), ancho)); "Prueba enviada a " + hz.nombre + "." }
              catch (e: Exception) { "No se pudo imprimir: " + e.message }
            h.post { txt.text = r }
          }.start()
        } else {
          val est = ests[j - 1]
          Motor.asignar(est.id, ruta)
          txt.text = "Listo: " + hz.nombre + " imprime para " + est.nombre + "."
          // Se avisa a la nube si hay internet (si no, queda en este equipo).
          Thread { try { Prefs.leer(this)?.let { Agent.asignar(it, est.id, ruta.transporte, ruta.destino) } } catch (_: Exception) {} }.start()
        }
      }.show()
    }.show()
  }
  override fun onDestroy() { tick?.let { h.removeCallbacks(it) }; super.onDestroy() }

  private fun pedir(p: String) {
    if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED)
      ActivityCompat.requestPermissions(this, arrayOf(p), 1)
  }
}
