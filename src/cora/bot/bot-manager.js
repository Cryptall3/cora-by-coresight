import { Telegraf, Markup } from 'telegraf';
import { SubscriptionService } from '../services/subscription-service.js';
import { UserService } from '../services/user-service.js';
import dotenv from 'dotenv';

dotenv.config();

const subService = new SubscriptionService();
const userService = new UserService();

export class BotManager {
  constructor() {
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
    this.setupHandlers();
  }

  setupHandlers() {
    // /start command
    this.bot.start(async (ctx) => {
      const userId = ctx.from.id;
      const userName = ctx.from.first_name || 'Trader';

      try {
        ctx.reply(`🔍 Checking your Coresight Alpha access...`);

        // 1. Check Subscription in the main database
        const access = await subService.checkAccess(userId);

        if (!access.hasAccess) {
          return ctx.reply(
            `❌ **Access Denied**\n\nCora is an exclusive autonomous agent for Coresight Alpha members.\n\nPlease upgrade your plan to activate your personal trading agent.`,
            Markup.inlineKeyboard([
              [Markup.button.url('💎 Upgrade to Alpha', 'https://coresight.xyz/subscription')]
            ])
          );
        }

        // 2. Initialize or fetch user profile (Generates Zerion wallet if new)
        const profile = await userService.createUserProfile(userId);

        // 3. Welcome Message
        const welcomeMsg = `
🤖 **Welcome to Cora, ${userName}!**

I am your personal autonomous trading agent, connected to the Coresight Alpha system.

💳 **Your Personal Trading Wallet:**
\`${profile.solAddress}\` (Solana)
\`${profile.evmAddress}\` (EVM)

*Status:* ${profile.settings.snipeEnabled ? '🟢 ACTIVE' : '🔴 PAUSED'}

Use the menu below to fund your wallet, configure your tactics, and start sniping.
        `;

        return ctx.reply(welcomeMsg, {
          parse_mode: 'Markdown',
          ...this.getMainMenu()
        });

      } catch (error) {
        console.error('❌ [BOT] Error in /start:', error);
        ctx.reply('⚠️ An error occurred during onboarding. Please try again later.');
      }
    });

    // Handle Menu Actions
    this.bot.action('main_menu', (ctx) => {
      ctx.editMessageText('🤖 **Cora Main Menu**', {
        parse_mode: 'Markdown',
        ...this.getMainMenu()
      });
    });

    this.bot.action('wallet_settings', async (ctx) => {
      const profile = await userService.getProfile(ctx.from.id);
      const walletMsg = `
💰 **Wallet Manager**

**EVM:** \`${profile.evmAddress}\`
**SOL:** \`${profile.solAddress}\`

*Note: Cora uses these addresses for all autonomous trades. Ensure they are funded with gas (ETH/SOL).*
      `;
      ctx.editMessageText(walletMsg, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('⬅️ Back', 'main_menu')]
        ])
      });
    });

    // Start polling
    this.bot.launch();
    console.log('🚀 [BOT] Cora Telegram Bot is online.');
  }

  getMainMenu() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🎯 Alpha Sniper', 'snipe_settings'), Markup.button.callback('👥 Copytrade', 'copytrade_settings')],
      [Markup.button.callback('💰 Wallet', 'wallet_settings'), Markup.button.callback('⚙️ Tactics', 'tactics_settings')],
      [Markup.button.url('📚 Documentation', 'https://docs.coresight.xyz')]
    ]);
  }
}
