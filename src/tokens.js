// Token estimation and cost maths for DeepSeek requests.
//
// We never ship a real tokenizer (that would mean bundling a BPE table). Instead
// we use a well-behaved heuristic that is good enough for a pre-flight estimate,
// and rely on the authoritative `usage` object DeepSeek returns per response for
// the real numbers.

/** Ranges that tokenize far denser than Latin text (CJK, Hangul, kana, fullwidth). */
const WIDE_RANGES = [
  [0x1100, 0x11ff], // Hangul Jamo
  [0x2e80, 0x2eff], // CJK radicals
  [0x3000, 0x303f], // CJK punctuation
  [0x3040, 0x30ff], // Hiragana + Katakana
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xac00, 0xd7af], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility
  [0xff00, 0xffef], // Fullwidth forms
];

function isWide(codePoint) {
  return WIDE_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi);
}

/**
 * Rough token count for a string.
 * - Latin/Cyrillic/Greek/etc.: ~4 characters per token
 * - CJK/Hangul/kana: ~1.6 tokens per character
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  let wide = 0;
  let narrow = 0;
  for (const char of String(text)) {
    if (isWide(char.codePointAt(0))) wide += 1;
    else narrow += 1;
  }
  return Math.ceil(wide * 1.6 + narrow / 4);
}

/** Prompt overhead per request (system instructions + JSON envelope). */
export const PER_REQUEST_OVERHEAD_TOKENS = 220;

/** Overhead per segment inside the JSON payload (quotes, commas, escaping). */
export const PER_SEGMENT_OVERHEAD_TOKENS = 6;

/** Published rates in USD per 1M tokens, as `[offPeak, peak]`.
 *  https://api-docs.deepseek.com/quick_start/pricing */
export const MODEL_PRICING = {
  'deepseek-flash': { cacheHit: [0.003, 0.006], input: [0.15, 0.3], output: [0.6, 1.2] },
  // Currently all `deepseek-v4-pro` traffic is routed to V4.1-Flash and billed at
  // the Flash price, so we bill it as Flash too.
  'deepseek-v4-pro': { cacheHit: [0.003, 0.006], input: [0.15, 0.3], output: [0.6, 1.2] },
};

export const DEFAULT_PRICING_MODEL = 'deepseek-flash';

/**
 * Peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday; everything else
 * (including weekends) is off-peak at half price.
 */
export function isPeakNow(date = new Date()) {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/**
 * Estimated cost in USD for one translation run.
 * @param {{model?: string, inputTokens?: number, outputTokens?: number, cacheHitTokens?: number, date?: Date}} usage
 */
export function estimateCostUsd({
  model = DEFAULT_PRICING_MODEL,
  inputTokens = 0,
  outputTokens = 0,
  cacheHitTokens = 0,
  date = new Date(),
} = {}) {
  const table = MODEL_PRICING[model] || MODEL_PRICING[DEFAULT_PRICING_MODEL];
  const peak = isPeakNow(date);
  const pick = (pair) => (peak ? pair[1] : pair[0]);
  const missTokens = Math.max(0, inputTokens - cacheHitTokens);
  return (
    (cacheHitTokens / 1e6) * pick(table.cacheHit)
    + (missTokens / 1e6) * pick(table.input)
    + (outputTokens / 1e6) * pick(table.output)
  );
}

/** Compact USD formatting that stays readable for sub-cent amounts. */
export function formatUsd(amount) {
  if (!Number.isFinite(amount) || amount <= 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}

/** Thousands-separated token counts. */
export function formatTokens(count) {
  return Number(count || 0).toLocaleString();
}
