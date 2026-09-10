/**
 * New products digest web push — Fabuniqo brand copy.
 * Placeholders (optional legacy): {{appName}}, {{count}}, {{countLabel}}
 */

const { resolvePushBrandIconUrl } = require('../utils/storefrontFrontendUrl');

module.exports = {
  title: 'New Arrivals Just Dropped!',
  body: 'Fresh styles are now available. Be the first to explore our latest collection.',
  ctaLabel: 'Shop New Arrivals',
  get icon() {
    return resolvePushBrandIconUrl();
  },
  get badge() {
    return resolvePushBrandIconUrl();
  },
  tag: 'new-products-digest',
};
