package com.monetiser.pos

import android.content.Context

/** Sesión guardada en preferencias PRIVADAS de la app (no exportables: allowBackup=false). */
class Session(context: Context) {
    private val prefs = context.getSharedPreferences("monetiser_pos", Context.MODE_PRIVATE)

    var server: String
        get() = prefs.getString("server", null) ?: BuildConfig.DEFAULT_SERVER
        set(v) = prefs.edit().putString("server", v).apply()
    var token: String?
        get() = prefs.getString("token", null)
        set(v) = prefs.edit().putString("token", v).apply()
    var merchantName: String
        get() = prefs.getString("merchantName", "") ?: ""
        set(v) = prefs.edit().putString("merchantName", v).apply()
    var storeName: String
        get() = prefs.getString("storeName", "") ?: ""
        set(v) = prefs.edit().putString("storeName", v).apply()
    var environment: String
        get() = prefs.getString("environment", "") ?: ""
        set(v) = prefs.edit().putString("environment", v).apply()
    var currency: String
        get() = prefs.getString("currency", "EUR") ?: "EUR"
        set(v) = prefs.edit().putString("currency", v).apply()

    fun api(): Api = Api(server, token)

    fun clear() {
        prefs.edit().remove("token").remove("merchantName").remove("storeName").apply()
    }
}
