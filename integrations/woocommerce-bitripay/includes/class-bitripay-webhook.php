<?php
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Receives signed webhooks from BitriPay at /?wc-api=bitripay and updates orders in real time.
 * Signature header: X-BitriPay-Signature: t=<unix seconds>,v1=<hex hmac-sha256("{t}.{rawBody}", webhook secret)>
 * Deliveries older than 5 minutes are rejected and every X-BitriPay-Delivery-Id is processed at most once.
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
            if (!self::verify_signature($raw, $signature, $gateway->webhook_secret)) {
                status_header(401);
                echo 'invalid signature';
                exit;
            }
        }
        $delivery_id = isset($_SERVER['HTTP_X_BITRIPAY_DELIVERY_ID']) ? sanitize_text_field($_SERVER['HTTP_X_BITRIPAY_DELIVERY_ID']) : '';
        if ($delivery_id) {
            $seen_key = 'bitripay_delivery_' . md5($delivery_id);
            if (get_transient($seen_key)) {
                status_header(200);
                echo 'duplicate ignored';
                exit;
            }
            set_transient($seen_key, 1, DAY_IN_SECONDS);
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

    /** Accepts the timestamped v1 scheme and rejects stale deliveries (replay protection). */
    public static function verify_signature($raw, $header, $secret, $tolerance = 300)
    {
        $parts = array();
        foreach (explode(',', (string) $header) as $kv) {
            $pair = explode('=', $kv, 2);
            if (count($pair) === 2) {
                $parts[trim($pair[0])] = trim($pair[1]);
            }
        }
        if (empty($parts['t']) || empty($parts['v1'])) {
            return false;
        }
        if (abs(time() - (int) $parts['t']) > $tolerance) {
            return false;
        }
        $expected = hash_hmac('sha256', $parts['t'] . '.' . $raw, $secret);
        return hash_equals($expected, $parts['v1']);
    }
}
