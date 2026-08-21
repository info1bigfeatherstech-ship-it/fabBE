/**
 * JSON API responses: do not allow browsers to store long-lived copies of dynamic data.
 * Server-side Redis caching is unchanged; only HTTP (disk) caching is disabled.
 */
const API_JSON_CACHE_CONTROL = 'private, no-store';

function setApiCacheHeaders(res) {
  res.setHeader('Cache-Control', API_JSON_CACHE_CONTROL);
}

module.exports = { API_JSON_CACHE_CONTROL, setApiCacheHeaders };
