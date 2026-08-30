const http = require('http');
const { createBot } = require('./bot');
const { closeBrowser } = require('./pdf');
const { closeMailer } = require('./mailer');
const { cancelAllPendingRequests } = require('./claudeClient');
const { cleanupAllSessions } = require('./session');
const { cleanupAllRateLimits } = require('./rateLimiter');
const config = require('./config');

/**
 * Точка входа приложения.
 *
 * ИСПРАВЛЕНИЯ (Шаг 9):
 * - Реализован полноценный Graceful Shutdown для всех подсистем:
 *   * Telegram-бот (bot.stop)
 *   * Puppeteer browser (closeBrowser)
 *   * SMTP-транспортер (closeMailer)
 *   * Pending-запросы к Anthropic API (cancelAllPendingRequests)
 *   * In-memory сессии (cleanupAllSessions)
 *   * Rate-limiter данные (cleanupAllRateLimits)
 *   * Health-check HTTP-сервер
 * - Обработка сигналов SIGINT, SIGTERM.
 * - Обработка uncaughtException и unhandledRejection с корректным shutdown.
 * - Легковесный Health-check HTTP endpoint (встроенный http-модуль,
 *   без внешних зависимостей) с метриками состояния сервиса.
 * - Защита от повторного запуска shutdown через флаг isShuttingDown.
 * - Принудительный выход по таймауту, если graceful shutdown завис.
 */

// ============================================================================
// Конфигурация
// ============================================================================

const HEALTH_PORT = parseInt(process.env.HEALTH_PORT || '8080', 10);
const SHUTDOWN_TIMEOUT_MS = 30_000; // 30 сек на весь graceful shutdown

// ============================================================================
// Глобальное состояние
// ============================================================================

let bot = null;
let healthServer = null;
let isShuttingDown = false;
let startedAt = Date.now();

// Счётчики для health-check
const stats = {
  totalAuditsStarted: 0,
  totalAuditsCompleted: 0,
  totalAuditsFailed: 0,
  totalEmailsSent: 0,
  totalEmailsFailed: 0,
};

/**
 * Экспортируем счётчики, чтобы bot.js мог их инкрементировать.
 * Используем простой подход: bot.js может импортировать этот модуль
 * и вызывать updateStats().
 */
function updateStats(key, delta = 1) {
  if (key in stats) {
    stats[key] += delta;
  }
}

// ============================================================================
// Health-check HTTP endpoint
// ============================================================================

/**
 * Запускает легковесный HTTP-сервер для health-check.
 * Используется Docker/Kubernetes/мониторингом для проверки живости сервиса.
 *
 * GET /health — возвращает 200 OK с JSON-метаданными, если сервис жив.
 * GET /       — краткая страница статуса.
 *
 * Если порт занят — логируем ошибку, но не падаем (health-check опционален).
 */
