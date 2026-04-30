import { BotManager } from './bot/bot-manager.js';
import { AlphaListener } from './listeners/alpha-listener.js';
import http from 'http';
import dotenv from 'dotenv';

dotenv.config();

async function startCora() {
  console.log('🤖 Starting Cora Agent Service...');

  // 0. Dummy HTTP server for Koyeb health checks
  const port = process.env.PORT || 8000;
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Cora is alive! 🤖\n');
  }).listen(port, '0.0.0.0', () => {
    console.log(`📡 [HEALTH CHECK] Heartbeat server listening on port ${port}`);
  });

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
