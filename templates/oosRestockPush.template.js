/**
 * Back-in-stock web push — Fabuniqo brand copy.
 * Placeholders (optional): {{productName}}, {{appName}}
 */

const { resolvePushBrandIconUrl } = require('../utils/storefrontFrontendUrl');

module.exports = {
  title: 'It’s Back in Stock!',
  body: 'The product you were waiting for is available again. Shop before it sells out!',
  ctaLabel: 'Shop Now',
  moqTitle: 'It’s Back in Stock!',
  moqBody:
    'The product you were waiting for is available again. Shop before it sells out!',
  moqCtaLabel: 'Shop Now',
  get icon() {
    return resolvePushBrandIconUrl();
  },
  get badge() {
    return resolvePushBrandIconUrl();
  },
  tag: 'back_in_stock',
};
