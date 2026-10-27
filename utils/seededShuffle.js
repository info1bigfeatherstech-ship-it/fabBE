'use strict';

/**
 * Deterministic Fisher–Yates shuffle + pagination helpers.
 * Same seed + same id list → same order, so page 2 is the next slice (not a new $sample).
 * Admin/write paths must never use this.
 */

function mulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(items, seed) {
  if (!Array.isArray(items) || items.length <= 1) {
    return Array.isArray(items) ? items.slice() : [];
  }
  const out = items.slice();
  const rand = mulberry32(seed >>> 0);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

function sliceSeededShuffle(items, { seed = 0, skip = 0, limit = 12 } = {}) {
  const sk = Math.max(0, Math.floor(Number(skip) || 0));
  const lim = Math.max(0, Math.floor(Number(limit) || 0));
  if (!lim || !Array.isArray(items) || items.length === 0) return [];
  return seededShuffle(items, seed >>> 0).slice(sk, sk + lim);
}

/**
 * Coerce a query/session seed to uint32. Invalid/missing → fallback (also uint32).
 */
function parseShuffleSeed(raw, fallback = 0) {
  const fb = Number(fallback);
  const fallbackU = Number.isFinite(fb) ? fb >>> 0 : 0;
  if (raw == null || raw === '') return fallbackU;
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v == null || v === '') return fallbackU;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallbackU;
  return n >>> 0;
}

/** Shared fallback window when the client does not send shuffleSeed (Load More stays stable). */
const RANDOM_WINDOW_MS = 15 * 60 * 1000;

function fallbackShuffleSeed(nowMs = Date.now()) {
  const t = Number(nowMs);
  const ms = Number.isFinite(t) ? t : Date.now();
  return Math.floor(ms / RANDOM_WINDOW_MS) >>> 0;
}

module.exports = {
  RANDOM_WINDOW_MS,
  mulberry32,
  seededShuffle,
  sliceSeededShuffle,
  parseShuffleSeed,
  fallbackShuffleSeed,
};
