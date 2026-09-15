// Minimal, dependency-free DeepSeek client tuned for book translation.
//
// The public API is `translateBatch()`: give it a list of plain-text strings and
// it returns translations in the same order, automatically handling JSON mode,
// retries with backoff, rate limits and the (occasionally messy) model output.

const DEFAULT_BASE_URL = 'https://api.deepseek.com';

// Current DeepSeek API models (https://api-docs.deepseek.com/quick_start/pricing).
// Both support JSON output, and thinking mode is a request parameter rather than
// a separate model id — so one model id covers both modes.
export const MODELS = [
  { id: 'deepseek-flash', name: 'deepseek-flash (V4.1 · fast, recommended)' },
  { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro (V4 Pro · being retired → V4.1 Flash)' },
];

export const DEFAULT_MODEL = 'deepseek-flash';

/**
 * Build the chat-completions request body.
 *
 * Translation is a single-shot transformation, so we explicitly DISABLE thinking
 * mode: the chain-of-thought costs extra output tokens and latency for no real
 * quality benefit, and it would also make `temperature` a no-op. With thinking
 * off, `temperature` applies normally and JSON output is fully supported.
 *
 * @param {{model: string, messages: {role: string, content: string}[]}} options
 */
export function buildRequestBody({ model, messages }) {
  return {
    model,
    messages,
    stream: false,
    temperature: 1.3, // DeepSeek's own recommendation for translation.
    thinking: { type: 'disabled' },
    response_format: { type: 'json_object' },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class DeepSeekError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'DeepSeekError';
    this.status = status;
    this.retryable = retryable;
  }
}

function buildSystemPrompt(sourceName, targetName) {
  const source = sourceName ? `the source language (${sourceName})` : 'its detected source language';
  return [
    `You are a professional literary translator. Translate text from ${source} into ${targetName}.`,
    'Guidelines:',
    '- Translate faithfully and naturally; preserve the author\'s tone, register and style.',
    '- Keep proper nouns, numbers, units, dates and formatting as-is unless a well-known localized form exists.',
    '- Never add explanations, notes, prefaces or commentary.',
    '- Never merge, split, reorder or drop items: return exactly one translation per input item, in the same order.',
    '- Respond with strict JSON only, using the shape {"translations": ["...", "..."]}, where the array has the same length as the input.',
  ].join('\n');
}

function buildUserPrompt(texts) {
  return [
    `Translate the following ${texts.length} text segment(s).`,
    'Return JSON: {"translations": [...]} with exactly the same number of items and the same order.',
    '',
    JSON.stringify(texts),
  ].join('\n');
}

/** Pull `{"translations": [...]}` out of a model reply that may include fences/prose. */
export function parseTranslations(content, expected) {
  if (typeof content !== 'string' || content.trim() === '') return null;
  let text = content.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first === -1 || last <= first) return null;
    try {
      parsed = JSON.parse(text.slice(first, last + 1));
    } catch {
      return null;
    }
  }

  let list = null;
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && typeof parsed === 'object') {
    for (const value of Object.values(parsed)) {
      if (Array.isArray(value)) {
        list = value;
        break;
      }
    }
  }
  if (!Array.isArray(list) || list.length !== expected) return null;
  return list.map((item) => (typeof item === 'string' ? item : String(item ?? '')));
}

export class DeepSeekClient {
  /**
   * @param {{apiKey: string, model?: string, baseUrl?: string, maxRetries?: number}} options
   */
  constructor({ apiKey, model = DEFAULT_MODEL, baseUrl = DEFAULT_BASE_URL, maxRetries = 4 } = {}) {
    if (!apiKey || !apiKey.trim()) throw new DeepSeekError('A DeepSeek API key is required.');
    this.apiKey = apiKey.trim();
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.maxRetries = maxRetries;
  }

  async #chat(messages, signal) {
    const body = buildRequestBody({ model: this.model, messages });

    let wait = 1200;
    let lastError = 'Unknown error';

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });

        if (response.ok) {
          const data = await response.json();
          return {
            content: data?.choices?.[0]?.message?.content ?? '',
            usage: data?.usage ?? null,
          };
        }

        const detail = await response.text().catch(() => '');
        const shortDetail = detail.slice(0, 400);

        if (response.status === 401 || response.status === 403) {
          throw new DeepSeekError(
            `DeepSeek rejected the API key (HTTP ${response.status}). Double-check the key you pasted.`,
            { status: response.status },
          );
        }
        if (response.status === 402) {
          throw new DeepSeekError('DeepSeek reports insufficient balance for this API key (HTTP 402).', {
            status: 402,
          });
        }
        if (response.status === 400) {
          throw new DeepSeekError(`DeepSeek rejected the request (HTTP 400): ${shortDetail}`, { status: 400 });
        }
        if (response.status === 429 || response.status >= 500) {
          lastError = `HTTP ${response.status}: ${shortDetail}`;
          if (attempt < this.maxRetries) {
            await sleep(wait + Math.random() * 400);
            wait *= 2;
            continue;
          }
          throw new DeepSeekError(`DeepSeek is rate-limiting or unavailable (${lastError}).`, {
            status: response.status,
            retryable: true,
          });
        }
        throw new DeepSeekError(`DeepSeek API error (HTTP ${response.status}): ${shortDetail}`, {
          status: response.status,
        });
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        if (error instanceof DeepSeekError) throw error;
        // Network / CORS / offline errors are worth retrying.
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < this.maxRetries) {
          await sleep(wait + Math.random() * 400);
          wait *= 2;
          continue;
        }
        throw new DeepSeekError(
          `Could not reach DeepSeek (${lastError}). Check your connection, then retry.`,
          { retryable: true },
        );
      }
    }

    throw new DeepSeekError(`DeepSeek request failed: ${lastError}`, { retryable: true });
  }

  /**
   * Translate an array of plain-text segments, preserving order and length.
   *
   * If the model returns a mismatched payload we recursively split the batch
   * (down to single segments) so one bad response can never lose a paragraph.
   *
   * @param {string[]} texts
   * @param {{source:string, target:string, signal?:AbortSignal, onNote?:(msg:string)=>void,
   *          onUsage?:(usage:object)=>void}} options
   * @returns {Promise<string[]>}
   */
  async translateBatch(texts, options) {
    if (!Array.isArray(texts) || texts.length === 0) return [];
    const { source, target, signal, onNote, onUsage } = options;

    const sourceName = source || '';
    const system = buildSystemPrompt(sourceName, target);
    const user = buildUserPrompt(texts);

    const { content, usage } = await this.#chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      signal,
    );
    // Report usage even when the reply turns out unparseable: those tokens were
    // still billed, so the running total should include them.
    if (usage) onUsage?.(usage);

    const parsed = parseTranslations(content, texts.length);
    if (parsed) return parsed;

    if (texts.length === 1) {
      // Give up gracefully: fall back to the original text for this one segment.
      onNote?.('Model returned an unparseable reply for a single segment; keeping the original text.');
      return [texts[0]];
    }

    onNote?.(`Model returned ${texts.length} segments with a mismatched reply; splitting the batch and retrying.`);
    const mid = Math.floor(texts.length / 2);
    const left = await this.translateBatch(texts.slice(0, mid), options);
    const right = await this.translateBatch(texts.slice(mid), options);
    return [...left, ...right];
  }
}
