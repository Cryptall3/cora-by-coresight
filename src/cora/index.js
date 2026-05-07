import { BotManager } from './bot/bot-manager.js';
import { AlphaListener } from './services/alpha-listener.js';
import { AutoExitService } from './services/auto-exit-service.js';
import { PriceMonitorService } from './services/price-monitor-service.js';
import http from 'http';
import dotenv from 'dotenv';

dotenv.config();

const botManager = new BotManager();
const alphaListener = new AlphaListener();
const autoExitService = new AutoExitService();
const priceMonitorService = new PriceMonitorService();

async function startCora() {
  console.log('🤖 Starting Cora Agent Service...');

  // 1. Start the Global Price Monitor (Heartbeat)
  await priceMonitorService.start();

  // 1. Start the Telegram Bot Interface
  await botManager.start();
  const bot = botManager.bot;
    
  // 2. Start the Alpha Signal Listener (Ears)
  await alphaListener.start(botManager.bot);

  // 3. Start the Auto-Exit Monitor (Brain)
  await autoExitService.start(botManager.bot);

  // 3. HTTP server for Koyeb health checks AND Telegram Webhooks
  const port = process.env.PORT || 8000;
  
  // Clean the Webhook URL (Ensure it has https:// and no trailing slash)
  let webhookUrl = process.env.KOYEB_PUBLIC_URL || `https://${process.env.KOYEB_APP_NAME}.koyeb.app`;
  if (!webhookUrl.startsWith('http')) webhookUrl = `https://${webhookUrl}`;
  webhookUrl = webhookUrl.replace(/\/$/, ''); // Remove trailing slash if any

  const webhookPath = `/telegraf/${process.env.TELEGRAM_BOT_TOKEN}`;

  const server = http.createServer((req, res) => {
    if (req.url === webhookPath) {
      return bot.webhookCallback(webhookPath)(req, res);
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Cora is alive! 🤖\n');
  });

  server.listen(port, '0.0.0.0', async () => {
    console.log(`📡 [SERVER] Listening on port ${port}`);
    
    // Set up webhook
    try {
      const fullUrl = `${webhookUrl}${webhookPath}`;
      await bot.telegram.setWebhook(fullUrl);
      console.log(`🚀 [WEBHOOK] Telegram Webhook set to: ${fullUrl}`);
    } catch (err) {
      console.error('❌ [WEBHOOK] Failed to set webhook:', err);
    }
  });

  console.log('✅ Cora is fully operational and listening for signals.');

  // Handle process signals
  process.on('SIGINT', () => process.exit());
  process.on('SIGTERM', () => process.exit());
}

startCora().catch((error) => {
  console.error('❌ Failed to start Cora:', error);
  process.exit(1);
});
