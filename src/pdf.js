const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const MarkdownIt = require('markdown-it');
const puppeteer = require('puppeteer');
const config = require('./config');

/**
 * Модуль генерации PDF-отчёта из Markdown.
 *
 * ИСПРАВЛЕНИЯ (Шаг 6):
 * - Исправлены ВСЕ синтаксические опечатки в CSS (b order-box → border-box,
 *   uppercas e → uppercase, i nline-block → inline-block, be fore → before,
 *   mar gin → margin, ba ckground → background, bor der-top → border-top,
 *   so lid → solid, r ender → render, а также сломанный escapeHtml).
 * - Реализован singleton для Puppeteer browser — один экземпляр Chromium
 *   переиспользуется между генерациями PDF (вместо launch на каждый PDF).
 * - Убран устаревший параметр headless: 'new' → заменён на headless: true.
 * - Добавлена функция withAuditPdf(params, callback) с гарантированным
 *   удалением временного PDF-файла в блоке try...finally.
 * - Добавлена функция cleanupAuditPdf для ручной очистки (если нужно).
 * - Добавлена функция closeBrowser для graceful shutdown.
 */

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

// 🔴 ИСПРАВЛЕНО: все CSS-опечатки удалены, стили валидны
const CSS = `
  @page { margin: 22mm 18mm 22mm 18mm; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Helvetica Neue', Arial, 'DejaVu Sans', sans-serif;
    color: #1f2430;
    font-size: 12px;
    line-height: 1.55;
  }
  .cover {
    height: 250mm;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: flex-start;
    page-break-after: always;
  }
  .cover .badge {
    display: inline-block;
    background: #4f46e5;
    color: #fff;
    padding: 6px 14px;
    border-radius: 999px;
    font-size: 12px;
    letter-spacing: .05em;
    text-transform: uppercase;
    margin-bottom: 24px;
  }
  .cover h1 {
    font-size: 30px;
    margin: 0 0 12px 0;
    color: #111827;
  }
  .cover .subtitle {
    font-size: 15px;
    color: #4b5563;
    margin-bottom: 40px;
  }
  .cover .meta {
    font-size: 12px;
    color: #6b7280;
    border-top: 1px solid #e5e7eb;
    padding-top: 16px;
    margin-top: 24px;
    width: 100%;
  }
  h1 {
    font-size: 20px;
    color: #111827;
    margin-top: 30px;
    margin-bottom: 10px;
    border-bottom: 2px solid #4f46e5;
    padding-bottom: 6px;
    page-break-before: auto;
  }
  h2 {
    font-size: 16px;
    color: #1f2937;
    margin-top: 20px;
    margin-bottom: 8px;
  }
  h3 {
    font-size: 13.5px;
    color: #374151;
    margin-top: 14px;
    margin-bottom: 6px;
  }
  p { margin: 6px 0; }
  ul, ol { margin: 6px 0; padding-left: 20px; }
  li { margin: 3px 0; }
  strong { color: #111827; }
  blockquote {
    margin: 8px 0;
    padding: 8px 12px;
    border-left: 3px solid #4f46e5;
    background: #f5f5ff;
    color: #374151;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 10px 0 16px 0;
    font-size: 10.5px;
  }
  th, td {
    border: 1px solid #d1d5db;
    padding: 5px 7px;
    text-align: left;
    vertical-align: top;
  }
  th {
    background: #f3f4f6;
    color: #111827;
  }
  code {
    background: #f3f4f6;
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 11px;
  }
  hr {
    border: none;
    border-top: 1px solid #e5e7eb;
    margin: 18px 0;
  }
  .contact-block {
    margin-top: 30px;
    padding: 16px;
    background: #f5f5ff;
    border-radius: 10px;
    border: 1px solid #e0e0fb;
    page-break-inside: avoid;
  }
  .contact-block h2 {
    margin-top: 0;
  }
`;

/**
 * Экранирует HTML-спецсимволы для безопасной вставки в HTML-шаблон.
 * 🔴 ИСПРАВЛЕНО: в исходнике замены были сломаны (& → &, //<regex> вместо /</g и />/g).
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Собирает полный HTML-документ из Markdown-отчёта.
 */
