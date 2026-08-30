const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const { buildAuditPrompt } = require('./prompt');

/**
 * Клиент для Anthropic API с надёжной retry-логикой, таймаутами и защитой
 * от зависания запросов.
 *
 * Особенности реализации:
 * - Экспоненциальная задержка (exponential backoff) с jitter для retry.
 * - Retry для retryable ошибок: 5xx, 429 (rate limit), OverloadedError,
 *   сетевые ошибки (ECONNRESET, ETIMEDOUT, AbortError от нашего таймаута).
 * - Non-retryable ошибки (4xx кроме 429) пробрасываются сразу.
 * - AbortController для таймаута запроса — запрос не висит вечно.
 * - Опциональный streaming-режим для снижения TTFB (первый токен приходит
 *   быстрее, а весь ответ собирается из событий).
 * - Поддержка graceful shutdown: можно отменить все pending-запросы.
 */

// Настройки retry
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

// Таймаут одного запроса к API (10 минут — с учётом web_search и длинного ответа)
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

// Set всех активных AbortController для graceful shutdown
const activeControllers = new Set();

/**
 * Определяет, можно ли retry-ить ошибку.
 * Retryable:
 * - 5xx (серверные ошибки Anthropic)
 * - 429 (rate limit)
 * - OverloadedError (модель перегружена)
 * - APIConnectionError / APIConnectionTimeoutError (сетевые проблемы)
 * - AbortError от нашего таймаута (если не превышен лимит попыток)
 * Non-retryable:
 * - 4xx кроме 429 (неверный запрос, auth error, invalid model и т.д.)
 */
function isRetryableError(err) {
  if (!err) return false;

  // OverloadedError — модель перегружена, нужно retry
  if (err instanceof Anthropic.errors?.OverloadedError) return true;
  if (err?.name === 'OverloadedError') return true;
  if (err?.error?.type === 'overloaded_error') return true;

  // APIError с HTTP-статусом
  if (err instanceof Anthropic.APIError || err?.status != null) {
    const status = err.status;
    if (status === 429) return true; // rate limit
    if (status >= 500 && status < 600) return true; // 5xx
    if (status === 529) return true; // специфичный для Anthropic "overloaded"
    // 4xx (кроме 429) — не retryable
    if (status >= 400 && status < 500) return false;
  }

  // Сетевые ошибки
  const code = err?.code || err?.cause?.code;
  if (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND' ||
    code === 'EPIPE'
  ) {
    return true;
  }

  // APIConnectionError / APIConnectionTimeoutError
  if (err?.name === 'APIConnectionError') return true;
  if (err?.name === 'APIConnectionTimeoutError') return true;

  // Наш собственный AbortError от таймаута — retryable
  if (err?.name === 'AbortError') return true;

  return false;
}

/**
 * Экспоненциальная задержка с jitter.
 * Формула: min(MAX_DELAY, BASE * 2^attempt) + случайный jitter (0..BASE)
 */
function calculateBackoff(attempt) {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, attempt));
  const jitter = Math.floor(Math.random() * BASE_DELAY_MS);
  return exp + jitter;
}

/**
 * Sleep с поддержкой отмены через AbortSignal.
 */
function sleepWithAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('Aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Запускает полный аудит школы по её сайту и возвращает Markdown-отчёт.
 * Использует встроенный инструмент web_search (если включён в конфиге),
 * чтобы модель могла реально сходить в интернет за соцсетями,
 * отзывами, конкурентами и т.д.
 *
 * Реализует retry с exponential backoff, таймаут и обработку OverloadedError.
 *
 * @param {string} siteUrl
 * @param {{ useStreaming?: boolean }} [options]
 * @returns {Promise<string>} markdown-отчёт
 */
async function runSchoolAudit(siteUrl, { useStreaming = false } = {}) {
  const prompt = buildAuditPrompt(siteUrl);
  const tools = config.anthropic.webSearch
    ? [{ type: 'web_search_20250305', name: 'web_search' }]
    : undefined;

  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Таймаут запроса через AbortController
    const controller = new AbortController();
    activeControllers.add(controller);
    const timeoutId = setTimeout(() => controller.abort(new Error('Request timeout')), REQUEST_TIMEOUT_MS);

    try {
      let text;
      if (useStreaming) {
        text = await runWithStreaming({ prompt, tools, signal: controller.signal });
      } else {
        text = await runWithoutStreaming({ prompt, tools, signal: controller.signal });
      }

      clearTimeout(timeoutId);
      activeControllers.delete(controller);

      if (!text || !text.trim()) {
        // Пустой ответ — retryable (возможно, модель вернула только tool_use)
        throw new Error('Модель вернула пустой ответ.');
      }

      return text;
    } catch (err) {
      clearTimeout(timeoutId);
      activeControllers.delete(controller);

      lastError = err;

      // Если это последняя попытка или ошибка non-retryable — пробрасываем
      if (attempt === MAX_RETRIES || !isRetryableError(err)) {
        throw wrapError(err, attempt);
      }

      // Логируем и ждём перед retry
      const delay = calculateBackoff(attempt);
      console.warn(
        `[claudeClient] Попытка ${attempt + 1}/${MAX_RETRIES + 1} не удалась ` +
          `(${err?.status || err?.name || err?.message}). ` +
          `Retry через ${delay} мс...`
      );

      try {
        await sleepWithAbort(delay, controller.signal);
      } catch (abortErr) {
        // Если во время сна пришёл abort — выходим
        throw abortErr;
      }
    }
  }

  // Не должно произойти, но на всякий случай
  throw wrapError(lastError, MAX_RETRIES);
}

/**
 * Non-streaming запрос к API.
 */
async function runWithoutStreaming({ prompt, tools, signal }) {
  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: config.anthropic.maxTokens,
    tools,
    messages: [{ role: 'user', content: prompt }],
  }, { signal });

  // response.content — массив блоков (text / tool_use / server_tool_use / ...)
  // Нам нужен весь текст из всех text-блоков, склеенный по порядку.
  const text = (response.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n');

  return text;
}

/**
 * Streaming-запрос к API для снижения TTFB.
 * Собирает текст из всех content_block_delta событий.
 */
async function runWithStreaming({ prompt, tools, signal }) {
  const stream = client.messages.stream(
    {
      model: config.anthropic.model,
      max_tokens: config.anthropic.maxTokens,
      tools,
      messages: [{ role: 'user', content: prompt }],
    },
    { signal }
  );

  const textChunks = [];

  // Собираем текст из delta-событий
  stream.on('text', (delta) => {
    textChunks.push(delta);
  });

  // Ждём финального сообщения (оно содержит все блоки)
  const finalMessage = await stream.finalMessage();

  // Если по какой-то причине chunks пустые — берём из финального сообщения
  if (textChunks.length === 0) {
    const text = (finalMessage.content || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n');
    return text;
  }

  return textChunks.join('');
}

/**
 * Оборачивает ошибку в более информативное сообщение.
 */
function wrapError(err, attemptsMade) {
  if (err?.name === 'AbortError' || err?.message === 'Request timeout') {
    return new Error(
      `Превышен таймаут запроса к Anthropic API (${REQUEST_TIMEOUT_MS / 1000} сек) ` +
        `после ${attemptsMade + 1} попыток. Попробуйте позже.`
    );
  }
  if (err instanceof Anthropic.errors?.OverloadedError || err?.name === 'OverloadedError') {
    return new Error(
      `Модель Anthropic перегружена. После ${attemptsMade + 1} попыток не удалось получить ответ. ` +
        `Попробуйте через несколько минут.`
    );
  }
  if (err?.status === 429) {
    return new Error(
      `Превышен лимит запросов к Anthropic API (rate limit). ` +
        `После ${attemptsMade + 1} попыток не удалось получить ответ.`
    );
  }
  // Возвращаем оригинальную ошибку, но с контекстом
  const wrapped = new Error(
    `Ошибка Anthropic API после ${attemptsMade + 1} попыток: ${err?.message || err}`
  );
  wrapped.cause = err;
  return wrapped;
}

/**
 * Отменяет все активные запросы к API.
 * Используется при graceful shutdown.
 */
function cancelAllPendingRequests() {
  for (const controller of activeControllers) {
    try {
      controller.abort(new Error('Graceful shutdown'));
    } catch (_) {
      // ignore
    }
  }
  activeControllers.clear();
}

module.exports = { runSchoolAudit, cancelAllPendingRequests };