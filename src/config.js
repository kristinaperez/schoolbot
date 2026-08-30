require('dotenv').config();

/**
 * Получает обязательную переменную окружения.
 * Бросает ошибку, если переменная отсутствует или пуста, предотвращая 
 * тихий запуск бота с невалидной конфигурацией.
 * @param {string} name - Имя переменной окружения.
 * @returns {string} Очищенное значение переменной.
 */
function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Критическая ошибка конфигурации: переменная окружения ${name} не задана или пуста. Проверьте файл .env`);
  }
  return value.trim();
}

/**
 * Получает переменную окружения с fallback и строгой валидацией типа Integer.
 * @param {string} name - Имя переменной окружения.
 * @param {number} fallback - Значение по умолчанию.
 * @returns {number} Целочисленное значение.
 */
function requireEnvInt(name, fallback) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    return fallback;
  }
  const parsed = parseInt(value.trim(), 10);
  if (isNaN(parsed)) {
    throw new Error(`Критическая ошибка конфигурации: переменная окружения ${name} должна быть целым числом, получено: "${value}"`);
  }
  return parsed;
}

/**
 * Получает переменную окружения с fallback и валидацией типа Boolean.
 * @param {string} name - Имя переменной окружения.
 * @param {boolean} fallback - Значение по умолчанию.
 * @returns {boolean} Логическое значение.
 */
function requireEnvBool(name, fallback) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    return fallback;
  }
  return value.trim().toLowerCase() === 'true';
}

module.exports = {
  botToken: requireEnv('BOT_TOKEN'),
  anthropic: {
    apiKey: requireEnv('ANTHROPIC_API_KEY'),
    model: process.env.ANTHROPIC_MODEL?.trim() || 'claude-3-5-sonnet-latest',
    maxTokens: requireEnvInt('ANTHROPIC_MAX_TOKENS', 8192),
    webSearch: requireEnvBool('ANTHROPIC_WEB_SEARCH', true),
  },
  smtp: {
    host: requireEnv('SMTP_HOST'),
    port: requireEnvInt('SMTP_PORT', 587),
    secure: requireEnvBool('SMTP_SECURE', false),
    user: requireEnv('SMTP_USER'),
    pass: requireEnv('SMTP_PASS'),
    // Исправлен невалидный markdown-формат в fallback на корректный RFC 2822
    from: process.env.MAIL_FROM?.trim() || '"AI Audit Bot" <no-reply@example.com>',
  },
  contact: {
    name: process.env.CONTACT_NAME?.trim() || 'Кристина Перез',
    telegram: process.env.CONTACT_TELEGRAM?.trim() || 'https://t.me/KristinaPerez9',
  },
  rateLimit: {
    windowMs: requireEnvInt('RATE_LIMIT_WINDOW_MS', 1000),
    maxRequests: requireEnvInt('RATE_LIMIT_MAX_REQUESTS', 4),
    banMs: requireEnvInt('RATE_LIMIT_BAN_MS', 15000),
  },
  fakeProgressDelayMs: requireEnvInt('FAKE_PROGRESS_DELAY_MS', 30000),
};