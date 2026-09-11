<?php
/**
 * Plugin Name: BitriPay Payment Gateway for WooCommerce
 * Plugin URI:  https://github.com/jnnseya-cpu/bitripay
 * Description: Accept BitriPay wallet, QR code, card, mobile money and virtual card payments in WooCommerce through BitriPay hosted checkout. Supports order tracking, refunds and WooCommerce Subscriptions renewals.
 * Version:     1.0.0
 * Author:      BitriPay
 * Text Domain: bitripay
 * Domain Path: /languages
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * WC requires at least: 7.0
 * WC tested up to: 9.5
 * License: MIT
 */

if (!defined('ABSPATH')) {
    exit;
}

define('BITRIPAY_WC_VERSION', '1.0.0');
define('BITRIPAY_WC_PATH', plugin_dir_path(__FILE__));
define('BITRIPAY_WC_URL', plugin_dir_url(__FILE__));

add_action('plugins_loaded', function () {
    if (!class_exists('WC_Payment_Gateway')) {
        add_action('admin_notices', function () {
            echo '<div class="notice notice-error"><p>' . esc_html__('BitriPay Payment Gateway requires WooCommerce to be installed and active.', 'bitripay') . '</p></div>';
        });
        return;
    }
    load_plugin_textdomain('bitripay', false, dirname(plugin_basename(__FILE__)) . '/languages');
    require_once BITRIPAY_WC_PATH . 'includes/class-bitripay-api.php';
    require_once BITRIPAY_WC_PATH . 'includes/class-wc-gateway-bitripay.php';
    require_once BITRIPAY_WC_PATH . 'includes/class-bitripay-webhook.php';
    require_once BITRIPAY_WC_PATH . 'includes/class-bitripay-blocks.php';

    add_filter('woocommerce_payment_gateways', function ($gateways) {
        $gateways[] = 'WC_Gateway_BitriPay';
        return $gateways;
    });
    BitriPay_Webhook::init();
});

// Declare compatibility with HPOS and cart/checkout blocks.
add_action('before_woocommerce_init', function () {
    if (class_exists('\Automattic\WooCommerce\Utilities\FeaturesUtil')) {
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('custom_order_tables', __FILE__, true);
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('cart_checkout_blocks', __FILE__, true);
    }
});

add_action('woocommerce_blocks_loaded', function () {
    if (class_exists('Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType')) {
        add_action('woocommerce_blocks_payment_method_type_registration', function ($registry) {
            $registry->register(new BitriPay_Blocks_Support());
        });
    }
});

add_filter('plugin_action_links_' . plugin_basename(__FILE__), function ($links) {
    $settings = '<a href="' . admin_url('admin.php?page=wc-settings&tab=checkout&section=bitripay') . '">' . esc_html__('Settings', 'bitripay') . '</a>';
    array_unshift($links, $settings);
    return $links;
});
