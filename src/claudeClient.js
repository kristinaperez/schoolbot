const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const { buildAuditPrompt } = require('./prompt');

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

/**
 * Запускает полный аудит школы по её сайту и возвращает Markdown-отчёт.
 * Использует встроенный инструмент web_search (если включён в конфиге),
 * чтобы модель могла реально сходить в интернет за соцсетями,
 * отзывами, конкурентами и т.д.
 *
 * @param {string} siteUrl
 * @returns {Promise<string>} markdown-отчёт
 */
async function runSchoolAudit(siteUrl) {
  const prompt = buildAuditPrompt(siteUrl);

  const tools = config.anthropic.webSearch
    ? [{ type: 'web_search_20250305', name: 'web_search' }]
    : undefined;

  const response = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: config.anthropic.maxTokens,
    tools,
    messages: [{ role: 'user', content: prompt }],
  });

  // response.content — массив блоков (text / tool_use / server_tool_use / web_search_tool_result / ...)
  // Нам нужен весь текст из всех text-блоков, склеенный по порядку.
  const text = (response.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n');

  if (!text.trim()) {
    throw new Error('Модель вернула пустой ответ.');
  }

  return text;
}

module.exports = { runSchoolAudit };
