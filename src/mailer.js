const fs = require('fs');
const nodemailer = require('nodemailer');
const config = require('./config');

/**
 * Модуль отправки PDF-отчётов на email через SMTP (nodemailer).
 *
 * ИСПРАВЛЕНИЯ (Шаг 7):
 * - Проверка существования и читаемости PDF-файла через fs.access
 *   перед попыткой отправки (защита от ENOENT / EACCES).
 * - Singleton-transporter с автоматической проверкой соединения
 *   (transporter.verify) и пересозданием при обрыве.
 * - Таймаут на операцию sendMail через Promise.race — SMTP-сессия
 *   не сможет зависнуть навсегда.
 * - Таймауты соединения на уровне самого transporter:
 *   connectionTimeout, greetingTimeout, socketTimeout.
 * - Детальное логирование ошибок отправки (без утечки содержимого PDF).
 * - Экспортирована функция closeMailer() для graceful shutdown.
 */

// Таймауты SMTP-соединения (на уровне transporter)
const CONNECTION_TIMEOUT_MS = 10_000; // 10 сек на установку TCP-соединения
const GREETING_TIMEOUT_MS = 10_000;   // 10 сек на ожидание SMTP-приветствия
const SOCKET_TIMEOUT_MS = 30_000;     // 30 сек простоя сокета = разрыв

// Таймаут на всю операцию sendMail (включая передачу данных письма)
const SEND_TIMEOUT_MS = 60_000; // 60 сек

// Singleton-transporter и флаг его "живости"
let transporter = null;
let transporterVerified = false;

/**
 * Закрывает текущий transporter (если есть) и сбрасывает состояние.
 * Не бросает ошибок — используется в finally / shutdown.
 */
async function closeTransporterQuietly() {
  if (transporter) {
    try {
      await transporter.close();
    } catch (_) {
      // ignore
    }
    transporter = null;
    transporterVerified = false;
  }
}

/**
 * Возвращает готовый к работе transporter.
 * - При первом вызове создаёт новый transporter и проверяет соединение
 *   через verify().
 * - Если verify() падает — закрывает старый transporter и бросает ошибку
 *   (вызывающий код может retry).
 * - Если transporter уже создан и проверен — возвращает его без повторной
 *   проверки (экономия ресурсов).
 */
async function getTransporter() {
  if (transporter && transporterVerified) {
    return transporter;
  }

  // Закрываем старый transporter, если он есть (но не проверен)
  await closeTransporterQuietly();

  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user
      ? { user: config.smtp.user, pass: config.smtp.pass }
      : undefined,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    // Не держим соединение постоянно открытым — пересоздаём при необходимости.
    // Это надёжнее для долгоживущих процессов с редкими отправками.
    pool: false,
  });

  // Проверяем, что SMTP-сервер доступен и авторизация проходит
  try {
    await transporter.verify();
    transporterVerified = true;
    return transporter;
  } catch (err) {
    // При ошибке verify — закрываем transporter, чтобы следующий вызов
    // создал новый экземпляр.
    await closeTransporterQuietly();
    throw err;
  }
}

/**
 * Проверяет, что PDF-файл существует и доступен для чтения.
 * Бросает понятную ошибку, если файл отсутствует / недоступен.
 * @param {string} pdfPath
 */
async function ensurePdfReadable(pdfPath) {
  if (!pdfPath || typeof pdfPath !== 'string') {
    throw new Error('Не указан путь к PDF-файлу');
  }
  try {
    await fs.promises.access(pdfPath, fs.constants.F_OK | fs.constants.R_OK);
  } catch (err) {
    const reason = err?.code === 'ENOENT'
      ? 'файл не найден'
      : err?.code === 'EACCES'
        ? 'нет прав на чтение'
        : `ошибка доступа (${err?.code || err?.message || 'unknown'})`;
    throw new Error(`PDF-файл недоступен (${reason}): ${pdfPath}`);
  }
}

