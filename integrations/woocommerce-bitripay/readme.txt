=== BitriPay Payment Gateway for WooCommerce ===
Contributors: bitripay
Tags: payments, qr code, wallet, mobile money, card, gateway
Requires at least: 6.0
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.0.0
License: MIT

Accept QR code, wallet, card, mobile money and virtual card payments through BitriPay hosted checkout.

== Description ==
* Seamless integration: redirect-based hosted checkout, no card data touches your server (PCI SAQ-A).
* Multi-currency: charges the order currency; BitriPay handles conversion and settlement.
* QR code payments: the order-received page shows a scannable QR code while the order is pending.
* Fast checkout: customers with the BitriPay app pay in one scan; guests can pay by card or mobile money.
* Order tracking: signed webhooks update orders in real time; the return URL also verifies the payment.
* Subscription billing: WooCommerce Subscriptions renewals create a payment link and email the customer.
* Cart/Checkout blocks and HPOS compatible.

== Installation ==
1. Upload the `woocommerce-bitripay` folder to `/wp-content/plugins/` and activate it.
2. WooCommerce → Settings → Payments → BitriPay: enter your API URL and a merchant API key (sk_live_…).
3. In the BitriPay merchant dashboard → Payment gateway → Webhooks set the URL to `https://yourstore.com/?wc-api=bitripay` and paste the signing secret into the plugin settings.
4. Choose accepted methods, save, and place a test order using a sk_test_ key with the sandbox gateway.

== Changelog ==
= 1.0.0 =
* Initial release.
