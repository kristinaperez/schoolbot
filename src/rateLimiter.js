const config = require('./config');

/**
 * Простой in-memory rate limiter на пользователя.
 * Логика:
 * - для каждого userId храним временные метки последних запросов;
 * - если за последние `windowMs` миллисекунд накопилось больше,
 *   чем `maxRequests` запросов — пользователь получает временный
 *   бан на `banMs` миллисекунд;
 * - пока бан активен, все сообщения от пользователя игнорируются
 *   (с одним уведомлением о том, что он в бане).
 * 
 * ВАЖНО: хранилище в памяти процесса. Реализована автоматическая
 * очистка устаревших записей для предотвращения утечек памяти.
 */

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Проверка и очистка каждые 5 минут
const DATA_TTL_MS = 60 * 60 * 1000; // Время жизни записей: 1 час (совпадает с TTL сессий)

const requestLog = new Map(); // userId -> number[] (временные метки)
const bannedUntil = new Map(); // userId -> number (timestamp, до которого забанен)
const notifiedBan = new Set(); // userId, которым уже отправили уведомление о бане

/**
 * Периодическая глобальная очистка устаревших записей для всех пользователей.
 * Предотвращает бесконечный рост Map и Set (Memory Leak).
 */
function cleanupExpiredData() {
  const now = Date.now();
  const expirationTime = now - DATA_TTL_MS;

  // Очистка requestLog
  for (const [userId, timestamps] of requestLog.entries()) {
    // Оставляем только те метки, которые моложе TTL
    const validTimestamps = timestamps.filter((ts) => ts > expirationTime);
    if (validTimestamps.length === 0) {
      requestLog.delete(userId);
    } else {
      requestLog.set(userId, validTimestamps);
    }
  }

  // Очистка bannedUntil и notifiedBan
  for (const [userId, banExpiry] of bannedUntil.entries()) {
    if (banExpiry < expirationTime) {
      bannedUntil.delete(userId);
      notifiedBan.delete(userId);
    }
  }
}

// Запуск периодической очистки
const cleanupInterval = setInterval(cleanupExpiredData, CLEANUP_INTERVAL_MS);

// Подготовка к graceful shutdown: очистка интервала при завершении процесса
if (typeof process !== 'undefined') {
  process.on('exit', () => {
    clearInterval(cleanupInterval);
  });
}

/**
 * Middleware для ограничения частоты запросов.
 */
function rateLimiterMiddleware() {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();

    const now = Date.now();
    const banExpiry = bannedUntil.get(userId);

    // 1. Пользователь всё ещё в бане
    if (banExpiry && now < banExpiry) {
      if (!notifiedBan.has(userId)) {
        notifiedBan.add(userId);
        const secondsLeft = Math.ceil((banExpiry - now) / 1000);
        try {
          await ctx.reply(
            `⏳ Слишком много запросов подряд. Подождите ${secondsLeft} сек. и попробуйте снова.`
          );
        } catch (_) {
          // Игнорируем ошибки отправки (например, пользователь заблокировал бота)
        }
      }
      return; // Не пропускаем дальше по цепочке middleware
    }

    // 2. Бан истёк — снимаем отметки
    if (banExpiry && now >= banExpiry) {
      bannedUntil.delete(userId);
      notifiedBan.delete(userId);
    }

    // 3. Считаем запросы в скользящем окне
    let timestamps = requestLog.get(userId) || [];
    
    // ⚠️ ОПТИМИЗАЦИЯ: заменяем O(N²) цикл с shift() на O(N) фильтр.
    // Это значительно эффективнее и предотвращает деградацию производительности.
    const windowStart = now - config.rateLimit.windowMs;
    timestamps = timestamps.filter((ts) => ts >= windowStart);

    timestamps.push(now);
    requestLog.set(userId, timestamps);

    // 4. Проверка лимита
    if (timestamps.length > config.rateLimit.maxRequests) {
      bannedUntil.set(userId, now + config.rateLimit.banMs);
      requestLog.set(userId, []); // Сбрасываем историю, чтобы после бана отсчёт начался заново
      
      try {
        await ctx.reply(
          `🚫 Обнаружен слишком быстрый поток запросов. Временный бан на ${Math.round(
            config.rateLimit.banMs / 1000
          )} сек.`
        );
      } catch (_) {
        // Игнорируем ошибки отправки
      }
      return; // Не пропускаем дальше по цепочке middleware
    }

    return next();
  };
}

/**
 * Полная очистка всех данных rate limiter.
 * Используется при graceful shutdown для корректного завершения работы.
 */
function cleanupAllRateLimits() {
  clearInterval(cleanupInterval);
  requestLog.clear();
  bannedUntil.clear();
  notifiedBan.clear();
}

module.exports = { rateLimiterMiddleware, cleanupAllRateLimits };