<?php
if (!defined('ABSPATH')) {
    exit;
}

class WC_Gateway_BitriPay extends WC_Payment_Gateway
{
    public $api_url;
    public $api_key;
    public $webhook_secret;
    public $testmode;
    public $show_qr;
    public $accepted_methods;

    public function __construct()
    {
        $this->id                 = 'bitripay';
        $this->icon               = apply_filters('bitripay_icon', BITRIPAY_WC_URL . 'assets/icon.svg');
        $this->has_fields         = false;
        $this->method_title       = __('BitriPay', 'bitripay');
        $this->method_description = __('Accept BitriPay wallet, QR code, card, mobile money and virtual card payments through BitriPay hosted checkout.', 'bitripay');
        $this->supports           = array('products', 'refunds', 'subscriptions', 'subscription_cancellation', 'subscription_suspension', 'subscription_reactivation', 'subscription_amount_changes', 'subscription_date_changes', 'multiple_subscriptions');

        $this->init_form_fields();
        $this->init_settings();

        $this->title            = $this->get_option('title', __('BitriPay – QR, wallet, card & mobile money', 'bitripay'));
        $this->description      = $this->get_option('description');
        $this->enabled          = $this->get_option('enabled');
        $this->api_url          = $this->get_option('api_url');
        $this->api_key          = $this->get_option('api_key');
        $this->webhook_secret   = $this->get_option('webhook_secret');
        $this->testmode         = 'yes' === $this->get_option('testmode');
        $this->show_qr          = 'yes' === $this->get_option('show_qr', 'yes');
        $this->accepted_methods = $this->get_option('accepted_methods', array());

        add_action('woocommerce_update_options_payment_gateways_' . $this->id, array($this, 'process_admin_options'));
        add_action('woocommerce_thankyou_' . $this->id, array($this, 'thankyou_page'));
        add_action('woocommerce_scheduled_subscription_payment_' . $this->id, array($this, 'scheduled_subscription_payment'), 10, 2);
        add_action('woocommerce_api_bitripay_return', array($this, 'handle_return'));
    }

    public function init_form_fields()
    {
        $this->form_fields = array(
            'enabled'          => array('title' => __('Enable/Disable', 'bitripay'), 'type' => 'checkbox', 'label' => __('Enable BitriPay', 'bitripay'), 'default' => 'no'),
            'title'            => array('title' => __('Title', 'bitripay'), 'type' => 'text', 'description' => __('Shown to customers at checkout.', 'bitripay'), 'default' => __('BitriPay – QR, wallet, card & mobile money', 'bitripay')),
            'description'      => array('title' => __('Description', 'bitripay'), 'type' => 'textarea', 'default' => __('Pay securely with your BitriPay wallet, by scanning a QR code, or with a card, mobile money or virtual card.', 'bitripay')),
            'api_url'          => array('title' => __('BitriPay API URL', 'bitripay'), 'type' => 'text', 'description' => __('e.g. https://api.yourdomain.com (no trailing slash).', 'bitripay'), 'default' => 'https://api.bitripay.app'),
            'api_key'          => array('title' => __('Merchant API key', 'bitripay'), 'type' => 'password', 'description' => __('Create one in the BitriPay merchant dashboard → Payment gateway → API keys (bp_live_… or bp_test_…).', 'bitripay')),
            'webhook_secret'   => array('title' => __('Webhook signing secret', 'bitripay'), 'type' => 'password', 'description' => sprintf(__('From merchant dashboard → Webhooks. Set the webhook URL there to %s', 'bitripay'), '<code>' . esc_html(home_url('/?wc-api=bitripay')) . '</code>')),
            'testmode'         => array('title' => __('Test mode', 'bitripay'), 'type' => 'checkbox', 'label' => __('Use a bp_test_ key and show a test badge to customers', 'bitripay'), 'default' => 'no'),
            'show_qr'          => array('title' => __('QR code on order-received page', 'bitripay'), 'type' => 'checkbox', 'label' => __('Show a QR code the customer can scan with the BitriPay app while the order is pending', 'bitripay'), 'default' => 'yes'),
            'accepted_methods' => array('title' => __('Accepted methods', 'bitripay'), 'type' => 'multiselect', 'class' => 'wc-enhanced-select', 'options' => array('wallet' => 'BitriPay wallet / QR', 'card' => 'Card', 'mobile_money' => 'Mobile money', 'bank' => 'Bank transfer', 'virtual_card' => 'BitriPay virtual card'), 'description' => __('Leave empty to use the methods configured in your BitriPay gateway settings.', 'bitripay'), 'default' => array()),
            'expires'          => array('title' => __('Payment link expiry (minutes)', 'bitripay'), 'type' => 'number', 'default' => 1440),
        );
    }

    private function api()
    {
        return new BitriPay_API($this->api_url, $this->api_key);
    }

    public function is_available()
    {
        return parent::is_available() && !empty($this->api_key) && !empty($this->api_url);
    }

    public function process_payment($order_id)
    {
        $order = wc_get_order($order_id);
        $success_url = add_query_arg(array('order' => $order_id, 'key' => $order->get_order_key()), WC()->api_request_url('bitripay_return'));
        $cancel_url  = $order->get_cancel_order_url_raw();
        $result = $this->api()->create_payment_request(
            wc_format_decimal($order->get_total(), wc_get_price_decimals()),
            $order->get_currency(),
            sprintf(__('%s order #%s', 'bitripay'), get_bloginfo('name'), $order->get_order_number()),
            $success_url,
            $cancel_url,
            array('orderId' => $order_id, 'orderKey' => $order->get_order_key(), 'site' => home_url()),
            $order->get_billing_email(),
            (int) $this->get_option('expires', 1440)
        );
        if (is_wp_error($result)) {
            wc_add_notice(__('BitriPay error: ', 'bitripay') . $result->get_error_message(), 'error');
            return array('result' => 'failure');
        }
        $request = $result['paymentRequest'];
        $order->update_meta_data('_bitripay_code', $request['code']);
        $order->update_meta_data('_bitripay_checkout_url', $result['checkoutUrl']);
        $order->update_status('pending', __('Awaiting BitriPay payment.', 'bitripay'));
        $order->save();
        WC()->cart->empty_cart();
        return array('result' => 'success', 'redirect' => $result['checkoutUrl']);
    }

