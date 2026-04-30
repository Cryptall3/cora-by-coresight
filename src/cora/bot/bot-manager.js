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
    this.userStates = new Map(); // For interactive prompts
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
      const wallets = profile.wallets || [];
      
      let msg = '💳 **Wallet Manager**\n\nManage your trading capital across multiple accounts:\n\n';
      const buttons = [];

      wallets.forEach((w, index) => {
        msg += `${index + 1}. **${w.name}**\n\`${w.solAddress}\`\n\n`;
        buttons.push([Markup.button.callback(`⚙️ Manage: ${w.name}`, `manage_wallet_${w.id}`)]);
      });

      buttons.push([Markup.button.callback('➕ Create New Wallet', 'create_new_wallet')]);
      buttons.push([Markup.button.callback('⬅️ Back', 'main_menu')]);

      ctx.editMessageText(msg, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard(buttons)
      });
    });

    this.bot.action('create_new_wallet', async (ctx) => {
      await userService.addWallet(ctx.from.id, `Wallet ${Math.floor(Math.random() * 1000)}`);
      ctx.answerCbQuery('New wallet created! 🆕');
      // Refresh Hub
      ctx.callbackQuery.data = 'wallet_settings';
      this.bot.handleUpdate(ctx.update);
    });

    this.bot.action(/^manage_wallet_(.+)$/, async (ctx) => {
      const walletId = ctx.match[1];
      const profile = await userService.getProfile(ctx.from.id);
      const wallet = profile.wallets.find(w => w.id === walletId);
      
      const msg = `
⚙️ **Manage Wallet: ${wallet.name}**

**SOL Address:** \`${wallet.solAddress}\`

What would you like to do with this wallet?
      `;

      ctx.editMessageText(msg, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📤 Send SOL', `send_prompt_${walletId}`)],
          [Markup.button.callback('🏷️ Rename', `rename_prompt_${walletId}`), Markup.button.callback('🗑️ Delete', `delete_confirm_${walletId}`)],
          [Markup.button.callback('🔑 Export Seed Phrase', `export_seed_${walletId}`)],
          [Markup.button.callback('⬅️ Back to Hub', 'wallet_settings')]
        ])
      });
    });

    this.bot.action(/^export_seed_(.+)$/, async (ctx) => {
      const walletId = ctx.match[1];
      try {
        const mnemonic = await userService.exportSeedPhrase(ctx.from.id, walletId);
        const msg = await ctx.reply(`
⚠️ **RECOVERY PHRASE EXPORT** ⚠️

<b>Your 12-word Seed Phrase:</b>
<tg-spoiler>${mnemonic}</tg-spoiler>

<i>Note: CORESIGHT does not store your seedphrase. Message deletes in 60s.</i>
        `, { parse_mode: 'HTML' });

        setTimeout(() => ctx.deleteMessage(msg.message_id).catch(() => {}), 60000);
      } catch (err) {
        ctx.answerCbQuery('❌ Error exporting.');
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

    this.bot.action(/^send_prompt_(.+)$/, async (ctx) => {
      const walletId = ctx.match[1];
      this.userStates.set(ctx.from.id, { action: 'await_send_address', walletId });
      ctx.reply('📤 **Send SOL**\n\nPlease paste the destination Solana address:', { parse_mode: 'Markdown' });
    });

    this.bot.action(/^rename_prompt_(.+)$/, async (ctx) => {
      const walletId = ctx.match[1];
      this.userStates.set(ctx.from.id, { action: 'await_rename', walletId });
      ctx.reply('🏷️ **Rename Wallet**\n\nPlease type the new name for this wallet:', { parse_mode: 'Markdown' });
    });

    this.bot.action(/^delete_confirm_(.+)$/, async (ctx) => {
      const walletId = ctx.match[1];
      ctx.editMessageText('⚠️ **Confirm Deletion**\n\nAre you absolutely sure you want to delete this wallet? This cannot be undone.', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('❌ Yes, Delete', `delete_exec_${walletId}`)],
          [Markup.button.callback('⬅️ Cancel', `manage_wallet_${walletId}`)]
        ])
      });
    });

    this.bot.action(/^delete_exec_(.+)$/, async (ctx) => {
      const walletId = ctx.match[1];
      await userService.deleteWallet(ctx.from.id, walletId);
      ctx.answerCbQuery('Wallet deleted 🗑️');
      ctx.callbackQuery.data = 'wallet_settings';
      this.bot.handleUpdate(ctx.update);
    });

    // Global text listener for prompts
    this.bot.on('text', async (ctx) => {
      const state = this.userStates.get(ctx.from.id);
      if (!state) return;

      if (state.action === 'await_rename') {
        await userService.renameWallet(ctx.from.id, state.walletId, ctx.message.text);
        this.userStates.delete(ctx.from.id);
        ctx.reply(`✅ Wallet renamed to: ${ctx.message.text}`);
        this.sendDashboard(ctx);
      } 
      else if (state.action === 'await_send_address') {
        const address = ctx.message.text.trim();
        if (address.length < 32) return ctx.reply('❌ Invalid address. Please try again.');
        
        state.toAddress = address;
        state.action = 'await_send_amount';
        ctx.reply(`Destination set to: \`${address}\`\n\nHow much SOL would you like to send?`, { parse_mode: 'Markdown' });
      } 
      else if (state.action === 'await_send_amount') {
        const amount = parseFloat(ctx.message.text);
        if (isNaN(amount) || amount <= 0) return ctx.reply('❌ **Invalid amount.** Please try again.', { parse_mode: 'Markdown' });

        ctx.reply(`⏳ **Sending ${amount} SOL...**`, { parse_mode: 'Markdown' });
        try {
          const txHash = await userService.sendSOL(ctx.from.id, state.walletId, state.toAddress, amount);
          ctx.reply(`✅ **Transfer Successful!**\n\n**Transaction Hash:**\n\`${txHash}\``, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.url('🔗 View on Solscan', `https://solscan.io/tx/${txHash}`)],
              [Markup.button.callback('⬅️ Back to Wallets', 'wallet_settings')]
            ])
          });
        } catch (err) {
          ctx.reply(`❌ **Transfer Failed:** ${err.message}`);
        }
        this.userStates.delete(ctx.from.id);
      }
    });

    console.log('🚀 [BOT] Cora Telegram Bot initialized.');
  }

  async sendDashboard(ctx, isEdit = false) {
    try {
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

      // 2. Get Profile & Wallet
      const profile = await userService.createUserProfile(userId);
      const activeWallet = profile.wallets[0];

      // 3. Build Dashboard
      const welcomeMsg = `
🤖 **Welcome to Cora, ${userName}!**

I am your personal autonomous trading agent, connected to the Coresight Alpha detection system.

💳 **Primary Wallet:**
\`${activeWallet.solAddress}\` (Solana)

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
    } catch (error) {
      console.error('❌ [DASHBOARD] Error:', error);
      ctx.reply('⚠️ Error loading dashboard.');
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