function startHealthServer() {
  const server = http.createServer((req, res) => {
    // Базовая защита: логируем подозрительные запросы
    const url = req.url || '/';

    if (url === '/health' || url === '/healthz' || url === '/livez') {
      const uptimeMs = Date.now() - startedAt;
      const memoryUsage = process.memoryUsage();

      const payload = {
        status: isShuttingDown ? 'shutting_down' : 'ok',
        uptime: uptimeMs,
        uptimeHuman: formatDuration(uptimeMs),
        timestamp: new Date().toISOString(),
        node: process.version,
        memory: {
          rss: Math.round(memoryUsage.rss / 1024 / 1024),
          heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
          heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
          external: Math.round(memoryUsage.external / 1024 / 1024),
        },
        stats,
        bot: bot ? 'running' : 'not_started',
        pid: process.pid,
      };

      const statusCode = isShuttingDown ? 503 : 200;
      const body = JSON.stringify(payload, null, 2);

      res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (url === '/' || url === '/status') {
      const uptimeMs = Date.now() - startedAt;
      const html = `<!DOCTYPE html>
<html lang="ru">
<head><meta charset="UTF-8"><title>School Audit Bot — Status</title>
<style>
body { font-family: -apple-system, Segoe UI, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #1f2430; }
h1 { color: #4f46e5; }
.ok { color: #16a34a; font-weight: bold; }
.shutting { color: #dc2626; font-weight: bold; }
pre { background: #f3f4f6; padding: 12px; border-radius: 8px; overflow-x: auto; }
</style>
</head>
<body>
<h1>School Audit Bot</h1>
<p>Статус: <span class="${isShuttingDown ? 'shutting' : 'ok'}">${
        isShuttingDown ? 'shutting down' : 'ok'
      }</span></p>
<p>Uptime: ${formatDuration(uptimeMs)}</p>
<p>Node: ${process.version} | PID: ${process.pid}</p>
<h3>Статистика</h3>
<pre>${JSON.stringify(stats, null, 2)}</pre>
<p><a href="/health">/health</a> — JSON health-check</p>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[health] ❌ Порт ${HEALTH_PORT} уже занят. Health-check не запущен.`
      );
    } else {
      console.error('[health] ❌ Ошибка HTTP-сервера:', err);
    }
  });

  server.listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log(
      `🏥 Health-check сервер запущен на http://0.0.0.0:${HEALTH_PORT}/health`
    );
  });

  return server;
}

/**
 * Форматирует миллисекунды в читаемый вид (1d 2h 3m 4s).
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

/**
 * Последовательно закрывает все подсистемы.
 * Гарантирует, что каждый шаг будет выполнен (через try/catch),
 * даже если предыдущий упал с ошибкой.
 *
 * @param {string} signal — имя сигнала или причина shutdown
 */
