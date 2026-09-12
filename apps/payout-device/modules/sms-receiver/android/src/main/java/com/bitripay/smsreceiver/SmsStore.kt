package com.bitripay.smsreceiver

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Durable queue of received SMS shared between the static broadcast receiver (which may run while the
 * JS side is not alive) and the module. Messages stay until the JS side acknowledges them, so a
 * confirmation that arrives while the app is closed is still forwarded on the next start.
 */
object SmsStore {
  private const val PREFS = "bitripay_sms_receiver"
  private const val KEY_PENDING = "pending"
  private const val MAX_PENDING = 500

  @Synchronized
  fun push(context: Context, message: JSONObject) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val arr = JSONArray(prefs.getString(KEY_PENDING, "[]") ?: "[]")
    arr.put(message)
    val trimmed = if (arr.length() > MAX_PENDING) JSONArray().also { t -> for (i in arr.length() - MAX_PENDING until arr.length()) t.put(arr.get(i)) } else arr
    prefs.edit().putString(KEY_PENDING, trimmed.toString()).apply()
  }

  @Synchronized
  fun drain(context: Context): List<JSONObject> {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val arr = JSONArray(prefs.getString(KEY_PENDING, "[]") ?: "[]")
    val out = ArrayList<JSONObject>(arr.length())
    for (i in 0 until arr.length()) out.add(arr.getJSONObject(i))
    return out
  }

  @Synchronized
  fun acknowledge(context: Context, ids: Set<String>) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val arr = JSONArray(prefs.getString(KEY_PENDING, "[]") ?: "[]")
    val keep = JSONArray()
    for (i in 0 until arr.length()) {
      val m = arr.getJSONObject(i)
      if (!ids.contains(m.optString("id"))) keep.put(m)
    }
    prefs.edit().putString(KEY_PENDING, keep.toString()).apply()
  }
}