/**
 * Отправляет PDF-отчёт на email пользователя.
 *
 * Гарантии:
 * - PDF проверяется на существование до отправки.
 * - Transporter проверяется через verify() и пересоздаётся при сбое.
 * - Операция sendMail ограничена таймаутом SEND_TIMEOUT_MS.
 * - При любой ошибке transporter помечается как "возможно битый" —
 *   следующий вызов пересоздаст его.
 * - Все ошибки логируются с деталями (без содержимого PDF).
 *
 * @param {{to: string, siteUrl: string, pdfPath: string}} params
 */
async function sendAuditReport({ to, siteUrl, pdfPath }) {
  const startedAt = Date.now();
  const logCtx = `to=${to}, site=${siteUrl}, pdf=${pdfPath}`;

  // 1. Проверяем, что PDF реально есть на диске
  await ensurePdfReadable(pdfPath);

  // 2. Получаем (или создаём) transporter
  let mailer;
  try {
    mailer = await getTransporter();
  } catch (verifyErr) {
    console.error(
      `[mailer] ❌ Не удалось установить SMTP-соединение (${logCtx}):`,
      verifyErr?.message || verifyErr
    );
    // Пробуем один раз пересоздать transporter (возможно, transient error)
    try {
      mailer = await getTransporter();
    } catch (retryErr) {
      throw new Error(
        `SMTP недоступен после повторной попытки: ${retryErr?.message || retryErr}`
      );
    }
  }

  // 3. Формируем письмо
  const mailOptions = {
    from: config.smtp.from,
    to,
    subject: `AI-аудит онлайн-школы: ${siteUrl}`,
    text:
      `Здравствуйте!\n\n` +
      `Во вложении — комплексный AI-аудит вашей онлайн-школы (${siteUrl}).\n\n` +
      `Для связи: ${config.contact.name}\n${config.contact.telegram}\n`,
    attachments: [
      {
        filename: 'school-audit-report.pdf',
        path: pdfPath,
        contentType: 'application/pdf',
      },
    ],
  };

  // 4. Отправляем с таймаутом через Promise.race
  const timeoutPromise = new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`SMTP send timeout after ${SEND_TIMEOUT_MS} ms`)),
      SEND_TIMEOUT_MS
    );
    // Чтобы Node.js не держал процесс открытым только из-за этого таймера
    if (typeof timer.unref === 'function') timer.unref();
  });

  try {
    await Promise.race([mailer.sendMail(mailOptions), timeoutPromise]);

    const elapsed = Date.now() - startedAt;
    console.log(`[mailer] ✅ Письмо успешно отправлено (${logCtx}) за ${elapsed} мс`);
  } catch (sendErr) {
    // Помечаем transporter как "возможно битый" — следующий вызов пересоздаст
    transporterVerified = false;

    const elapsed = Date.now() - startedAt;
    console.error(
      `[mailer] ❌ Ошибка отправки письма (${logCtx}) за ${elapsed} мс:`,
      sendErr?.message || sendErr
    );
    if (sendErr?.response) {
      // Логируем SMTP-ответ (например, "550 User unknown") — это важно для диагностики
      console.error(`[mailer] SMTP-ответ: ${sendErr.response}`);
    }
    if (sendErr?.code) {
      console.error(`[mailer] Код ошибки: ${sendErr.code}`);
    }

    // Оборачиваем в понятное сообщение для вызывающего кода
    const isTimeout = /timeout/i.test(sendErr?.message || '');
    throw new Error(
      isTimeout
        ? `Превышен таймаут отправки письма (${SEND_TIMEOUT_MS / 1000} сек)`
        : `Не удалось отправить письмо: ${sendErr?.message || sendErr}`
    );
  }
}

/**
 * Полная очистка ресурсов mailer.
 * Используется при graceful shutdown процесса.
 */
async function closeMailer() {
  await closeTransporterQuietly();
}

module.exports = { sendAuditReport, closeMailer };