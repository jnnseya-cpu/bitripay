package com.bitripay.smsreceiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.telephony.SmsMessage
import org.json.JSONObject
import java.util.UUID

/**
 * Static receiver for android.provider.Telephony.SMS_RECEIVED. Multipart messages are re-assembled
 * (the PDUs of one message share the originating address and arrive in one broadcast). Every message is
 * stored durably and, if the module is alive, emitted to JS immediately.
 *
 * The receiver never reads the SMS inbox: only messages received after installation are seen, and only
 * the ones the JS side keeps (operator sender ids) are ever forwarded.
 */
class SmsBroadcastReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
    val messages: Array<SmsMessage> = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
    if (messages.isEmpty()) return
    val from = messages[0].displayOriginatingAddress ?: messages[0].originatingAddress ?: ""
    val body = StringBuilder()
    for (m in messages) body.append(m.displayMessageBody ?: m.messageBody ?: "")
    val receivedAt = System.currentTimeMillis()
    val subId = intent.extras?.getInt("subscription", -1) ?: -1
    val slot = intent.extras?.getInt("slot", -1) ?: intent.extras?.getInt("phone", -1) ?: -1
    val json = JSONObject()
      .put("id", UUID.randomUUID().toString())
      .put("from", from)
      .put("text", body.toString())
      .put("receivedAt", receivedAt)
      .put("subscriptionId", subId)
      .put("simSlot", slot)
      .put("timestampMillis", messages[0].timestampMillis)
    SmsStore.push(context, json)
    SmsReceiverModule.emit(json)
  }
}

/** Nothing to start on boot – the static SMS receiver is registered by the manifest – but the entry keeps capture explicit after reboots. */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
      // Messages received from now on are captured by SmsBroadcastReceiver; nothing else to do.
    }
  }
}
