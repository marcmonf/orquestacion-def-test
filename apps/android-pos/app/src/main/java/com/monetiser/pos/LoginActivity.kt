package com.monetiser.pos

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.text.InputType
import android.widget.EditText
import android.widget.ScrollView
import org.json.JSONObject

/**
 * Login con el usuario del PORTAL del comercio (no con la clave de la API).
 * El usuario tiene que estar ligado a una tienda (portal → Usuarios) y ser
 * Operador o Administrador.
 */
class LoginActivity : Activity() {
    private lateinit var session: Session

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        session = Session(this)
        if (session.token != null) { openCharge(); return }

        val col = Ui.column(this)
        col.addView(Ui.text(this, "Monetiser POS", 28f, bold = true, color = Ui.BRAND))
        col.addView(Ui.text(this, "Entra con tu usuario del portal del comercio.", 15f))
        intent.getStringExtra("message")?.let { col.addView(Ui.text(this, it, 15f, color = Ui.BAD)) }

        val email = EditText(this).apply { hint = "Email"; inputType = InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS or InputType.TYPE_CLASS_TEXT }
        val pass = EditText(this).apply { hint = "Contraseña"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        val server = EditText(this).apply { hint = "Servidor"; setText(session.server); inputType = InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_CLASS_TEXT }
        val status = Ui.text(this, "", 15f, color = Ui.BAD)
        col.addView(email); col.addView(pass)
        col.addView(Ui.text(this, "Servidor de Monetiser", 13f)); col.addView(server)

        val login = Ui.button(this, "Entrar") {}
        login.setOnClickListener {
            val url = server.text.toString().trim().trimEnd('/')
            if (!url.startsWith("https://")) { status.text = "El servidor tiene que empezar por https://"; return@setOnClickListener }
            val e = email.text.toString().trim(); val p = pass.text.toString()
            if (e.isEmpty() || p.isEmpty()) { status.text = "Escribe email y contraseña."; return@setOnClickListener }
            login.isEnabled = false; status.setTextColor(Ui.BRAND); status.text = "Entrando…"
            Ui.background<Pair<Api.Response, Api.Response?>>(this, {
                val r = Api(url, null).request("POST", "/portal/auth/login", JSONObject().put("email", e).put("password", p))
                if (!r.ok) {
                    Pair(r, null)
                } else {
                    val me = Api(url, r.body.optString("token")).request("GET", "/pos/me")
                    Pair(r, me)
                }
            }) { res ->
                login.isEnabled = true; status.setTextColor(Ui.BAD)
                val (r, me) = res.getOrElse { status.text = Ui.networkMessage(it); return@background }
                when {
                    !r.ok && r.error == "invalid_credentials" -> status.text = "Email o contraseña incorrectos."
                    !r.ok && r.status == 429 -> status.text = "Demasiados intentos. Espera unos minutos."
                    !r.ok -> status.text = "No se pudo entrar (${r.error})."
                    r.body.optBoolean("mustChangePassword") -> status.text = "Primero cambia tu contraseña en el portal web."
                    me == null -> status.text = "No se pudo entrar."
                    me.error == "pos_user_without_store" -> status.text = "Tu usuario no está ligado a ninguna tienda. Pídeselo al administrador del portal."
                    me.error == "insufficient_permissions" -> status.text = "Tu usuario es de solo lectura: hace falta Operador."
                    !me.ok -> status.text = "No se pudo entrar (${me.error})."
                    else -> {
                        session.server = url
                        session.token = r.body.optString("token")
                        session.merchantName = me.body.optJSONObject("merchant")?.optString("name") ?: ""
                        session.storeName = me.body.optJSONObject("store")?.optString("name") ?: ""
                        session.environment = me.body.optString("environment")
                        session.currency = me.body.optString("currency", "EUR")
                        openCharge()
                    }
                }
            }
        }
        col.addView(login); col.addView(status)
        setContentView(ScrollView(this).apply { addView(col) })
    }

    private fun openCharge() {
        startActivity(Intent(this, ChargeActivity::class.java))
        finish()
    }
}
