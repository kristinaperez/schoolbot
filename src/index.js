const { createBot } = require('./bot');

async function main() {
  const bot = await createBot();

  await bot.launch();
  console.log('🤖 School Audit Bot запущен (long polling).');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main().catch((err) => {
  console.error('Не удалось запустить бота:', err);
  process.exit(1);
});
