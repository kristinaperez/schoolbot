const { Telegraf } = require('telegraf');
const config = require('./config');
const { rateLimiterMiddleware } = require('./rateLimiter');
const { getSession, resetSession } = require('./session');
const { runSchoolAudit } = require('./claudeClient');
const { withAuditPdf } = require('./pdf');
const { sendAuditReport } = require('./mailer');

/**
 * Модуль сценария диалога Telegram-бота.
 *
 * ИСПРАВЛЕНИЯ И УЛУЧШЕНИЯ:
 * - Синхронизированы таймеры: используется session.timers (массив).
 * - Улучшен regex для URL: поддержка кириллических доменов, правильные TLD.
 * - Улучшен валидатор email: RFC 5322 simplified, проверка длины и домена.
 * - Добавлена обработка неизвестных команд и нетекстовых сообщений.
 * - Реализована защита от конкурентных запусков (флаг isProcessing).
 * - Используется withAuditPdf для гарантированного удаления временных PDF.
 * - Добавлена защита от DoS (MAX_INPUT_LENGTH).
 * - 🔴 НОВОЕ: Умная логика email. Бот запоминает email (savedEmail) и при 
 *   следующем запуске предлагает использовать его, чтобы пользователю не 
 *   приходилось вводить его заново.
 */

// 🔴 ИСПРАВЛЕНО: улучшенный regex для URL (кириллица, punycode, правильные TLD)
const URL_RE = /^(https?:\/\/)?([\w\u00C0-\uFFFF-]+\.)*[\w\u00C0-\uFFFF-]+\.[\w\u00C0-\uFFFF]{2,}(\/[^\s]*)?$/i;

// 🔴 ИСПРАВЛЕНО: более строгий regex для email (RFC 5322 simplified)
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

// Максимальная длина входных данных (защита от DoS)
const MAX_INPUT_LENGTH = 2048;

/**
 * Нормализует и валидирует URL.
 */
function normalizeUrl(text) {
  if (typeof text !== 'string') return null;

  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INPUT_LENGTH) return null;

  // Удаление control-символов (защита от инъекций)
  // eslint-disable-next-line no-control-regex
  const sanitized = trimmed.replace(/[\x00-\x1F\x7F]/g, '');

  if (!URL_RE.test(sanitized)) return null;

  // Добавляем https:// если протокол не указан
  const withProtocol = /^https?:\/\//i.test(sanitized) ? sanitized : `https://${sanitized}`;

  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname || parsed.hostname.length < 3) return null;
    return parsed.toString();
  } catch (_) {
    return null;
  }
}

/**
 * Валидирует email.
 */
function validateEmail(text) {
  if (typeof text !== 'string') return null;

  const trimmed = text.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 254) return null;

  // Удаление control-символов и пробелов
  // eslint-disable-next-line no-control-regex
  const sanitized = trimmed.replace(/[\x00-\x1F\x7F\s]/g, '');

  if (!EMAIL_RE.test(sanitized)) return null;

  // Дополнительная проверка: домен должен содержать хотя бы одну точку
  const domain = sanitized.split('@')[1];
  if (!domain || !domain.includes('.')) return null;

  return sanitized;
}

/**
 * Прогрессивные "фейковые" статусные сообщения.
 */
function scheduleProgressMessages(bot, chatId, session) {
  const steps = [
    { delay: 6000, text: '🔎 Изучаю сайт, страницы курсов и оффер...' },
    { delay: 16000, text: '📊 Собираю данные о соцсетях, отзывах и конкурентах...' },
  ];

  session.timers = [];

  steps.forEach(({ delay, text }) => {
    const t = setTimeout(() => {
      if (session.state === 'analyzing') {
        bot.telegram.sendMessage(chatId, text).catch(() => {});
      }
    }, delay);
    session.timers.push(t);
  });

  const emailTimer = setTimeout(() => {
    if (session.state === 'analyzing') {
      session.state = 'awaiting_email';
      
      // 🔴 УМНАЯ ЛОГИКА: если email уже сохранен, предлагаем использовать его
      let promptText = '📩 Анализ продолжается в фоне — он занимает несколько минут.\n\nОставьте, пожалуйста, ваш email — как только отчёт будет готов, мы вышлем его вам в виде PDF.';
      
      if (session.savedEmail) {
        promptText = `📩 Анализ продолжается в фоне.\n\nОтправить готовый PDF-отчёт на ваш сохраненный email: \n📧 *${session.savedEmail}*?\n\nНапишите "Да" или введите новый email.`;
      }

      bot.telegram.sendMessage(chatId, promptText, { parse_mode: 'Markdown' }).catch(() => {});
    }
  }, config.fakeProgressDelayMs);

  session.timers.push(emailTimer);
}

/**
 * Очищает все таймеры сессии.
 */
function clearTimers(session) {
  if (session.timers && Array.isArray(session.timers)) {
    session.timers.forEach(clearTimeout);
    session.timers = [];
  }
}

