/**
 * Простое in-memory хранилище состояния диалога на каждого пользователя.
 * Состояния (session.state):
 * idle              — ждём ссылку на сайт школы
 * analyzing         — анализ запущен, ждём либо email, либо готовности PDF
 * awaiting_email    — прошло FAKE_PROGRESS_DELAY_MS, просим email
 * processing_email  — email получен, идёт финальная сборка и отправка
 * done              — отчёт отправлен, можно начинать заново
 */

const SESSION_TTL_MS = 60 * 60 * 1000; // Время жизни сессии: 1 час
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Проверка и очистка каждые 5 минут

const sessions = new Map();

// Периодическая очистка устаревших сессий для предотвращения утечки памяти (Memory Leak)
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of sessions.entries()) {
    if (now - session.lastAccessed > SESSION_TTL_MS) {
      // Гарантированно очищаем все таймеры перед удалением сессии
      if (session.timers && Array.isArray(session.timers)) {
        session.timers.forEach(clearTimeout);
      }
      sessions.delete(userId);
    }
  }
}, CLEANUP_INTERVAL_MS);

// Подготовка к graceful shutdown: очистка интервала при завершении процесса
if (typeof process !== 'undefined') {
  process.on('exit', () => {
    clearInterval(cleanupInterval);
  });
}

/**
 * Получает или создаёт сессию для пользователя.
 * Обновляет timestamp последнего доступа для корректной работы TTL.
 * @param {number|string} userId 
 * @returns {object} Объект сессии
 */
function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      state: 'idle',
      url: null,
      email: null,
      analysisPromise: null,
      analysisResult: null,
      analysisError: null,
      timers: [], // 🔴 ИСПРАВЛЕНО: синхронизировано с bot.js (было progressTimer: null)
      lastAccessed: Date.now(),
    });
  } else {
    // Обновляем время последнего доступа при активном использовании
    const session = sessions.get(userId);
    session.lastAccessed = Date.now();
  }
  return sessions.get(userId);
}

/**
 * Сбрасывает сессию пользователя в начальное состояние.
 * Гарантирует очистку всех активных таймеров, чтобы избежать утечек и фантомных сообщений.
 * @param {number|string} userId 
 */
function resetSession(userId) {
  const s = sessions.get(userId);
  if (s) {
    // 🔴 ИСПРАВЛЕНО: очистка массива таймеров вместо одиночного progressTimer
    if (s.timers && Array.isArray(s.timers)) {
      s.timers.forEach(clearTimeout);
    }
    
    sessions.set(userId, {
      state: 'idle',
      url: null,
      email: null,
      analysisPromise: null,
      analysisResult: null,
      analysisError: null,
      timers: [],
      lastAccessed: Date.now(),
    });
  }
}

/**
 * Полная очистка всех сессий и таймеров.
 * Используется при graceful shutdown для корректного завершения работы.
 */
function cleanupAllSessions() {
  clearInterval(cleanupInterval);
  for (const session of sessions.values()) {
    if (session.timers && Array.isArray(session.timers)) {
      session.timers.forEach(clearTimeout);
    }
  }
  sessions.clear();
}

module.exports = { getSession, resetSession, cleanupAllSessions };