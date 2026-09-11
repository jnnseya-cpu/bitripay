<?php
if (!defined('ABSPATH')) {
    exit;
}

/**
 * Thin client for the BitriPay merchant API (v1).
 */
class BitriPay_API
{
    private $api_url;
    private $api_key;

    public function __construct($api_url, $api_key)
    {
        $this->api_url = rtrim($api_url, '/');
        $this->api_key = $api_key;
    }

    private function request($method, $path, $body = null)
    {
        $args = array(
            'method'  => $method,
            'timeout' => 30,
            'headers' => array(
                'Authorization' => 'Bearer ' . $this->api_key,
                'Content-Type'  => 'application/json',
                'User-Agent'    => 'BitriPay-WooCommerce/' . BITRIPAY_WC_VERSION,
            ),
        );
        if ($body !== null) {
            $args['body'] = wp_json_encode($body);
        }
        $response = wp_remote_request($this->api_url . $path, $args);
        if (is_wp_error($response)) {
            return new WP_Error('bitripay_http', $response->get_error_message());
        }
        $code = wp_remote_retrieve_response_code($response);
        $json = json_decode(wp_remote_retrieve_body($response), true);
        if ($code < 200 || $code >= 300) {
            $message = isset($json['error']['message']) ? $json['error']['message'] : 'BitriPay API error (' . $code . ')';
            return new WP_Error('bitripay_api', $message, $json);
        }
        return $json;
    }

    /** Create a hosted checkout payment request for an order. Amount as decimal string, currency ISO code. */
    public function create_payment_request($amount, $currency, $description, $success_url, $cancel_url, $metadata = array(), $customer_email = null, $expires_minutes = 1440)
    {
        return $this->request('POST', '/v1/payment-requests', array(
            'amount'           => (string) $amount,
            'currency'         => $currency,
            'description'      => $description,
            'successUrl'       => $success_url,
            'cancelUrl'        => $cancel_url,
            'metadata'         => $metadata,
            'customerEmail'    => $customer_email,
            'expiresInMinutes' => (int) $expires_minutes,
        ));
    }

    public function get_payment_request($code)
    {
        return $this->request('GET', '/v1/payment-requests/' . rawurlencode($code));
    }

    public function cancel_payment_request($code)
    {
        return $this->request('POST', '/v1/payment-requests/' . rawurlencode($code) . '/cancel');
    }

    public function me()
    {
        return $this->request('GET', '/v1/me');
    }
}
