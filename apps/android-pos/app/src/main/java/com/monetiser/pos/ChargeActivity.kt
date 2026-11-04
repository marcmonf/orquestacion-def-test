package com.monetiser.pos

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject

/** Teclado de importe + concepto → "Cobrar" crea el cobro con QR. */
class ChargeActivity : Activity() {
    private lateinit var session: Session
    private var cents: Long = 0
    private lateinit var amountView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        session = Session(this)
        val col = Ui.column(this)
        val header = buildString {
            append(session.merchantName.ifEmpty { "Comercio" })
            if (session.storeName.isNotEmpty()) append(" · ").append(session.storeName)
        }
        col.addView(Ui.text(this, header, 15f, bold = true))
        if (session.environment == "sandbox") col.addView(Ui.text(this, "MODO PRUEBAS (sandbox): no se cobra dinero real", 13f, color = Ui.WARN, bold = true))

        amountView = Ui.text(this, Money.format(0, session.currency), 44f, bold = true, color = Color.BLACK, center = true)
        col.addView(amountView)
        val concept = EditText(this).apply { hint = "Concepto (lo verá el cliente)"; setSingleLine(true) }
        col.addView(concept)

        val grid = GridLayout(this).apply { columnCount = 3 }
        val keys = listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫")
        for (k in keys) {
            grid.addView(Button(this).apply {
                text = k; textSize = 24f; isAllCaps = false
                setOnClickListener { press(k) }
                layoutParams = GridLayout.LayoutParams().apply {
                    width = 0; height = Ui.dp(this@ChargeActivity, 64)
                    columnSpec = GridLayout.spec(GridLayout.UNDEFINED, 1f)
                }
            })
        }
        col.addView(grid)
        val status = Ui.text(this, "", 15f, color = Ui.BAD, center = true)
        val charge = Ui.button(this, "Cobrar con QR") {}
        charge.setOnClickListener {
            val c = concept.text.toString().trim()
            if (cents < 1) { status.text = "Teclea el importe."; return@setOnClickListener }
            if (c.isEmpty()) { status.text = "Escribe el concepto."; return@setOnClickListener }
            charge.isEnabled = false; status.text = ""
            Ui.background(this, { session.api().request("POST", "/pos/payments", JSONObject().put("amount", cents).put("concept", c).put("currency", session.currency)) }) { res ->
                charge.isEnabled = true
                val r = res.getOrElse { status.text = Ui.networkMessage(it); return@background }
                if (!r.ok) { status.text = "No se pudo crear el cobro (${r.error})."; return@background }
                val p = r.body.getJSONObject("payment")
                startActivity(Intent(this, QrActivity::class.java).putExtra("payment", p.toString()))
                cents = 0; refresh(); concept.setText("")
            }
        }
        col.addView(charge); col.addView(status)

        val bottom = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
        col.addView(Ui.ghostButton(this, "Cobros de hoy") { startActivity(Intent(this, HistoryActivity::class.java)) })
        col.addView(Ui.ghostButton(this, "Salir") {
            session.clear()
            startActivity(Intent(this, LoginActivity::class.java)); finish()
        })
        col.addView(bottom)
        setContentView(android.widget.ScrollView(this).apply { addView(col) })
    }

    private fun press(k: String) {
        cents = when (k) {
            "C" -> 0
            "⌫" -> cents / 10
            else -> if (cents >= 10_000_000) cents else cents * 10 + k.toLong()   // tope 100.000,00
        }
        refresh()
    }

    private fun refresh() { amountView.text = Money.format(cents, session.currency) }
}