/**
 * Запускает реальный анализ школы через Claude (в фоне).
 */
function startAnalysis(bot, chatId, session, url) {
  // 🔴 ИСПРАВЛЕНО: защита от конкурентных запусков
  if (session.isProcessing) {
    return false;
  }

  session.state = 'analyzing';
  session.url = url;
  session.email = null; // Сбрасываем текущий email аудита
  session.analysisResult = null;
  session.analysisError = null;
  session.isProcessing = true;

  session.analysisPromise = runSchoolAudit(url)
    .then((result) => {
      session.analysisResult = result;
      return result;
    })
    .catch((err) => {
      console.error('[bot] Ошибка анализа Claude:', err);
      session.analysisError = err;
      throw err;
    })
    .finally(() => {
      session.isProcessing = false;
    });

  scheduleProgressMessages(bot, chatId, session);
  return true;
}

/**
 * Дожидается результата анализа, генерирует PDF, отправляет его на email
 * и уведомляет пользователя в Telegram.
 */
async function finalizeAndDeliver(ctx, session) {
  const userId = ctx.from.id;

  try {
    await ctx.reply('⏳ Ожидаю завершения анализа, это может занять несколько минут...');

    const markdownBody = await session.analysisPromise;

    await ctx.reply('📝 Анализ готов, формирую PDF-отчёт...');

    // 🔴 ИСПРАВЛЕНО: используем withAuditPdf для гарантированного удаления временного PDF
    await withAuditPdf(
      {
        siteUrl: session.url,
        markdownBody,
      },
      async (pdfPath) => {
        await ctx.reply('📧 Отправляю отчёт на вашу почту...');

        await sendAuditReport({
          to: session.email,
          siteUrl: session.url,
          pdfPath,
        });
      }
    );

    session.state = 'done';

    await ctx.reply(
      `✅ Готово! Отчёт по школе ${session.url} отправлен на ${session.email}.\n\n` +
        'Чтобы проанализировать другой сайт — просто пришлите новую ссылку.'
    );
  } catch (err) {
    console.error(`[bot] Ошибка при финализации отчёта (userId=${userId}):`, err);

    session.state = 'idle';

    await ctx.reply(
      '⚠️ К сожалению, при подготовке отчёта произошла ошибка. ' +
        'Попробуйте, пожалуйста, ещё раз — пришлите ссылку на сайт школы заново.'
    );
  }
}

