define([
    'uiComponent',
    'Magento_Checkout/js/model/payment/renderer-list'
], function (Component, rendererList) {
    'use strict';

    rendererList.push({
        type: 'monetiser',
        component: 'Monetiser_Payment/js/view/payment/method-renderer/monetiser-method'
    });

    return Component.extend({});
});
