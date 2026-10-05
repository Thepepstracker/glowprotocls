<?php
/** Install as a Run everywhere Code Snippets snippet (omit this opening PHP tag).
 * Reversible: deactivate this snippet. Keeps admin, legacy accounts and payment links.
 * New shopping and checkout move to the independent Netlify store.
 */
function glow_new_store_destination_20261005() {
    $args = array();
    foreach (array('ref', 'coupon') as $key) {
        if (isset($_GET[$key]) && is_string($_GET[$key])) {
            $value = sanitize_text_field(wp_unslash($_GET[$key]));
            if (strlen($value) <= 100) { $args[$key] = $value; }
        }
    }
    return add_query_arg($args, 'https://glowglps.com/store-next/');
}
add_action('init', function () {
    if (is_admin() || wp_doing_ajax() || wp_doing_cron() || (defined('REST_REQUEST') && REST_REQUEST)) { return; }
    $path = trim((string) parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH), '/');
    // Existing customers can still access their old records and finish existing payments.
    if (preg_match('#^(wp-login\.php|wp-json|my-account|pay|p|order-tracking)(/|$)#', $path)
        || preg_match('#/(order-pay|order-received|view-order)(/|$)#', '/' . $path)) { return; }
    if (isset($_GET['glp_bag']) || isset($_GET['add-to-cart'])
        || $path === '' || preg_match('#^(shop|cart|checkout|product|product-category|product-tag)(/|$)#', $path)) {
        nocache_headers();
        wp_redirect(glow_new_store_destination_20261005(), 302, 'Glow new store');
        exit;
    }
}, -100);
// Prevent purchases from stale/cached classic carts and add-to-cart requests.
add_filter('woocommerce_is_purchasable', '__return_false', PHP_INT_MAX);
add_filter('woocommerce_variation_is_purchasable', '__return_false', PHP_INT_MAX);
add_action('woocommerce_checkout_process', function () {
    wc_add_notice('Our store has moved. Please place new orders at https://glowglps.com/store-next/. Existing order payment links remain available.', 'error');
}, -100);
// Block new block-checkout orders, including requests from a previously open tab.
add_filter('rest_pre_dispatch', function ($result, $server, $request) {
    if (in_array($request->get_method(), array('GET', 'HEAD', 'OPTIONS'), true)) { return $result; }
    if (preg_match('#^/wc/store/v[0-9]+/(checkout/?$|cart/(add-item|update-item|apply-coupon)/?$)#', $request->get_route())) {
        return new WP_Error('glow_store_moved', 'Please place new orders at https://glowglps.com/store-next/.', array('status' => 409));
    }
    return $result;
}, -100, 3);