async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    console.log(
      `[shutdown] ⚠️ Повторный сигнал ${signal} — shutdown уже идёт, игнорируем.`
    );
    return;
  }
  isShuttingDown = true;

  const startedAtShutdown = Date.now();
  console.log(
    `\n[shutdown] 🛑 Получен сигнал "${signal}". Начинаем graceful shutdown...`
  );

  // Таймаут на весь shutdown — если что-то зависнет, выходим принудительно
  const forceExitTimer = setTimeout(() => {
    console.error(
      `[shutdown] ⚠️ Graceful shutdown превысил таймаут ${SHUTDOWN_TIMEOUT_MS} мс. ` +
        `Принудительный выход с кодом 1.`
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  // Чтобы таймер не держал процесс открытым, если всё остальное завершилось
  if (typeof forceExitTimer.unref === 'function') forceExitTimer.unref();

  // 1. Останавливаем приём новых обновлений от Telegram
  if (bot) {
    try {
      console.log('[shutdown] 1/7 Останавливаем Telegram-бот...');
      await bot.stop(signal);
      console.log('[shutdown] ✅ Telegram-бот остановлен.');
    } catch (err) {
      console.error('[shutdown] ⚠️ Ошибка при остановке бота:', err?.message || err);
    }
  }

  // 2. Отменяем все pending-запросы к Anthropic API
  try {
    console.log('[shutdown] 2/7 Отменяем pending-запросы к Anthropic API...');
    cancelAllPendingRequests();
    console.log('[shutdown] ✅ Pending-запросы отменены.');
  } catch (err) {
    console.error(
      '[shutdown] ⚠️ Ошибка при отмене запросов:',
      err?.message || err
    );
  }

  // 3. Закрываем SMTP-транспортер
  try {
    console.log('[shutdown] 3/7 Закрываем SMTP-транспортер...');
    await closeMailer();
    console.log('[shutdown] ✅ SMTP-транспортер закрыт.');
  } catch (err) {
    console.error(
      '[shutdown] ⚠️ Ошибка при закрытии mailer:',
      err?.message || err
    );
  }

  // 4. Закрываем Puppeteer browser
  try {
    console.log('[shutdown] 4/7 Закрываем Puppeteer browser...');
    await closeBrowser();
    console.log('[shutdown] ✅ Puppeteer browser закрыт.');
  } catch (err) {
    console.error(
      '[shutdown] ⚠️ Ошибка при закрытии browser:',
      err?.message || err
    );
  }

  // 5. Очищаем in-memory сессии (с очисткой всех таймеров)
  try {
    console.log('[shutdown] 5/7 Очищаем сессии...');
    cleanupAllSessions();
    console.log('[shutdown] ✅ Сессии очищены.');
  } catch (err) {
    console.error(
      '[shutdown] ⚠️ Ошибка при очистке сессий:',
      err?.message || err
    );
  }

  // 6. Очищаем данные rate-limiter
  try {
    console.log('[shutdown] 6/7 Очищаем rate-limiter...');
    cleanupAllRateLimits();
    console.log('[shutdown] ✅ Rate-limiter очищен.');
  } catch (err) {
    console.error(
      '[shutdown] ⚠️ Ошибка при очистке rate-limiter:',
      err?.message || err
    );
  }

  // 7. Закрываем health-check HTTP-сервер
  if (healthServer) {
    try {
      console.log('[shutdown] 7/7 Закрываем health-check сервер...');
      await new Promise((resolve, reject) => {
        healthServer.close((err) => (err ? reject(err) : resolve()));
      });
      console.log('[shutdown] ✅ Health-check сервер закрыт.');
    } catch (err) {
      console.error(
        '[shutdown] ⚠️ Ошибка при закрытии health-сервера:',
        err?.message || err
      );
    }
  }

  clearTimeout(forceExitTimer);

  const elapsed = Date.now() - startedAtShutdown;
  console.log(
    `[shutdown] ✅ Graceful shutdown завершён за ${elapsed} мс. Выходим.`
  );
  process.exit(0);
}

// ============================================================================
// Обработчики сигналов и необработанных ошибок
// ============================================================================

// SIGINT — Ctrl+C в терминале
process.once('SIGINT', () => gracefulShutdown('SIGINT'));

// SIGTERM — стандартный сигнал для Docker/Kubernetes при остановке контейнера
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

// SIGHUP — часто используется для graceful reload
process.once('SIGHUP', () => gracefulShutdown('SIGHUP'));

// uncaughtException — последняя линия обороны. Логируем и shutdown.
process.on('uncaughtException', (err) => {
  console.error('[fatal] ❌ Uncaught Exception:', err);
  console.error('[fatal] Стек:', err?.stack);
  gracefulShutdown('uncaughtException');
});

// unhandledRejection — необработанные rejected Promise
process.on('unhandledRejection', (reason, promise) => {
  console.error('[fatal] ❌ Unhandled Rejection at:', promise);
  console.error('[fatal] Reason:', reason);
  gracefulShutdown('unhandledRejection');
});

// ============================================================================
// Основная функция запуска
// ============================================================================

async function main() {
  console.log('🚀 Запуск School Audit Bot...');
  console.log(`📦 Node.js ${process.version} | PID ${process.pid}`);
  console.log(`🤖 Модель: ${config.anthropic.model}`);
  console.log(`🔎 Web search: ${config.anthropic.webSearch ? 'включён' : 'выключен'}`);

  // 1. Создаём и запускаем Telegram-бот
  bot = await createBot();
  await bot.launch();
  console.log('🤖 Telegram-бот запущен (long polling).');

  // 2. Запускаем health-check сервер
  healthServer = startHealthServer();

  startedAt = Date.now();
  console.log(
    `✅ School Audit Bot полностью готов к работе. Health-check: http://localhost:${HEALTH_PORT}/health`
  );
}

// Запуск с обработкой ошибок на старте
main().catch((err) => {
  console.error('❌ Не удалось запустить бота:', err);
  console.error('Стек:', err?.stack);
  process.exit(1);
});

// Экспортируем для возможного использования в тестах / других модулях
module.exports = { updateStats, stats };