function buildHtml({ siteUrl, markdownBody, generatedAt }) {
  // 🔴 ИСПРАВЛЕНО: md.r ender → md.render
  const bodyHtml = md.render(markdownBody);

  const dateStr = generatedAt.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });

  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>AI Audit Report</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="cover">
    <div class="badge">AI Audit Report</div>
    <h1>Комплексный аудит онлайн-школы</h1>
    <div class="subtitle">Продукт · Маркетинг · Продажи · Автоматизация · AI</div>
    <div class="meta">
      <div><strong>Сайт:</strong> ${escapeHtml(siteUrl)}</div>
      <div><strong>Дата отчёта:</strong> ${dateStr}</div>
    </div>
  </div>

  ${bodyHtml}

  <div class="contact-block">
    <h2>Для связи</h2>
    <p><strong>${escapeHtml(config.contact.name)}</strong></p>
    <p>${escapeHtml(config.contact.telegram)}</p>
  </div>
</body>
</html>`;
}

// ============================================================================
// Singleton для Puppeteer browser
// ============================================================================

let browserPromise = null;
let browserInstance = null;

/**
 * Возвращает singleton-экземпляр Puppeteer browser.
 * При первом вызове — запускает Chromium, при последующих — переиспользует.
 * 🔴 ИСПРАВЛЕНО: убран устаревший headless: 'new', заменён на headless: true.
 */
async function getBrowser() {
  if (browserInstance && browserInstance.connected) {
    return browserInstance;
  }
  if (browserPromise) {
    return browserPromise;
  }

  browserPromise = (async () => {
    try {
      const browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--single-process',
        ],
      });

      // Если браузер неожиданно закрылся — сбрасываем singleton,
      // чтобы следующий вызов запустил новый экземпляр.
      browser.on('disconnected', () => {
        browserInstance = null;
        browserPromise = null;
      });

      browserInstance = browser;
      return browser;
    } catch (err) {
      // При ошибке запуска — сбрасываем promise, чтобы можно было retry.
      browserPromise = null;
      throw err;
    }
  })();

  return browserPromise;
}

/**
 * Закрывает singleton browser. Используется при graceful shutdown.
 */
async function closeBrowser() {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch (_) {
      // ignore
    }
    browserInstance = null;
    browserPromise = null;
  }
}

// ============================================================================
// Генерация PDF
// ============================================================================

/**
 * Создаёт временную директорию для PDF (один раз, lazily).
 */
async function getTempDir() {
  const outDir = path.join(os.tmpdir(), 'school-audit-bot');
  await fs.mkdir(outDir, { recursive: true });
  return outDir;
}

/**
 * Генерирует PDF-файл отчёта и возвращает путь к нему.
 * ВАЖНО: вызывающий код ОБЯЗАН вызвать cleanupAuditPdf(filePath) после
 * использования файла, либо использовать withAuditPdf() для автоматической
 * очистки.
 *
 * @param {{siteUrl: string, markdownBody: string}} params
 * @returns {Promise<string>} путь к сгенерированному PDF
 */
async function generateAuditPdf({ siteUrl, markdownBody }) {
  const html = buildHtml({ siteUrl, markdownBody, generatedAt: new Date() });

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const outDir = await getTempDir();
    const filePath = path.join(outDir, `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`);

    await page.pdf({
      path: filePath,
      format: 'A4',
      printBackground: true,
    });

    return filePath;
  } finally {
    // Закрываем страницу, чтобы не держать её в памяти
    try {
      await page.close();
    } catch (_) {
      // ignore
    }
  }
}

/**
 * Удаляет временный PDF-файл с диска.
 * Не бросает ошибку, если файл уже удалён или отсутствует.
 * @param {string} filePath
 */
async function cleanupAuditPdf(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (err) {
    // Игнорируем "file not found" — это нормальная ситуация
    if (err?.code !== 'ENOENT') {
      console.warn(`[pdf] Не удалось удалить временный PDF ${filePath}:`, err.message);
    }
  }
}

/**
 * Высокоуровневая обёртка: генерирует PDF, передаёт путь в callback,
 * и ГАРАНТИРОВАННО удаляет временный файл в блоке try...finally,
 * даже если callback упал с ошибкой.
 *
 * Пример использования в bot.js:
 *   await withAuditPdf({ siteUrl, markdownBody }, async (pdfPath) => {
 *     await sendAuditReport({ to, siteUrl, pdfPath });
 *   });
 *
 * @param {{siteUrl: string, markdownBody: string}} params
 * @param {(pdfPath: string) => Promise<any>} callback
 * @returns {Promise<any>} результат callback
 */
async function withAuditPdf({ siteUrl, markdownBody }, callback) {
  const pdfPath = await generateAuditPdf({ siteUrl, markdownBody });
  try {
    return await callback(pdfPath);
  } finally {
    await cleanupAuditPdf(pdfPath);
  }
}

module.exports = {
  generateAuditPdf,
  cleanupAuditPdf,
  withAuditPdf,
  closeBrowser,
};