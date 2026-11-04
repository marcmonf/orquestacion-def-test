package com.monetiser.pos

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.util.concurrent.Executors

/** Utilidades de interfaz (vistas hechas en código: sin librerías). */
object Ui {
    const val BRAND = 0xFF5B4FCF.toInt()
    const val OK = 0xFF1F8A4C.toInt()
    const val BAD = 0xFFC53030.toInt()
    const val WARN = 0xFFB7791F.toInt()
    private val io = Executors.newCachedThreadPool()

    fun dp(a: Activity, v: Int): Int = (v * a.resources.displayMetrics.density).toInt()

    fun column(a: Activity): LinearLayout = LinearLayout(a).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(a, 20), dp(a, 20), dp(a, 20), dp(a, 20))
        setBackgroundColor(Color.WHITE)
    }

    fun text(a: Activity, s: String, sizeSp: Float = 16f, bold: Boolean = false, color: Int = Color.DKGRAY, center: Boolean = false): TextView =
        TextView(a).apply {
            text = s
            textSize = sizeSp
            setTextColor(color)
            if (bold) setTypeface(typeface, Typeface.BOLD)
            if (center) gravity = Gravity.CENTER
            setPadding(0, dp(a, 4), 0, dp(a, 4))
        }

    fun button(a: Activity, label: String, color: Int = BRAND, onClick: () -> Unit): Button = Button(a).apply {
        text = label
        textSize = 18f
        setTextColor(Color.WHITE)
        isAllCaps = false
        background = GradientDrawable().apply { cornerRadius = dp(a, 10).toFloat(); setColor(color) }
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(a, 56)).apply { topMargin = dp(a, 10) }
    }

    fun ghostButton(a: Activity, label: String, onClick: () -> Unit): Button = Button(a).apply {
        text = label
        isAllCaps = false
        setTextColor(BRAND)
        background = GradientDrawable().apply { cornerRadius = dp(a, 10).toFloat(); setStroke(dp(a, 1), BRAND); setColor(Color.WHITE) }
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(a, 48)).apply { topMargin = dp(a, 8) }
    }

    /** Trabajo de red fuera del hilo de la interfaz; el resultado vuelve al hilo principal. */
    fun <T> background(a: Activity, work: () -> T, done: (Result<T>) -> Unit) {
        io.execute {
            val r = runCatching(work)
            a.runOnUiThread {
                if (a.isFinishing) return@runOnUiThread
                val err = r.exceptionOrNull()
                if (err is Api.SessionExpired) {
                    Session(a).clear()
                    a.startActivity(Intent(a, LoginActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                        .putExtra("message", "Tu sesión ha caducado. Entra de nuevo."))
                    a.finish()
                } else done(r)
            }
        }
    }

    fun networkMessage(e: Throwable?): String = when (e) {
        null -> ""
        is java.net.UnknownHostException, is java.net.ConnectException -> "Sin conexión con Monetiser. Revisa la red."
        is java.net.SocketTimeoutException -> "Monetiser no responde. Inténtalo otra vez."
        else -> "Error: ${e.javaClass.simpleName}"
    }

    fun gone(v: View) { v.visibility = View.GONE }
}
