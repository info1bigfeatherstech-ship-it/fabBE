/**
 * Wishlist reminder web push — Fabuniqo brand copy.
 * Placeholders (optional legacy): {{name}}, {{appName}}, {{itemCount}}, {{itemLabel}}
 */

const { resolvePushBrandIconUrl } = require('../utils/storefrontFrontendUrl');

module.exports = {
  title: 'Something You Loved Is Calling!',
  body:
    'An item from your wishlist is now on sale / running low on stock. Take another look!',
  ctaLabel: 'View Wishlist',
  get icon() {
    return resolvePushBrandIconUrl();
  },
  get badge() {
    return resolvePushBrandIconUrl();
  },
  tag: 'wishlist-reminder',
};