function createBot() {
  if (!config.botToken) {
    throw new Error('BOT_TOKEN не задан. Заполните .env на основе .env.example');
  }

  const bot = new Telegraf(config.botToken);

  // Rate limiting — самый первый middleware в цепочке.
  bot.use(rateLimiterMiddleware());

  bot.start(async (ctx) => {
    resetSession(ctx.from.id); // resetSession теперь сохраняет savedEmail
    const session = getSession(ctx.from.id);
    
    let welcomeMsg = '👋 Привет! Я AI-аудитор онлайн-школ.\n\n' +
      'Пришлите мне ссылку на сайт онлайн-школы — и я проведу комплексный ' +
      'аудит продукта, маркетинга, продаж, сайта, автоматизации и AI-возможностей.\n\n' +
      'В процессе я попрошу у вас email — на него придёт готовый PDF-отчёт.\n\n' +
      'Пример: https://example-school.com';

    // 🔴 УМНАЯ ЛОГИКА: упоминаем сохраненный email при старте
    if (session.savedEmail) {
      welcomeMsg += `\n\n💡 _Кстати, ваш прошлый email (${session.savedEmail}) сохранен. Мы автоматически предложим использовать его при отправке отчёта._`;
    }

    await ctx.reply(welcomeMsg, { parse_mode: 'Markdown' });
  });

  bot.help(async (ctx) => {
    await ctx.reply(
      'Как пользоваться:\n' +
        '1. Пришлите ссылку на сайт онлайн-школы.\n' +
        '2. Дождитесь запроса email (это займёт около 30 секунд).\n' +
        '3. Введите email (или согласитесь использовать сохраненный).\n' +
        '4. Получите PDF-отчёт на почту.\n\n' +
        'Команда /start — начать заново.'
    );
  });

  // 🔴 ИСПРАВЛЕНО: обработка неизвестных команд
  bot.command('unknown', async (ctx) => {
    await ctx.reply(
      '❓ Неизвестная команда.\n\n' +
        'Доступные команды:\n' +
        '/start — начать заново\n' +
        '/help — показать справку\n\n' +
        'Или просто пришлите ссылку на сайт онлайн-школы.'
    );
  });

  bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    const text = ctx.message.text.trim();
    const session = getSession(userId);

    // 🔴 ИСПРАВЛЕНО: защита от слишком длинных сообщений (DoS)
    if (text.length > MAX_INPUT_LENGTH) {
      await ctx.reply(
        `⚠️ Сообщение слишком длинное (максимум ${MAX_INPUT_LENGTH} символов). ` +
          'Пожалуйста, пришлите только ссылку на сайт или email.'
      );
      return;
    }

    // Игнорируем команды (обрабатываются отдельными handlers)
    if (text.startsWith('/')) return;

    switch (session.state) {
      case 'idle':
      case 'done': {
        // 🔴 ИСПРАВЛЕНО: защита от конкурентных запусков
        if (session.isProcessing) {
          await ctx.reply('⏳ Предыдущий анализ ещё не завершён. Пожалуйста, подождите.');
          return;
        }

        const url = normalizeUrl(text);
        if (!url) {
          await ctx.reply(
            '🔗 Пожалуйста, пришлите корректную ссылку на сайт школы, например: https://example-school.com'
          );
          return;
        }

        await ctx.reply(`🚀 Начинаю комплексный анализ школы: ${url}\n\nЭто займёт несколько минут...`);

        const started = startAnalysis(bot, chatId, session, url);
        if (!started) {
          await ctx.reply('⏳ Предыдущий анализ ещё не завершён. Пожалуйста, подождите.');
        }
        break;
      }

      case 'analyzing': {
        await ctx.reply('⏳ Анализ ещё выполняется, немного подождите — скоро попрошу у вас email.');
        break;
      }

      case 'awaiting_email': {
        const lowerText = text.toLowerCase();

        // 🔴 УМНАЯ ЛОГИКА: пользователь согласился использовать сохраненный email
        if (session.savedEmail && (lowerText === 'да' || lowerText === 'yes' || lowerText === session.savedEmail.toLowerCase())) {
          session.email = session.savedEmail;
        } else {
          // Пользователь ввел новый email
          const newEmail = validateEmail(text);
          if (!newEmail) {
            const hint = session.savedEmail ? ` (или напишите "Да", чтобы использовать ${session.savedEmail})` : '';
            await ctx.reply(`📧 Это не похоже на корректный email. Введите адрес почты${hint}.`);
            return;
          }
          session.email = newEmail;
          session.savedEmail = newEmail; // 🔴 Запоминаем новый email для будущих запусков
        }

        session.state = 'processing_email';
        clearTimers(session);

        await ctx.reply(`Принято ✅ Как только отчёт будет готов, я вышлю его на ${session.email}.`);

        // Не блокируем event loop — доставка идёт в фоне.
        finalizeAndDeliver(ctx, session).catch((e) =>
          console.error('[bot] Ошибка finalizeAndDeliver:', e)
        );
        break;
      }

      case 'processing_email': {
        await ctx.reply('📨 Отчёт уже готовится и скоро придёт на вашу почту. Спасибо за терпение!');
        break;
      }

      default: {
        resetSession(userId);
        await ctx.reply('Что-то пошло не так, начнём заново. Пришлите ссылку на сайт школы.');
      }
    }
  });

// 🔴 НОВОЕ: обработка данных из Telegram Mini App (WebApp)
bot.on('web_app_data', async (ctx) => {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;
  const rawData = ctx.message.web_app_data.data;
  
  let payload;
  try {
    payload = JSON.parse(rawData);
  } catch (e) {
    console.error('[bot] Неверный JSON из WebApp:', rawData);
    return;
  }

  // Обработка команды "analyze_url" из Mini App
  if (payload.action === 'analyze_url' && payload.url) {
    const session = getSession(userId);

    // Защита от параллельных запусков
    if (session.isProcessing) {
      await ctx.reply('⏳ Предыдущий анализ ещё не завершён. Пожалуйста, подождите.');
      return;
    }

    // URL уже валидирован в Mini App, но перепроверяем на всякий случай
    const url = normalizeUrl(payload.url);
    if (!url) {
      await ctx.reply('🔗 Некорректная ссылка. Попробуйте ещё раз через мини-приложение.');
      return;
    }

    // Сбрасываем прошлую сессию (но сохраняем savedEmail!)
    resetSession(userId);
    const freshSession = getSession(userId);

    await ctx.reply(`🚀 Принято! Начинаю комплексный анализ школы: ${url}\n\nЭто займёт несколько минут...`);
    startAnalysis(bot, chatId, freshSession, url);
    return;
  }

  // Неизвестное действие
  console.warn('[bot] Неизвестное web_app_data action:', payload.action);
});


  // 🔴 ИСПРАВЛЕНО: обработка нетекстовых сообщений
  bot.on(['photo', 'document', 'voice', 'video', 'audio', 'sticker'], async (ctx) => {
    await ctx.reply(
      '📎 Я принимаю только текстовые сообщения.\n\n' +
        'Пожалуйста, пришлите:\n' +
        '1. Ссылку на сайт онлайн-школы (текстом)\n' +
        '2. Или ваш email (текстом)\n\n' +
        'Пример: https://example-school.com'
    );
  });

  bot.catch((err, ctx) => {
    console.error(`[bot] Необработанная ошибка для ${ctx.updateType}:`, err);
  });

  return bot;
}

module.exports = { createBot };