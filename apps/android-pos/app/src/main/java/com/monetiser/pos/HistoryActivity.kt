package com.monetiser.pos

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.widget.LinearLayout
import android.widget.ScrollView

/** Historial de HOY de esta tienda, con el total cobrado. */
class HistoryActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val session = Session(this)
        val col = Ui.column(this)
        col.addView(Ui.text(this, "Cobros de hoy", 24f, bold = true, color = Color.BLACK))
        val total = Ui.text(this, "Cargando…", 18f, bold = true)
        col.addView(total)
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        col.addView(list)
        col.addView(Ui.ghostButton(this, "Volver") { finish() })
        setContentView(ScrollView(this).apply { addView(col) })

        Ui.background(this, { session.api().request("GET", "/pos/payments") }) { res ->
            val r = res.getOrElse { total.text = Ui.networkMessage(it); return@background }
            if (!r.ok) { total.text = "No se pudo cargar (${r.error})."; return@background }
            val t = r.body.optJSONObject("totals")
            total.text = "Cobrado: ${Money.format(t?.optLong("amount") ?: 0, session.currency)} (${t?.optInt("count") ?: 0} cobros)"
            val arr = r.body.optJSONArray("payments")
            val labels = mapOf("paid" to "Pagado", "pending" to "Pendiente", "failed" to "Fallido", "expired" to "Caducado", "cancelled" to "Anulado")
            for (i in 0 until (arr?.length() ?: 0)) {
                val p = arr!!.getJSONObject(i)
                val time = p.optString("createdAt").let { if (it.length >= 16) it.substring(11, 16) + " UTC" else it }
                val state = p.optString("state")
                val color = when (state) { "paid" -> Ui.OK; "failed" -> Ui.BAD; "pending" -> Ui.BRAND; else -> Ui.WARN }
                list.addView(Ui.text(this, "$time · ${Money.format(p.optLong("amount"), p.optString("currency", "EUR"))} · ${labels[state] ?: state}\n${p.optString("concept")}", 15f, color = color))
            }
            if ((arr?.length() ?: 0) == 0) list.addView(Ui.text(this, "Todavía no hay cobros hoy.", 15f))
        }
    }
}
