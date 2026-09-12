/**
 * Expo config plugin for the BitriPay SMS receiver.
 *  - declares the SMS / phone-state permissions the payout device needs
 *  - registers the static SMS_RECEIVED broadcast receiver so confirmations are captured even while the app is closed
 *  - registers the boot receiver so capture resumes after a reboot
 */
const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins');

const PERMISSIONS = ['android.permission.RECEIVE_SMS', 'android.permission.READ_SMS', 'android.permission.READ_PHONE_STATE', 'android.permission.READ_PHONE_NUMBERS', 'android.permission.CALL_PHONE', 'android.permission.RECEIVE_BOOT_COMPLETED', 'android.permission.POST_NOTIFICATIONS'];

function ensureReceiver(app, name, actions, extra = {}) {
  app.receiver = app.receiver || [];
  if (app.receiver.some((r) => r.$['android:name'] === name)) return;
  app.receiver.push({
    $: { 'android:name': name, 'android:exported': 'true', ...extra },
    'intent-filter': [{ $: { 'android:priority': '999' }, action: actions.map((a) => ({ $: { 'android:name': a } })) }],
  });
}

module.exports = function withSmsReceiver(config) {
  config = AndroidConfig.Permissions.withPermissions(config, PERMISSIONS);
  return withAndroidManifest(config, (mod) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    ensureReceiver(app, 'com.bitripay.smsreceiver.SmsBroadcastReceiver', ['android.provider.Telephony.SMS_RECEIVED'], { 'android:permission': 'android.permission.BROADCAST_SMS' });
    ensureReceiver(app, 'com.bitripay.smsreceiver.BootReceiver', ['android.intent.action.BOOT_COMPLETED']);
    return mod;
  });
};
