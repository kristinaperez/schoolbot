/**
 * Простое in-memory хранилище состояния диалога на каждого пользователя.
 *
 * Состояния (session.state):
 *  - idle              — ждём ссылку на сайт школы
 *  - analyzing         — анализ запущен, ждём либо email, либо готовности PDF
 *  - awaiting_email     — уже прошло FAKE_PROGRESS_DELAY_MS, просим email
 *  - done              — отчёт отправлен, можно начинать заново
 */

const sessions = new Map();

function getSession(userId) {
  if (!sessions.has(userId)) {
    sessions.set(userId, {
      state: 'idle',
      url: null,
      email: null,
      analysisPromise: null, // Promise<string> — markdown-отчёт
      analysisResult: null, // string | null, когда промис зарезолвился
      analysisError: null,
      progressTimer: null,
    });
  }
  return sessions.get(userId);
}

function resetSession(userId) {
  const s = getSession(userId);
  if (s.progressTimer) clearTimeout(s.progressTimer);
  sessions.set(userId, {
    state: 'idle',
    url: null,
    email: null,
    analysisPromise: null,
    analysisResult: null,
    analysisError: null,
    progressTimer: null,
  });
}

module.exports = { getSession, resetSession };
