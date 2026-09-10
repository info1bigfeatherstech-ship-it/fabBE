/**
 * Cart reminder web push — Fabuniqo brand copy (manual + auto).
 * Placeholders (optional legacy): {{name}}, {{appName}}, {{itemCount}}, {{itemLabel}}, {{cartTotal}}
 */

const { resolvePushBrandIconUrl } = require('../utils/storefrontFrontendUrl');

module.exports = {
  title: 'Still Thinking About It?',
  body:
    'You have items waiting in your cart. Complete your order before they’re gone.',
  ctaLabel: 'View Cart',
  get icon() {
    return resolvePushBrandIconUrl();
  },
  get badge() {
    return resolvePushBrandIconUrl();
  },
  tag: 'cart-reminder',
};
