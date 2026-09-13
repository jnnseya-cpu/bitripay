package com.bitripay.smsreceiver

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

/**
 * JS bridge. Events: `onSms` { id, from, text, receivedAt, subscriptionId, simSlot, timestampMillis }.
 * Functions: drainPending() → messages captured while JS was not alive; acknowledge(ids) → drop them once
 * they are safely queued/forwarded on the JS side; getSimInfo() → SIM identities for enrolment checks;
 * hasPermissions().
 */
class SmsReceiverModule : Module() {
  companion object {
    @Volatile private var instance: SmsReceiverModule? = null

    fun emit(message: JSONObject) {
      val m = instance ?: return
      try {
        m.sendEvent("onSms", toMap(message))
      } catch (_: Throwable) {
        // JS not listening; the message stays in SmsStore until drained.
      }
    }

    fun toMap(json: JSONObject): Map<String, Any?> = mapOf(
      "id" to json.optString("id"),
      "from" to json.optString("from"),
      "text" to json.optString("text"),
      "receivedAt" to json.optLong("receivedAt"),
      "subscriptionId" to json.optInt("subscriptionId", -1),
      "simSlot" to json.optInt("simSlot", -1),
      "timestampMillis" to json.optLong("timestampMillis"),
    )
  }

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("No React context")

  override fun definition() = ModuleDefinition {
    Name("SmsReceiver")
    Events("onSms")

    OnCreate { instance = this@SmsReceiverModule }
    OnDestroy { if (instance === this@SmsReceiverModule) instance = null }

    Function("hasPermissions") {
      listOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_PHONE_STATE).all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }
    }

    Function("drainPending") {
      SmsStore.drain(context).map { toMap(it) }
    }

    Function("acknowledge") { ids: List<String> ->
      SmsStore.acknowledge(context, ids.toSet())
      null
    }

    Function("getSimInfo") {
      val out = ArrayList<Map<String, Any?>>()
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) return@Function out
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
        val sm = context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as SubscriptionManager
        val subs = try { sm.activeSubscriptionInfoList } catch (_: SecurityException) { null } ?: emptyList()
        for (s in subs) {
          val number = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) sm.getPhoneNumber(s.subscriptionId) else @Suppress("DEPRECATION") s.number
          } catch (_: SecurityException) { null }
          out.add(mapOf(
            "subscriptionId" to s.subscriptionId,
            "simSlot" to s.simSlotIndex,
            "carrier" to s.carrierName?.toString(),
            "displayName" to s.displayName?.toString(),
            "iccid" to (try { s.iccId } catch (_: SecurityException) { null }),
            "msisdn" to number?.takeIf { it.isNotBlank() },
            "countryIso" to s.countryIso,
          ))
        }
      } else {
        val tm = context.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
        out.add(mapOf("subscriptionId" to -1, "simSlot" to 0, "carrier" to tm.networkOperatorName, "displayName" to tm.simOperatorName, "iccid" to (try { @Suppress("DEPRECATION") tm.simSerialNumber } catch (_: SecurityException) { null }), "msisdn" to (try { @Suppress("DEPRECATION") tm.line1Number } catch (_: SecurityException) { null }), "countryIso" to tm.simCountryIso))
      }
      out
    }
  }
}
