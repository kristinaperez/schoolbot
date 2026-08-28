require('dotenv').config();

function requireEnv(name, fallback = undefined) {
  const value = process.env[name] ?? fallback;
  return value;
}

module.exports = {
  botToken: requireEnv('BOT_TOKEN'),

  anthropic: {
    apiKey: requireEnv('ANTHROPIC_API_KEY'),
    model: requireEnv('ANTHROPIC_MODEL', 'claude-sonnet-5'),
    maxTokens: parseInt(requireEnv('ANTHROPIC_MAX_TOKENS', '8192'), 10),
    webSearch: requireEnv('ANTHROPIC_WEB_SEARCH', 'true') === 'true',
  },

  smtp: {
    host: requireEnv('SMTP_HOST'),
    port: parseInt(requireEnv('SMTP_PORT', '587'), 10),
    secure: requireEnv('SMTP_SECURE', 'false') === 'true',
    user: requireEnv('SMTP_USER'),
    pass: requireEnv('SMTP_PASS'),
    from: requireEnv('MAIL_FROM', '"AI Audit Bot" <no-reply@example.com>'),
  },

  contact: {
    name: requireEnv('CONTACT_NAME', 'Кристина Перез'),
    telegram: requireEnv('CONTACT_TELEGRAM', 'https://t.me/KristinaPerez9'),
  },

  rateLimit: {
    windowMs: parseInt(requireEnv('RATE_LIMIT_WINDOW_MS', '1000'), 10),
    maxRequests: parseInt(requireEnv('RATE_LIMIT_MAX_REQUESTS', '4'), 10),
    banMs: parseInt(requireEnv('RATE_LIMIT_BAN_MS', '15000'), 10),
  },

  fakeProgressDelayMs: parseInt(requireEnv('FAKE_PROGRESS_DELAY_MS', '30000'), 10),
};
