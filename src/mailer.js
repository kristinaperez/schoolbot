const nodemailer = require('nodemailer');
const config = require('./config');

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user
        ? { user: config.smtp.user, pass: config.smtp.pass }
        : undefined,
    });
  }
  return transporter;
}

/**
 * Отправляет PDF-отчёт на email пользователя.
 * @param {{to: string, siteUrl: string, pdfPath: string}} params
 */
async function sendAuditReport({ to, siteUrl, pdfPath }) {
  const mailer = getTransporter();

  await mailer.sendMail({
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
  });
}

module.exports = { sendAuditReport };
