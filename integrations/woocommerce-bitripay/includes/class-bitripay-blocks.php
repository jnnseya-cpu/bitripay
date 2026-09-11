<?php
if (!defined('ABSPATH')) {
    exit;
}

if (class_exists('Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType')) {
    /** Cart & Checkout blocks support. */
    final class BitriPay_Blocks_Support extends Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType
    {
        protected $name = 'bitripay';

        public function initialize()
        {
            $this->settings = get_option('woocommerce_bitripay_settings', array());
        }

        public function is_active()
        {
            return isset($this->settings['enabled']) && 'yes' === $this->settings['enabled'];
        }

        public function get_payment_method_script_handles()
        {
            wp_register_script('bitripay-blocks', BITRIPAY_WC_URL . 'assets/blocks.js', array('wc-blocks-registry', 'wc-settings', 'wp-element', 'wp-html-entities'), BITRIPAY_WC_VERSION, true);
            return array('bitripay-blocks');
        }

        public function get_payment_method_data()
        {
            return array(
                'title'       => isset($this->settings['title']) ? $this->settings['title'] : 'BitriPay',
                'description' => isset($this->settings['description']) ? $this->settings['description'] : '',
                'icon'        => BITRIPAY_WC_URL . 'assets/icon.svg',
                'testmode'    => isset($this->settings['testmode']) && 'yes' === $this->settings['testmode'],
            );
        }
    }
}
