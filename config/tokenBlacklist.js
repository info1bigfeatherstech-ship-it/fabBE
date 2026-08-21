// Simple in-memory token blacklist helper (fallback when Redis unavailable)
const inMemoryBlacklist = new Set();

function add(token, ttlSeconds) {
  inMemoryBlacklist.add(token);
  if (ttlSeconds && ttlSeconds > 0) {
    setTimeout(() => inMemoryBlacklist.delete(token), ttlSeconds * 1000);
  }
}

function has(token) {
  return inMemoryBlacklist.has(token);
}

module.exports = { add, has };
