"use strict";
/**
 * Local ONNX embeddings (CPU) via @xenova/transformers.
 *
 * This module is a soft dependency: if the package is missing, the model
 * download fails/is blocked, or inference throws for any reason, every
 * exported function rejects and the caller (lib/analytics.js) MUST catch
 * that and fall back to method:"rules". Nothing here may become a hard
 * requirement for the dashboard to work.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MODEL_ID = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
const CACHE_DIR = path.join(__dirname, "..", "cache");
const MODEL_CACHE_DIR = path.join(CACHE_DIR, "models");
const VECTOR_CACHE_FILE = path.join(CACHE_DIR, "embedding_vectors.json");

let _extractorPromise = null;
let _vectorCache = null; // Map normalizedText -> number[]

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function normalizeKey(text) {
  return String(text).trim().toLowerCase();
}

function loadVectorCache() {
  if (_vectorCache) return _vectorCache;
  _vectorCache = new Map();
  try {
    if (fs.existsSync(VECTOR_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(VECTOR_CACHE_FILE, "utf8"));
      for (const [k, v] of Object.entries(raw)) _vectorCache.set(k, v);
    }
  } catch {
    // corrupt cache file - ignore, start fresh
    _vectorCache = new Map();
  }
  return _vectorCache;
}

function persistVectorCache() {
  ensureCacheDir();
  const obj = {};
  for (const [k, v] of _vectorCache.entries()) obj[k] = v;
  fs.writeFileSync(VECTOR_CACHE_FILE, JSON.stringify(obj));
}

async function getExtractor() {
  if (_extractorPromise) return _extractorPromise;
  _extractorPromise = (async () => {
    // Lazy require so a missing/broken package never breaks analytics.js at load time.
    const { pipeline, env } = require("@xenova/transformers");
    ensureCacheDir();
    env.cacheDir = MODEL_CACHE_DIR;
    env.allowRemoteModels = true;
    return pipeline("feature-extraction", MODEL_ID);
  })();
  return _extractorPromise;
}

function cosineSim(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  // vectors are already L2-normalized (pooling: mean, normalize: true), so
  // dot product == cosine similarity.
  return dot;
}

/**
 * Embed a batch of texts, using the on-disk vector cache to avoid
 * recomputation across process runs. Returns Map text -> number[].
 * Throws if the model/package is unavailable - callers must catch.
 */
async function embedTexts(texts, onProgress) {
  const cache = loadVectorCache();
  const uncached = [];
  const result = new Map();

  for (const t of texts) {
    const key = normalizeKey(t);
    if (cache.has(key)) result.set(t, cache.get(key));
    else uncached.push(t);
  }

  if (uncached.length > 0) {
    const extractor = await getExtractor();
    const BATCH = 64;
    let sinceCheckpoint = 0;
    for (let i = 0; i < uncached.length; i += BATCH) {
      const chunk = uncached.slice(i, i + BATCH);
      const out = await extractor(chunk, { pooling: "mean", normalize: true });
      const dims = out.dims; // [n, hidden]
      const data = out.data;
      const hidden = dims[1];
      for (let j = 0; j < chunk.length; j++) {
        const vec = Array.from(data.slice(j * hidden, (j + 1) * hidden));
        const key = normalizeKey(chunk[j]);
        cache.set(key, vec);
        result.set(chunk[j], vec);
      }
      sinceCheckpoint += chunk.length;
      // Checkpoint periodically - a full unclassified-title pass can take
      // several minutes on CPU, so persist progress as we go rather than
      // only at the very end.
      if (sinceCheckpoint >= 1000) {
        persistVectorCache();
        sinceCheckpoint = 0;
      }
      if (onProgress) onProgress(Math.min(i + BATCH, uncached.length), uncached.length);
    }
    persistVectorCache();
  }

  return result;
}

/**
 * Classify each title against a set of named category seed-phrase groups by
 * nearest centroid (mean of seed embeddings, cosine similarity). Returns
 * Map title -> {category, score} for titles whose best score >= threshold.
 * Titles below threshold are omitted (caller keeps them in the fallback
 * bucket). Throws if embeddings are unavailable - callers must catch.
 */
async function classifyByCentroid(titles, categorySeeds, threshold = 0.5, onProgress) {
  const seedNames = Object.keys(categorySeeds);
  const allSeedTexts = seedNames.flatMap((name) => categorySeeds[name]);

  const seedVectors = await embedTexts(allSeedTexts);
  const centroids = {};
  for (const name of seedNames) {
    const vecs = categorySeeds[name].map((s) => seedVectors.get(s)).filter(Boolean);
    const dim = vecs[0].length;
    const centroid = new Array(dim).fill(0);
    for (const v of vecs) for (let i = 0; i < dim; i++) centroid[i] += v[i];
    for (let i = 0; i < dim; i++) centroid[i] /= vecs.length;
    // re-normalize centroid
    const norm = Math.sqrt(centroid.reduce((s, x) => s + x * x, 0)) || 1;
    centroids[name] = centroid.map((x) => x / norm);
  }

  const titleVectors = await embedTexts(titles);
  const out = new Map();
  for (const title of titles) {
    const vec = titleVectors.get(title);
    if (!vec) continue;
    let best = null;
    let bestScore = -Infinity;
    for (const name of seedNames) {
      const score = cosineSim(vec, centroids[name]);
      if (score > bestScore) {
        bestScore = score;
        best = name;
      }
    }
    if (best !== null && bestScore >= threshold) {
      out.set(title, { category: best, score: bestScore });
    }
  }
  return out;
}

/** Quick capability probe - does not throw, resolves to boolean. */
async function isAvailable() {
  try {
    await getExtractor();
    return true;
  } catch {
    return false;
  }
}

module.exports = { embedTexts, classifyByCentroid, isAvailable, cosineSim, MODEL_ID };
