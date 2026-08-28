const path = require('path');
const fs = require('fs/promises');
const os = require('os');
const MarkdownIt = require('markdown-it');
const puppeteer = require('puppeteer');
const config = require('./config');

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

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

function buildHtml({ siteUrl, markdownBody, generatedAt }) {
  const bodyHtml = md.render(markdownBody);

  const dateStr = generatedAt.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<style>${CSS}</style>
</head>
<body>
  <section class="cover">
    <div class="badge">AI Audit Report</div>
    <h1>Комплексный аудит онлайн-школы</h1>
    <div class="subtitle">Продукт · Маркетинг · Продажи · Автоматизация · AI</div>
    <div class="meta">
      Сайт: ${escapeHtml(siteUrl)}<br/>
      Дата отчёта: ${dateStr}
    </div>
  </section>

  ${bodyHtml}

  <div class="contact-block">
    <h2>Для связи</h2>
    <p><strong>${escapeHtml(config.contact.name)}</strong><br/>
    ${escapeHtml(config.contact.telegram)}</p>
  </div>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Генерирует PDF-файл отчёта и возвращает путь к нему.
 * @param {{siteUrl: string, markdownBody: string}} params
 * @returns {Promise<string>} путь к сгенерированному PDF
 */
async function generateAuditPdf({ siteUrl, markdownBody }) {
  const html = buildHtml({ siteUrl, markdownBody, generatedAt: new Date() });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    const outDir = path.join(os.tmpdir(), 'school-audit-bot');
    await fs.mkdir(outDir, { recursive: true });
    const filePath = path.join(outDir, `audit-${Date.now()}.pdf`);

    await page.pdf({
      path: filePath,
      format: 'A4',
      printBackground: true,
    });

    return filePath;
  } finally {
    await browser.close();
  }
}

module.exports = { generateAuditPdf };
