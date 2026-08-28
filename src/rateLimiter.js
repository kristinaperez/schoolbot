const config = require('./config');

/**
 * Простой in-memory rate limiter на пользователя.
 *
 * Логика:
 *  - для каждого userId храним временные метки последних запросов;
 *  - если за последние `windowMs` миллисекунд накопилось больше,
 *    чем `maxRequests` запросов — пользователь получает временный
 *    бан на `banMs` миллисекунд;
 *  - пока бан активен, все сообщения от пользователя игнорируются
 *    (с одним уведомлением о том, что он в бане).
 *
 * ВАЖНО: хранилище в памяти процесса. Если бот когда-нибудь будет
 * запускаться в нескольких инстансах (кластер/несколько подов),
 * нужно вынести это в Redis (например, через отдельный store).
 */

const requestLog = new Map(); // userId -> [timestamps]
const bannedUntil = new Map(); // userId -> timestamp мс, до которого забанен
const notifiedBan = new Set(); // userId, которым уже отправили уведомление о бане

function cleanupOldTimestamps(timestamps, now) {
  const windowStart = now - config.rateLimit.windowMs;
  while (timestamps.length && timestamps[0] < windowStart) {
    timestamps.shift();
  }
  return timestamps;
}

function rateLimiterMiddleware() {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return next();

    const now = Date.now();

    // Пользователь всё ещё в бане
    const banExpiry = bannedUntil.get(userId);
    if (banExpiry && now < banExpiry) {
      if (!notifiedBan.has(userId)) {
        notifiedBan.add(userId);
        const secondsLeft = Math.ceil((banExpiry - now) / 1000);
        try {
          await ctx.reply(
            `⏳ Слишком много запросов подряд. Подождите ${secondsLeft} сек. и попробуйте снова.`
          );
        } catch (_) {
          // игнорируем ошибки отправки (например, пользователь заблокировал бота)
        }
      }
      return; // не пропускаем дальше по цепочке middleware
    }

    // Бан истёк — снимаем отметку
    if (banExpiry && now >= banExpiry) {
      bannedUntil.delete(userId);
      notifiedBan.delete(userId);
    }

    // Считаем запросы в скользящем окне
    let timestamps = requestLog.get(userId) || [];
    timestamps = cleanupOldTimestamps(timestamps, now);
    timestamps.push(now);
    requestLog.set(userId, timestamps);

    if (timestamps.length > config.rateLimit.maxRequests) {
      bannedUntil.set(userId, now + config.rateLimit.banMs);
      requestLog.set(userId, []);
      try {
        await ctx.reply(
          `🚫 Обнаружен слишком быстрый поток запросов. Временный бан на ${Math.round(
            config.rateLimit.banMs / 1000
          )} сек.`
        );
      } catch (_) {}
      return;
    }

    return next();
  };
}

module.exports = { rateLimiterMiddleware };