    /** Customer returns from hosted checkout – verify and complete if paid. */
    public function handle_return()
    {
        $order_id = isset($_GET['order']) ? absint($_GET['order']) : 0;
        $order = wc_get_order($order_id);
        if (!$order || !isset($_GET['key']) || $order->get_order_key() !== sanitize_text_field(wp_unslash($_GET['key']))) {
            wp_safe_redirect(wc_get_page_permalink('checkout'));
            exit;
        }
        $this->sync_order($order);
        wp_safe_redirect($order->get_checkout_order_received_url());
        exit;
    }

    /** Pull the payment request state from BitriPay and update the order (idempotent). */
    public function sync_order($order)
    {
        $code = $order->get_meta('_bitripay_code');
        if (!$code || $order->is_paid()) {
            return;
        }
        $result = $this->api()->get_payment_request($code);
        if (is_wp_error($result)) {
            return;
        }
        $this->apply_payment_request($order, $result['paymentRequest'], isset($result['transaction']) ? $result['transaction'] : null);
    }

    public function apply_payment_request($order, $request, $transaction = null)
    {
        if ($order->is_paid()) {
            return;
        }
        if ($request['status'] === 'paid') {
            $ref = $transaction ? $transaction['reference'] : $request['code'];
            $order->payment_complete($ref);
            $method = $transaction && isset($transaction['metadata']['method']) ? $transaction['metadata']['method'] : 'wallet';
            $order->add_order_note(sprintf(__('BitriPay payment received (%1$s) via %2$s. Reference %3$s.', 'bitripay'), $request['code'], $method, $ref));
        } elseif (in_array($request['status'], array('cancelled', 'expired', 'declined'), true) && $order->has_status('pending')) {
            $order->update_status('cancelled', sprintf(__('BitriPay payment request %s.', 'bitripay'), $request['status']));
        }
    }

    public function thankyou_page($order_id)
    {
        $order = wc_get_order($order_id);
        if (!$order || $order->is_paid()) {
            return;
        }
        $this->sync_order($order);
        if ($order->is_paid()) {
            return;
        }
        $url = $order->get_meta('_bitripay_checkout_url');
        echo '<section class="bitripay-pending"><h2>' . esc_html__('Complete your BitriPay payment', 'bitripay') . '</h2>';
        if ($this->show_qr && $url) {
            $qr = rtrim($this->api_url, '/') . '/api/qr/image.svg?data=' . rawurlencode($url);
            echo '<p>' . esc_html__('Scan this QR code with the BitriPay app or open the payment page.', 'bitripay') . '</p>';
            echo '<img src="' . esc_url($qr) . '" alt="BitriPay QR" style="max-width:220px;background:#fff;padding:10px;border-radius:12px" />';
        }
        if ($url) {
            echo '<p><a class="button" href="' . esc_url($url) . '">' . esc_html__('Open BitriPay checkout', 'bitripay') . '</a></p>';
        }
        echo '</section>';
    }

    public function process_refund($order_id, $amount = null, $reason = '')
    {
        return new WP_Error('bitripay_refund', __('Refund this payment from the BitriPay merchant dashboard (Transactions → Refund). The order will be updated automatically.', 'bitripay'));
    }

    /**
     * WooCommerce Subscriptions renewal: BitriPay payments are customer-initiated, so a renewal creates a new
     * payment request and emails the customer a pay link; the order completes when they pay (or via webhook).
     */
    public function scheduled_subscription_payment($amount, $renewal_order)
    {
        $result = $this->api()->create_payment_request(
            wc_format_decimal($amount, wc_get_price_decimals()),
            $renewal_order->get_currency(),
            sprintf(__('%s subscription renewal #%s', 'bitripay'), get_bloginfo('name'), $renewal_order->get_order_number()),
            $renewal_order->get_checkout_order_received_url(),
            $renewal_order->get_cancel_order_url_raw(),
            array('orderId' => $renewal_order->get_id(), 'orderKey' => $renewal_order->get_order_key(), 'renewal' => true),
            $renewal_order->get_billing_email(),
            (int) $this->get_option('expires', 1440)
        );
        if (is_wp_error($result)) {
            $renewal_order->update_status('failed', 'BitriPay: ' . $result->get_error_message());
            return;
        }
        $renewal_order->update_meta_data('_bitripay_code', $result['paymentRequest']['code']);
        $renewal_order->update_meta_data('_bitripay_checkout_url', $result['checkoutUrl']);
        $renewal_order->update_status('pending', __('Renewal payment link sent to customer via BitriPay.', 'bitripay'));
        $renewal_order->save();
        $mailer = WC()->mailer();
        $mailer->send(
            $renewal_order->get_billing_email(),
            sprintf(__('Renewal payment for order #%s', 'bitripay'), $renewal_order->get_order_number()),
            $mailer->wrap_message(__('Complete your renewal', 'bitripay'), sprintf(__('Please pay your subscription renewal here: %s', 'bitripay'), $result['checkoutUrl']))
        );
    }
}
