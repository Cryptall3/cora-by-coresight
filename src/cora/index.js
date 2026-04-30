import { BotManager } from './bot/bot-manager.js';
import { AlphaListener } from './listeners/alpha-listener.js';
import dotenv from 'dotenv';

dotenv.config();

async function startCora() {
  console.log('🤖 Starting Cora Agent Service...');

  // 1. Start the Telegram Bot Interface
  const bot = new BotManager();

  // 2. Start the Signal Listener (Ears)
  const alphaListener = new AlphaListener();
  await alphaListener.start();

  console.log('✅ Cora is fully operational and listening for signals.');

  // Handle process signals
  process.on('SIGINT', () => process.exit());
  process.on('SIGTERM', () => process.exit());
}

startCora().catch((error) => {
  console.error('❌ Failed to start Cora:', error);
  process.exit(1);
});
