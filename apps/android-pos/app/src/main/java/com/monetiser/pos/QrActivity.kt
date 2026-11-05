package com.monetiser.pos

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import android.widget.ImageView
import android.widget.LinearLayout
import org.json.JSONObject

/**
 * QR grande para que el cliente pague con su móvil, y consulta del estado cada
 * 3 s hasta Pagado / Fallido / Caducado / Anulado.
 */
class QrActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var session: Session
    private lateinit var payment: JSONObject
    private var stopped = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        session = Session(this)
        payment = JSONObject(intent.getStringExtra("payment") ?: "{}")
        val col = Ui.column(this)
        col.addView(Ui.text(this, Money.format(payment.optLong("amount"), payment.optString("currency", "EUR")), 36f, bold = true, color = Color.BLACK, center = true))
        col.addView(Ui.text(this, payment.optString("concept"), 16f, center = true))
        val qr = ImageView(this).apply {
            adjustViewBounds = true
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        }
        col.addView(qr)
        val info = Ui.text(this, "Escanea con la cámara del móvil para pagar", 15f, center = true)
        col.addView(info)
        col.addView(Ui.ghostButton(this, "Anular cobro") { cancel(info) })
        setContentView(android.widget.ScrollView(this).apply { addView(col) })

        val url = payment.optString("qrPngUrl")
        Ui.background(this, { session.api().bitmap(url) }) { res ->
            val bmp = res.getOrNull()
            if (bmp != null) qr.setImageBitmap(bmp) else info.text = "No se pudo cargar el QR. Enlace: ${payment.optString("url")}"
        }
        poll()
    }

    private fun poll() {
        if (stopped) return
        val id = payment.optString("id")
        Ui.background(this, { session.api().request("GET", "/pos/payments/$id") }) { res ->
            val r = res.getOrNull()
            val state = r?.body?.optJSONObject("payment")?.optString("state")
            when (state) {
                "paid", "failed", "expired", "cancelled" -> showResult(state)
                else -> handler.postDelayed({ poll() }, 3000)
            }
        }
    }

    private fun cancel(info: android.widget.TextView) {
        Ui.background(this, { session.api().request("POST", "/pos/payments/${payment.optString("id")}/cancel") }) { res ->
            val r = res.getOrNull()
            when {
                r == null -> info.text = Ui.networkMessage(res.exceptionOrNull())
                r.ok -> showResult("cancelled")
                r.error == "already_paid" -> showResult("paid")
                r.error == "payment_in_progress" -> info.text = "El cliente está pagando ahora mismo: espera al resultado."
                else -> info.text = "No se pudo anular (${r.error})."
            }
        }
    }

    private fun showResult(state: String) {
        if (stopped) return
        stopped = true
        startActivity(Intent(this, ResultActivity::class.java).putExtra("state", state).putExtra("payment", payment.toString()))
        finish()
    }

    override fun onDestroy() {
        stopped = true
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }
}
