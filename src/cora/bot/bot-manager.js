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
      try {
        ctx.reply(`🔍 Checking your Coresight Alpha access...`);
        await this.sendDashboard(ctx, false);
      } catch (error) {
        console.error('❌ [BOT] Error in /start:', error);
        ctx.reply('⚠️ An error occurred during onboarding. Please try again later.');
      }
    });

    // Handle Menu Actions
    this.bot.action('main_menu', (ctx) => {
      this.sendDashboard(ctx, true);
    });

    this.bot.action('wallet_settings', async (ctx) => {
      const profile = await userService.getProfile(ctx.from.id);
      const walletMsg = `
💰 **Wallet Manager**

**SOL Address:** \`${profile.solAddress}\`

*Note: Cora uses this address for all autonomous trades. Ensure it is funded with SOL for gas and sniping.*
      `;
      ctx.editMessageText(walletMsg, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔑 Export Seed Phrase', 'export_key')],
          [Markup.button.callback('⬅️ Back', 'main_menu')]
        ])
      });
    });

    this.bot.action('export_key', async (ctx) => {
      try {
        const mnemonic = await userService.exportPrivateKey(ctx.from.id);
        
        // Using <tg-spoiler> for the blur effect (requires HTML parse_mode)
        const msg = await ctx.reply(`
⚠️ **RECOVERY PHRASE EXPORT** ⚠️

<b>Your 12-word Seed Phrase:</b>
<tg-spoiler>${mnemonic}</tg-spoiler>

<i>(Tap the blurred box above to reveal)</i>

DO NOT share this phrase with anyone. Use it to export your wallet.
This message will self-destruct in 60 seconds.
<b>Be careful not to expose this phrase.</b>

<i>Note: CORESIGHT does not store your seedphrase, so it is perfectly safe.</i>
        `, { parse_mode: 'HTML' });

        // Auto-delete after 60 seconds
        setTimeout(() => {
          ctx.deleteMessage(msg.message_id).catch(() => {});
        }, 60000);

      } catch (error) {
        ctx.answerCbQuery('❌ Error exporting key.');
      }
    });

    this.bot.action('tactics_settings', async (ctx) => {
      const profile = await userService.getProfile(ctx.from.id);
      const settings = profile.settings;
      
      const tacticsMsg = `
⚙️ **Trading Tactics**

Define Cora's rules of engagement. These settings apply to all autonomous trades.

💰 **Buy Amount:** \`${settings.defaultBuyAmount} SOL\`
📈 **Take Profit:** \`+${settings.tpPercent}%\`
📉 **Stop Loss:** \`-${settings.slPercent}%\`
🌊 **Slippage:** \`${settings.slippage}%\`
🔥 **Auto-Exit:** ${settings.autoExit ? '✅ ENABLED' : '❌ DISABLED'}

*Auto-Exit ensures Cora sells automatically when TP or SL targets are hit.*
      `;

      ctx.editMessageText(tacticsMsg, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💰 Buy Amount', 'set_buy'), Markup.button.callback('🌊 Slippage', 'set_slippage')],
          [Markup.button.callback('📈 Take Profit', 'set_tp'), Markup.button.callback('📉 Stop Loss', 'set_sl')],
          [Markup.button.callback(`${settings.autoExit ? '🔴 Disable' : '🟢 Enable'} Auto-Exit`, 'toggle_auto_exit')],
          [Markup.button.callback('⬅️ Back', 'main_menu')]
        ])
      });
    });

    this.bot.action('set_buy', async (ctx) => {
      ctx.editMessageText('💰 **Set Buy Amount**\nSelect how much SOL to spend per trade:', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('0.1 SOL', 'buy_0.1'), Markup.button.callback('0.25 SOL', 'buy_0.25')],
          [Markup.button.callback('0.5 SOL', 'buy_0.5'), Markup.button.callback('1.0 SOL', 'buy_1.0')],
          [Markup.button.callback('⬅️ Back', 'tactics_settings')]
        ])
      });
    });

    // Handle Quick Buy Presets
    this.bot.action(/^buy_(.+)$/, async (ctx) => {
      const amount = parseFloat(ctx.match[1]);
      const profile = await userService.getProfile(ctx.from.id);
      const newSettings = { ...profile.settings, defaultBuyAmount: amount };
      await userService.updateSettings(ctx.from.id, newSettings);
      
      ctx.answerCbQuery(`Buy Amount set to ${amount} SOL ✅`);
      ctx.callbackQuery.data = 'tactics_settings';
      this.bot.handleUpdate(ctx.update);
    });

    this.bot.action('set_tp', async (ctx) => {
      ctx.editMessageText('📈 **Set Take Profit**\nSelect your target profit percentage:', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('+50%', 'tp_50'), Markup.button.callback('+100%', 'tp_100')],
          [Markup.button.callback('+200%', 'tp_200'), Markup.button.callback('+500%', 'tp_500')],
          [Markup.button.callback('⬅️ Back', 'tactics_settings')]
        ])
      });
    });

    this.bot.action(/^tp_(.+)$/, async (ctx) => {
      const value = parseInt(ctx.match[1]);
      const profile = await userService.getProfile(ctx.from.id);
      const newSettings = { ...profile.settings, tpPercent: value };
      await userService.updateSettings(ctx.from.id, newSettings);
      
      ctx.answerCbQuery(`Take Profit set to +${value}% ✅`);
      ctx.callbackQuery.data = 'tactics_settings';
      this.bot.handleUpdate(ctx.update);
    });

    this.bot.action('set_sl', async (ctx) => {
      ctx.editMessageText('📉 **Set Stop Loss**\nSelect your maximum loss threshold:', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('-15%', 'sl_15'), Markup.button.callback('-25%', 'sl_25')],
          [Markup.button.callback('-50%', 'sl_50'), Markup.button.callback('-75%', 'sl_75')],
          [Markup.button.callback('⬅️ Back', 'tactics_settings')]
        ])
      });
    });

    this.bot.action(/^sl_(.+)$/, async (ctx) => {
      const value = parseInt(ctx.match[1]);
      const profile = await userService.getProfile(ctx.from.id);
      const newSettings = { ...profile.settings, slPercent: value };
      await userService.updateSettings(ctx.from.id, newSettings);
      
      ctx.answerCbQuery(`Stop Loss set to -${value}% ✅`);
      ctx.callbackQuery.data = 'tactics_settings';
      this.bot.handleUpdate(ctx.update);
    });

    this.bot.action('set_slippage', async (ctx) => {
      ctx.editMessageText('🌊 **Set Slippage**\nSelect your maximum slippage tolerance:', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('0.5%', 'slip_0.5'), Markup.button.callback('1.0%', 'slip_1.0')],
          [Markup.button.callback('3.0%', 'slip_3.0'), Markup.button.callback('5.0%', 'slip_5.0')],
          [Markup.button.callback('⬅️ Back', 'tactics_settings')]
        ])
      });
    });

    this.bot.action(/^slip_(.+)$/, async (ctx) => {
      const value = parseFloat(ctx.match[1]);
      const profile = await userService.getProfile(ctx.from.id);
      const newSettings = { ...profile.settings, slippage: value };
      await userService.updateSettings(ctx.from.id, newSettings);
      
      ctx.answerCbQuery(`Slippage set to ${value}% ✅`);
      ctx.callbackQuery.data = 'tactics_settings';
      this.bot.handleUpdate(ctx.update);
    });

    this.bot.action('toggle_auto_exit', async (ctx) => {
      const profile = await userService.getProfile(ctx.from.id);
      const newSettings = { ...profile.settings, autoExit: !profile.settings.autoExit };
      await userService.updateSettings(ctx.from.id, newSettings);
      
      ctx.answerCbQuery(`Auto-Exit ${newSettings.autoExit ? 'Enabled' : 'Disabled'} ✅`);
      // Refresh the menu
      ctx.callbackQuery.data = 'tactics_settings';
      this.bot.handleUpdate(ctx.update);
    });

    console.log('🚀 [BOT] Cora Telegram Bot initialized.');
  }

  async sendDashboard(ctx, isEdit = false) {
    const userId = ctx.from.id;
    const userName = ctx.from.first_name || 'Trader';

    // 1. Check Subscription
    const access = await subService.checkAccess(userId);

    if (!access.hasAccess) {
      const msg = `❌ **Access Denied**\n\nCora is an exclusive autonomous agent for Coresight Alpha members.\n\nPlease upgrade your plan to activate your personal trading agent.`;
      const kb = Markup.inlineKeyboard([
        [Markup.button.url('💎 Upgrade to Alpha', 'https://coresight.xyz/subscription')]
      ]);
      return isEdit ? ctx.editMessageText(msg, { parse_mode: 'Markdown', ...kb }) : ctx.reply(msg, { parse_mode: 'Markdown', ...kb });
    }

    // 2. Get Profile
    const profile = await userService.createUserProfile(userId);

    // 3. Build Dashboard
    const welcomeMsg = `
🤖 **Welcome to Cora, ${userName}!**

I am your personal autonomous trading agent, connected to the Coresight Alpha detection system.

💳 **Your Personal Trading Wallet:**
\`${profile.solAddress}\` (Solana)

*Status:* ${profile.settings.snipeEnabled ? '🟢 ACTIVE' : '🔴 PAUSED'}

Use the menu below to fund your wallet, configure your tactics, and start sniping.
    `;

    const extra = {
      parse_mode: 'Markdown',
      ...this.getMainMenu()
    };

    if (isEdit) {
      return ctx.editMessageText(welcomeMsg, extra);
    } else {
      return ctx.reply(welcomeMsg, extra);
    }
  }

  getMainMenu() {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🎯 Alpha Sniper', 'snipe_settings'), Markup.button.callback('👥 Copytrade', 'copytrade_settings')],
      [Markup.button.callback('💰 Wallet', 'wallet_settings'), Markup.button.callback('⚙️ Tactics', 'tactics_settings')],
      [Markup.button.url('📚 Documentation', 'https://docs.coresight.xyz')]
    ]);
  }
}
