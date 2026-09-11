<?php
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Receives signed webhooks from BitriPay at /?wc-api=bitripay and updates orders in real time.
 * Signature header: X-BitriPay-Signature: sha256=<hex hmac-sha256 of raw body using the merchant webhook secret>
 */
class BitriPay_Webhook
{
    public static function init()
    {
        add_action('woocommerce_api_bitripay', array(__CLASS__, 'handle'));
    }

    public static function handle()
    {
        $gateway = new WC_Gateway_BitriPay();
        $raw = file_get_contents('php://input');
        $signature = isset($_SERVER['HTTP_X_BITRIPAY_SIGNATURE']) ? $_SERVER['HTTP_X_BITRIPAY_SIGNATURE'] : '';
        if (!empty($gateway->webhook_secret)) {
            $expected = 'sha256=' . hash_hmac('sha256', $raw, $gateway->webhook_secret);
            if (!hash_equals($expected, $signature)) {
                status_header(401);
                echo 'invalid signature';
                exit;
            }
        }
        $payload = json_decode($raw, true);
        if (!$payload || empty($payload['event'])) {
            status_header(400);
            echo 'bad payload';
            exit;
        }
        if ($payload['event'] === 'payment.completed' && !empty($payload['data']['paymentRequest'])) {
            $request = $payload['data']['paymentRequest'];
            $order_id = isset($request['metadata']['orderId']) ? absint($request['metadata']['orderId']) : 0;
            $order = $order_id ? wc_get_order($order_id) : null;
            if ($order && $order->get_meta('_bitripay_code') === $request['code']) {
                $gateway->apply_payment_request($order, $request, isset($payload['data']['transaction']) ? $payload['data']['transaction'] : null);
            }
        }
        status_header(200);
        echo 'ok';
        exit;
    }
}
