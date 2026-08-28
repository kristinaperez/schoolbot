const { Telegraf } = require('telegraf');
const config = require('./config');
const { rateLimiterMiddleware } = require('./rateLimiter');
const { getSession, resetSession } = require('./session');
const { runSchoolAudit } = require('./claudeClient');
const { generateAuditPdf } = require('./pdf');
const { sendAuditReport } = require('./mailer');

const URL_RE = /^(https?:\/\/)?([\w-]+\.)+[\w-]{2,}(\/[^\s]*)?$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeUrl(text) {
  const trimmed = text.trim();
  if (!URL_RE.test(trimmed)) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Прогрессивные "фейковые" статусные сообщения, которые создают ощущение
 * работы, пока в фоне реально выполняется запрос к Claude.
 * Последний шаг (на FAKE_PROGRESS_DELAY_MS) — предложение оставить email.
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
      bot.telegram
        .sendMessage(
          chatId,
          '📩 Анализ продолжается в фоне — он занимает несколько минут.\n\n' +
            'Оставьте, пожалуйста, ваш email — как только отчёт будет готов, ' +
            'мы вышлем его вам в виде PDF.'
        )
        .catch(() => {});
    }
  }, config.fakeProgressDelayMs);
  session.timers.push(emailTimer);
}

function clearTimers(session) {
  (session.timers || []).forEach(clearTimeout);
  session.timers = [];
}

/**
 * Запускает реальный анализ школы через Claude (в фоне).
 */
function startAnalysis(bot, chatId, session, url) {
  session.state = 'analyzing';
  session.url = url;
  session.email = null;
  session.analysisResult = null;
  session.analysisError = null;

  session.analysisPromise = runSchoolAudit(url)
    .then((result) => {
      session.analysisResult = result;
      return result;
    })
    .catch((err) => {
      console.error('Ошибка анализа Claude:', err);
      session.analysisError = err;
      throw err;
    });

  scheduleProgressMessages(bot, chatId, session);
}

/**
 * Дожидается результата анализа, генерирует PDF, отправляет его на email
 * и уведомляет пользователя в Telegram.
 */
async function finalizeAndDeliver(ctx, session) {
  const chatId = ctx.chat.id;

  try {
    await ctx.reply('⏳ Ожидаю завершения анализа, это может занять несколько минут...');
    const markdownBody = await session.analysisPromise;

    await ctx.reply('📝 Анализ готов, формирую PDF-отчёт...');
    const pdfPath = await generateAuditPdf({
      siteUrl: session.url,
      markdownBody,
    });

    await ctx.reply('📧 Отправляю отчёт на вашу почту...');
    await sendAuditReport({
      to: session.email,
      siteUrl: session.url,
      pdfPath,
    });

    session.state = 'done';
    await ctx.reply(
      `✅ Готово! Отчёт по школе ${session.url} отправлен на ${session.email}.\n\n` +
        'Чтобы проанализировать другой сайт — просто пришлите новую ссылку.'
    );
  } catch (err) {
    console.error('Ошибка при финализации отчёта:', err);
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
    resetSession(ctx.from.id);
    await ctx.reply(
      '👋 Привет! Я AI-аудитор онлайн-школ.\n\n' +
        'Пришлите мне ссылку на сайт онлайн-школы — и я проведу комплексный ' +
        'аудит продукта, маркетинга, продаж, сайта, автоматизации и AI-возможностей.\n\n' +
        'В процессе я попрошу у вас email — на него придёт готовый PDF-отчёт.\n\n' +
        'Пример: https://example-school.com'
    );
  });

  bot.help(async (ctx) => {
    await ctx.reply(
      'Как пользоваться:\n' +
        '1. Пришлите ссылку на сайт онлайн-школы.\n' +
        '2. Дождитесь запроса email (это займёт около 30 секунд).\n' +
        '3. Введите email — отчёт придёт туда в виде PDF, когда анализ завершится.\n\n' +
        'Команда /start — начать заново.'
    );
  });

  bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const chatId = ctx.chat.id;
    const text = ctx.message.text.trim();
    const session = getSession(userId);

    // Игнорируем другие команды здесь (обрабатываются отдельными handlers)
    if (text.startsWith('/')) return;

    switch (session.state) {
      case 'idle':
      case 'done': {
        const url = normalizeUrl(text);
        if (!url) {
          await ctx.reply(
            '🔗 Пожалуйста, пришлите корректную ссылку на сайт школы, например: https://example-school.com'
          );
          return;
        }
        await ctx.reply(`🚀 Начинаю комплексный анализ школы: ${url}\n\nЭто займёт несколько минут...`);
        startAnalysis(bot, chatId, session, url);
        break;
      }

      case 'analyzing': {
        await ctx.reply('⏳ Анализ ещё выполняется, немного подождите — скоро попрошу у вас email.');
        break;
      }

      case 'awaiting_email': {
        if (!EMAIL_RE.test(text)) {
          await ctx.reply('📧 Похоже, это не похоже на email. Пришлите, пожалуйста, корректный адрес почты.');
          return;
        }
        session.email = text;
        session.state = 'processing_email';
        clearTimers(session);
        await ctx.reply(`Принято ✅ Как только отчёт будет готов — вышлю его на ${text}.`);
        // Не блокируем event loop — доставка идёт в фоне.
        finalizeAndDeliver(ctx, session).catch((e) => console.error(e));
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

  bot.catch((err, ctx) => {
    console.error(`Необработанная ошибка для ${ctx.updateType}:`, err);
  });

  return bot;
}

module.exports = { createBot };
