import { Telegraf, Markup } from 'telegraf';
import { SubscriptionService } from '../services/subscription-service.js';
import { UserService } from '../services/user-service.js';
import { TradeService } from '../services/trade-service.js';
import { TradeExecutor } from '../services/trade-executor.js';
import dotenv from 'dotenv';

dotenv.config();

const subService = new SubscriptionService();
const userService = new UserService();
const tradeService = new TradeService();

export class BotManager {
  constructor() {
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
    this.userStates = new Map(); // For interactive prompts
    this.executor = new TradeExecutor();
    this.setupHandlers();
  }

  async start() {
    console.log('🚀 [BOT] Cora Telegram Bot initialized.');
    return true;
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

        setTimeout(() => ctx.deleteMessage(msg.message_id).catch(() => { }), 60000);
      } catch (err) {
        ctx.answerCbQuery('❌ Error exporting.');
      }
    });

    this.bot.action('tactics_settings', async (ctx) => {
      try {
        const profile = await userService.getProfile(ctx.from.id);
        const settings = profile.settings;
        
        const slipDisplay = settings.slippage === 'auto' ? 'Auto (Dynamic)' : `${settings.slippage}%`;

        let msg = `
⚙️ **Trading Tactics**

Define Cora's rules of engagement. These settings apply to all autonomous trades.

💰 **Buy Amount:** \`${settings.defaultBuyAmount} SOL\`
📈 **Take Profit:** \`+${settings.tpPercent}%\`
📉 **Stop Loss:** \`-${settings.slPercent}%\`
🌊 **Slippage:** \`${slipDisplay}\`
⏱️ **Mission Window:** \`${settings.missionDuration ? (settings.missionDuration / 3600000) + 'h' : '♾️ Indefinite'}\`
🔥 **Auto-Exit:** ${settings.autoExit ? '✅ ENABLED' : '❌ DISABLED'}

*Auto-Exit ensures Cora sells automatically when TP or SL targets are hit.*
        `;

        ctx.editMessageText(msg, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('💰 Buy Amount', 'set_buy'), Markup.button.callback('🌊 Slippage', 'set_slippage')],
            [Markup.button.callback('📈 TP %', 'set_tp'), Markup.button.callback('📉 SL %', 'set_sl')],
            [Markup.button.callback('⏱️ Mission Window', 'set_mission')],
            [Markup.button.callback(`${settings.autoExit ? '🔴 Disable' : '🟢 Enable'} Auto-Exit`, 'toggle_auto_exit')],
            [Markup.button.callback('⬅️ Back', 'main_menu')]
          ])
        });
      } catch (err) {
        ctx.answerCbQuery('Error loading tactics.');
      }
    });

    this.bot.action('set_mission', async (ctx) => {
      ctx.editMessageText('⏱️ **Mission Window**\n\nHow long should Cora stay active after you start the sniper?\n\n_Note: Existing trades will still be monitored after the window closes._', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('1 Hour', 'mission_3600000'), Markup.button.callback('4 Hours', 'mission_14400000')],
          [Markup.button.callback('12 Hours', 'mission_43200000'), Markup.button.callback('24 Hours', 'mission_86400000')],
          [Markup.button.callback('♾️ Indefinite', 'mission_null')],
          [Markup.button.callback('⬅️ Back', 'tactics_settings')]
        ])
      });
    });

    this.bot.action(/^mission_(.+)$/, async (ctx) => {
      const val = ctx.match[1] === 'null' ? null : parseInt(ctx.match[1]);
      const profile = await userService.getProfile(ctx.from.id);
      await userService.updateSettings(ctx.from.id, { ...profile.settings, missionDuration: val });
      ctx.answerCbQuery(`Mission Window updated ✅`);
      this.bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: 'tactics_settings' } });
    });

    this.bot.action('set_buy', async (ctx) => {
      ctx.editMessageText('💰 **Set Buy Amount**\n\nSelect a preset or type a custom SOL amount:', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('0.1 SOL', 'buy_0.1'), Markup.button.callback('0.25 SOL', 'buy_0.25')],
          [Markup.button.callback('0.5 SOL', 'buy_0.5'), Markup.button.callback('1.0 SOL', 'buy_1.0')],
          [Markup.button.callback('✏️ Custom Amount', 'custom_buy_prompt')],
          [Markup.button.callback('⬅️ Back', 'tactics_settings')]
        ])
      });
    });

    this.bot.action('set_tp', async (ctx) => {
      ctx.editMessageText('📈 **Set Take Profit**\n\nSelect a preset or type a custom profit %:', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('+50%', 'tp_50'), Markup.button.callback('+100%', 'tp_100')],
          [Markup.button.callback('+200%', 'tp_200'), Markup.button.callback('+500%', 'tp_500')],
          [Markup.button.callback('✏️ Custom TP %', 'custom_tp_prompt')],
          [Markup.button.callback('⬅️ Back', 'tactics_settings')]
        ])
      });
    });

    this.bot.action('set_sl', async (ctx) => {
      ctx.editMessageText('📉 **Set Stop Loss**\n\nSelect a preset or type a custom loss %:', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('-15%', 'sl_15'), Markup.button.callback('-25%', 'sl_25')],
          [Markup.button.callback('-50%', 'sl_50'), Markup.button.callback('-75%', 'sl_75')],
          [Markup.button.callback('✏️ Custom SL %', 'custom_sl_prompt')],
          [Markup.button.callback('⬅️ Back', 'tactics_settings')]
        ])
      });
    });

    this.bot.action('set_slippage', (ctx) => {
      ctx.editMessageText('⚡️ **Set Slippage**\n\nSelect a preset, use Auto for dynamic adjusting, or type a custom %:', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🤖 Auto (Dynamic)', 'slip_auto')],
          [Markup.button.callback('10%', 'slip_10'), Markup.button.callback('25%', 'slip_25')],
          [Markup.button.callback('50%', 'slip_50'), Markup.button.callback('75%', 'slip_75')],
          [Markup.button.callback('✏️ Custom %', 'slip_custom')],
          [Markup.button.callback('⬅️ Back', 'tactics_settings')]
        ])
      });
    });

    this.bot.action('custom_buy_prompt', (ctx) => {
      this.userStates.set(ctx.from.id, { action: 'await_custom_buy' });
      ctx.reply('💰 **Custom Buy Amount**\n\nHow much SOL should Cora spend per trade?', { parse_mode: 'Markdown' });
    });

    this.bot.action('custom_tp_prompt', (ctx) => {
      this.userStates.set(ctx.from.id, { action: 'await_custom_tp' });
      ctx.reply('📈 **Custom Take Profit**\n\nWhat is your target profit %? (e.g., 150)', { parse_mode: 'Markdown' });
    });

    this.bot.action('custom_sl_prompt', (ctx) => {
      this.userStates.set(ctx.from.id, { action: 'await_custom_sl' });
      ctx.reply('📉 **Custom Stop Loss**\n\nWhat is your maximum loss %? (e.g., 20)', { parse_mode: 'Markdown' });
    });

    this.bot.action('custom_slip_prompt', (ctx) => {
      this.userStates.set(ctx.from.id, { action: 'await_custom_slip' });
      ctx.reply('🌊 **Custom Slippage**\n\nWhat is your maximum slippage %? (e.g., 2.5)', { parse_mode: 'Markdown' });
    });

    // Preset Handlers
    this.bot.action(/^buy_(.+)$/, async (ctx) => {
      const amount = parseFloat(ctx.match[1]);
      const profile = await userService.getProfile(ctx.from.id);
      await userService.updateSettings(ctx.from.id, { ...profile.settings, defaultBuyAmount: amount });
      ctx.answerCbQuery(`Buy Amount set to ${amount} SOL ✅`);
      this.bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: 'tactics_settings' } });
    });

    this.bot.action(/^tp_(.+)$/, async (ctx) => {
      const value = parseInt(ctx.match[1]);
      const profile = await userService.getProfile(ctx.from.id);
      await userService.updateSettings(ctx.from.id, { ...profile.settings, tpPercent: value });
      ctx.answerCbQuery(`TP set to +${value}% ✅`);
      this.bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: 'tactics_settings' } });
    });

    this.bot.action(/^sl_(.+)$/, async (ctx) => {
      const value = parseInt(ctx.match[1]);
      const profile = await userService.getProfile(ctx.from.id);
      await userService.updateSettings(ctx.from.id, { ...profile.settings, slPercent: value });
      ctx.answerCbQuery(`SL set to -${value}% ✅`);
      this.bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: 'tactics_settings' } });
    });

    this.bot.action(/^slip_(.+)$/, async (ctx) => {
      const val = ctx.match[1];
      const profile = await userService.getProfile(ctx.from.id);
      
      if (val === 'custom') {
        this.userStates.set(ctx.from.id, { action: 'await_custom_slip' });
        ctx.reply('✍️ Send me the slippage percentage (e.g., 25.5):');
      } else if (val === 'auto') {
        await userService.updateSettings(ctx.from.id, { ...profile.settings, slippage: 'auto' });
        ctx.reply(`✅ **Slippage set to Auto (Dynamic)**`, { parse_mode: 'Markdown' });
        this.sendDashboard(ctx);
      } else {
        await userService.updateSettings(ctx.from.id, { ...profile.settings, slippage: parseFloat(val) });
        ctx.reply(`✅ **Slippage set to ${val}%**`, { parse_mode: 'Markdown' });
        this.sendDashboard(ctx);
      }
    });

    this.bot.action('toggle_auto_exit', async (ctx) => {
      const profile = await userService.getProfile(ctx.from.id);
      const newSettings = { ...profile.settings, autoExit: !profile.settings.autoExit };
      await userService.updateSettings(ctx.from.id, newSettings);
      ctx.answerCbQuery(`Auto-Exit ${newSettings.autoExit ? 'Enabled' : 'Disabled'} ✅`);
      this.bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: 'tactics_settings' } });
    });

    this.bot.action(/^send_prompt_(.+)$/, async (ctx) => {
      console.log(`[BOT] Send SOL clicked by ${ctx.from.id}`);
      const walletId = ctx.match[1];
      this.userStates.set(ctx.from.id, { action: 'await_send_address', walletId });
      ctx.reply('📤 **Send SOL**\n\nPlease paste the destination Solana address:', { parse_mode: 'Markdown' });
    });

    this.bot.action(/^rename_prompt_(.+)$/, async (ctx) => {
      console.log(`[BOT] Rename Wallet clicked by ${ctx.from.id}`);
      const walletId = ctx.match[1];
      this.userStates.set(ctx.from.id, { action: 'await_rename', walletId });
      ctx.reply('🏷️ **Rename Wallet**\n\nPlease type the new name for this wallet:', { parse_mode: 'Markdown' });
    });

    this.bot.action('alpha_sniper', async (ctx) => {
      console.log(`[BOT] Alpha Sniper Hub clicked by ${ctx.from.id}`);
      try {
        const profile = await userService.getProfile(ctx.from.id);
        if (!profile || !profile.wallets || profile.wallets.length === 0) {
          return ctx.answerCbQuery('⚠️ No wallets found. Please create one first.', { show_alert: true });
        }

        const activeWallet = profile.wallets[0]; // Sniping uses primary wallet
        const settings = profile.settings || {};

        let statusEmoji = settings.snipeEnabled ? '🟢 ACTIVE MISSION' : '🔴 PAUSED';
        let timeInfo = '';

        if (settings.snipeEnabled && settings.snipeExpiration) {
          const diff = new Date(settings.snipeExpiration).getTime() - Date.now();
          if (diff > 0) {
            const h = Math.floor(diff / 3600000);
            const m = Math.floor((diff % 3600000) / 60000);
            timeInfo = `\n⏱️ **Ends in:** \`${h}h ${m}m\``;
          }
        }

        const toggleLabel = settings.snipeEnabled ? '⏹️ Stop Sniper' : '🚀 Start Sniper';
        const slipDisplay = settings.slippage === 'auto' ? 'Auto' : `${settings.slippage}%`;

        const msg = `
🎯 **Alpha Sniper Configuration**

${settings.snipeEnabled ? 'You have connected Cora to the **Coresight Alpha** detection system.' : 'You are about to connect Cora to the **Coresight Alpha** detection system.'}

${settings.snipeEnabled ? '⚠️ **CORA IS CURRENTLY SNIPING.**' : 'Cora will monitor all Alpha signals and execute trades based on these metrics:'}

💳 **Wallet:** \`${activeWallet.solAddress}\`
💰 **Buy Amount:** \`${settings.defaultBuyAmount || 0.1} SOL\`
📈 **Take Profit:** \`+${settings.tpPercent || 100}%\`
📉 **Stop Loss:** \`-${settings.slPercent || 50}%\`
🌊 **Slippage:** \`${slipDisplay}\`
🔄 **Auto-Exit:** \`${settings.autoExit ? 'ENABLED' : 'DISABLED'}\`
⏱️ **Window:** \`${settings.missionDuration ? (settings.missionDuration / 3600000) + 'h' : 'Indefinite'}\`

*Status:* **${statusEmoji}**${timeInfo}
        `;

        await ctx.editMessageText(msg, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(toggleLabel, 'toggle_sniper')],
            [Markup.button.callback('⚙️ Modify Tactics', 'tactics_settings')],
            [Markup.button.callback('⬅️ Back to Hub', 'main_menu')]
          ])
        });
      } catch (err) {
        console.error('❌ [BOT] Alpha Sniper Error:', err);
        ctx.answerCbQuery('⚠️ Could not load sniper settings. Try again.', { show_alert: true });
      }
    });

    this.bot.action('toggle_sniper', async (ctx) => {
      const profile = await userService.getProfile(ctx.from.id);
      const isStarting = !profile.settings.snipeEnabled;
      
      if (isStarting) {
        await userService.startSniperMission(ctx.from.id);
        ctx.answerCbQuery('Mission Started! 🚀');
      } else {
        await userService.updateSettings(ctx.from.id, { 
          ...profile.settings, 
          snipeEnabled: false,
          snipeExpiration: null 
        });
        ctx.answerCbQuery('Mission Aborted ⏹️');
      }

      // Re-render the menu to show updated status
      this.bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: 'alpha_sniper' } });
    });

    this.bot.action('pnl_dashboard', async (ctx) => {
      console.log(`[BOT] PnL Dashboard clicked by ${ctx.from.id}`);
      try {
        const stats = await tradeService.getStats(ctx.from.id);
        const history = await tradeService.getTradeHistory(ctx.from.id, 5);

        let msg = `
📈 **PnL Dashboard**

**Performance Summary:**
• Total Trades: \`${stats.totalTrades}\`
• Win Rate: \`${stats.winRate.toFixed(1)}%\` (${stats.winCount}W / ${stats.lossCount}L)
• Total Profit: \`${stats.totalPnL >= 0 ? '+' : ''}${stats.totalPnL.toFixed(2)}%\`
• Total Volume: \`${stats.totalVolume.toFixed(2)} SOL\`

**Recent Activity:**
`;

        if (history.length === 0) {
          msg += `_No trades executed yet._\n`;
        } else {
          history.forEach(t => {
            const pnlStr = t.status === 'open' ? '⏳ OPEN' : `${t.pnl >= 0 ? '🟢' : '🔴'} ${t.pnl.toFixed(2)}%`;
            msg += `• **${t.symbol}**: ${pnlStr} (\`${t.buyAmount} SOL\`)\n`;
          });
        }

        ctx.editMessageText(msg, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh', 'pnl_dashboard')],
            [Markup.button.callback('⬅️ Back', 'main_menu')]
          ])
        });
      } catch (err) {
        console.error('❌ [BOT] PnL Error:', err);
        ctx.answerCbQuery('⚠️ Error loading stats.');
      }
    });

    this.bot.action('positions_hub', async (ctx) => {
      try {
        const profile = await userService.getProfile(ctx.from.id);
        const wallet = profile.wallets[0];
        
        ctx.answerCbQuery('Scanning Portfolio... 🔎');
        const { getPositions } = await import('../../../cli/utils/api/client.js');
        const response = await getPositions(wallet.solAddress, { chainId: 'solana' });
        
        const positions = (response.data || []).filter(p => {
          const info = p.attributes.fungible_info;
          return info && info.symbol !== 'SOL' && p.attributes.quantity.float > 0.000001;
        });

        let msg = `📦 **Positions Hub**\n_Wallet: ${wallet.solAddress.slice(0,6)}...${wallet.solAddress.slice(-4)}_\n\nSelect a token to manage your position, view PnL, and see trade details:`;
        const buttons = [];

        if (positions.length === 0) {
          msg = `📦 **Positions Hub**\n\n_No active positions found in this wallet._`;
        } else {
          const db = await (await import('../db.js')).connectToDatabase();
          let summary = '';

          for (let i = 0; i < positions.length; i += 2) {
            const row = [];
            
            const createButton = async (p) => {
              const info = p.attributes.fungible_info;
              const symbol = info.symbol;
              const mint = info.implementations.find(imm => imm.chain_id === 'solana')?.address;
              
              // Find matching trade to show PnL in the summary text from cache
              const trade = await db.collection('trades').findOne({ userId: ctx.from.id, mint, status: 'open' });
              if (trade) {
                const priceRecord = await db.collection('token_prices').findOne({ mint });
                const currentPrice = priceRecord?.price || 0;
                if (currentPrice > 0) {
                  const pnl = ((currentPrice - trade.buyPrice) / trade.buyPrice) * 100;
                  summary += `• **$${symbol}**: ${pnl >= 0 ? '📈 +' : '📉 '}${pnl.toFixed(1)}%\n`;
                }
              }
              return Markup.button.callback(`$${symbol}`, `manage_pos_${mint}`);
            };

            row.push(await createButton(positions[i]));
            if (positions[i+1]) {
              row.push(await createButton(positions[i+1]));
            }
            buttons.push(row);
          }
          
          if (summary) {
            msg = `📦 **Positions Hub**\n_Wallet: ${wallet.solAddress.slice(0,6)}...${wallet.solAddress.slice(-4)}_\n\n**Performance:**\n${summary}\nSelect a token to manage:`;
          }
        }

        buttons.push([Markup.button.callback('🔄 Refresh List', 'positions_hub')]);
        buttons.push([Markup.button.callback('⬅️ Back to Hub', 'main_menu')]);

        ctx.editMessageText(msg, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard(buttons)
        });
      } catch (err) {
        console.error('❌ [BOT] Positions Error:', err);
        ctx.reply('⚠️ Error loading positions.');
      }
    });

    this.bot.action(/^manage_pos_(.+)$/, async (ctx) => {
      const mint = ctx.match[1];
      try {
        const profile = await userService.getProfile(ctx.from.id);
        const wallet = profile.wallets[0];
        
        // 1. Fetch Live Data from ST and Zerion
        const { getPositions } = await import('../../../cli/utils/api/client.js');
        const response = await getPositions(wallet.solAddress, { chainId: 'solana' });
        const pos = response.data.find(p => p.attributes.fungible_info?.implementations?.some(i => i.address === mint));
        
        // 1. Fetch Live Data from our Global Cache
        const db = await (await import('../db.js')).connectToDatabase();
        const priceRecord = await db.collection('token_prices').findOne({ mint });
        const currentPrice = priceRecord?.price || 0;
        
        const { getPositions } = await import('../../../cli/utils/api/client.js');
        const profile = await userService.getProfile(ctx.from.id);
        const wallet = profile.wallets[0];
        const response = await getPositions(wallet.solAddress, { chainId: 'solana' });
        const pos = response.data.find(p => p.attributes.fungible_info?.implementations?.some(i => i.address === mint));

        const info = pos?.attributes?.fungible_info || { symbol: 'TOKEN', name: 'Unknown Token' };
        const quantity = pos?.attributes?.quantity?.float || 0;
        const currentValue = pos?.attributes?.value || 0;

        let pnlStr = "N/A";
        if (trade && currentPrice > 0) {
          const pnl = ((currentPrice - trade.buyPrice) / trade.buyPrice) * 100;
          pnlStr = `${pnl >= 0 ? '🟢 +' : '🔴 '}${pnl.toFixed(2)}%`;
        }

        // 3. Estimate Live Market Cap from our Cache (assuming 1B supply)
        const currentMCap = currentPrice * 1000000000;

        const initialMCap = trade?.entryMarketCap || 0;

        const formatMCap = (val) => {
          if (!val || val === 0) return 'N/A';
          if (val >= 1000000) return (val/1000000).toFixed(1) + 'M';
          if (val >= 1000) return (val/1000).toFixed(1) + 'k';
          return val.toFixed(0);
        };

        const msg = `
💎 **Position: ${info.name} ($${info.symbol})**
\`${mint}\`

**📊 Performance:**
• PnL: **${pnlStr}**
• Current Value: \`$${currentValue.toFixed(2)}\`
• Holding: \`${quantity.toFixed(4)} ${info.symbol}\`

**📈 Trade Entry:**
• Entry Price: \`$${trade?.buyPrice?.toFixed(10) || 'N/A'}\`
• Entry SOL: \`${trade?.buyAmount?.toFixed(3) || 'N/A'} SOL\`
• Initial MCap: \`$${formatMCap(initialMCap)}\`
• Live MCap: \`$${formatMCap(currentMCap)}\`

**Status:** ⏳ **MONITORING**
        `;

        ctx.editMessageText(msg, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('➕ Buy More', `pos_buy_menu_${mint}`), Markup.button.callback('🔴 Sell Position', `pos_sell_menu_${mint}`)],
            [Markup.button.callback('🔄 Refresh Stats', `manage_pos_${mint}`)],
            [Markup.button.callback('⬅️ Back to Positions', 'positions_hub')]
          ])
        }).catch(err => {
          if (!err.message.includes('message is not modified')) {
            throw err;
          }
        });
      } catch (err) {
        console.error('❌ [BOT] Drill-down error:', err);
        ctx.answerCbQuery('⚠️ Error loading token details.');
      }
    });

    this.bot.action(/^pos_buy_menu_(.+)$/, async (ctx) => {
      const mint = ctx.match[1];
      ctx.editMessageText('💰 **Buy More**\n\nSelect a preset SOL amount to add to this position:', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('0.1 SOL', `pos_buy_exec_${mint}_0.1`), Markup.button.callback('0.25 SOL', `pos_buy_exec_${mint}_0.25`)],
          [Markup.button.callback('0.5 SOL', `pos_buy_exec_${mint}_0.5`), Markup.button.callback('1.0 SOL', `pos_buy_exec_${mint}_1.0`)],
          [Markup.button.callback('⬅️ Cancel', 'positions_hub')]
        ])
      });
    });

    this.bot.action(/^pos_sell_menu_(.+)$/, async (ctx) => {
      const mint = ctx.match[1];
      ctx.editMessageText('🔴 **Sell Position**\n\nWhat percentage of your tokens do you want to sell?', {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('25%', `pos_sell_exec_${mint}_25`), Markup.button.callback('50%', `pos_sell_exec_${mint}_50`)],
          [Markup.button.callback('75%', `pos_sell_exec_${mint}_75`), Markup.button.callback('100% (All)', `pos_sell_exec_${mint}_100`)],
          [Markup.button.callback('⬅️ Cancel', 'positions_hub')]
        ])
      });
    });

    this.bot.action(/^pos_buy_exec_(.+)_(.+)$/, async (ctx) => {
      const mint = ctx.match[1];
      const amount = parseFloat(ctx.match[2]);
      const profile = await userService.getProfile(ctx.from.id);
      
      ctx.reply(`⏳ **Buying ${amount} SOL more...** (via ST)`);
      
      // Temporarily override default buy amount for this execution
      const tempProfile = { ...profile, settings: { ...profile.settings, defaultBuyAmount: amount } };
      
      const executor = this.executor;
      const result = await executor.executeSnipe(tempProfile, { mint, symbol: 'TOKEN' });

      if (result.success) {
        ctx.reply(`✅ **Successfully bought more!**\nTX: \`${result.hash}\``, { parse_mode: 'Markdown' });
      } else {
        ctx.reply(`❌ **Buy Failed:** ${result.error}`);
      }
    });

    this.bot.action(/^pos_sell_exec_(.+)_(.+)$/, async (ctx) => {
      const mint = ctx.match[1];
      const percentage = parseInt(ctx.match[2]);
      const profile = await userService.getProfile(ctx.from.id);
      
      ctx.reply(`⏳ **Selling ${percentage}%...** (via ST)`);
      
      const executor = this.executor;
      const trade = { mint, symbol: 'TOKEN' };
      const result = await executor.executeSell(profile, trade, percentage);

      if (result.success) {
        ctx.reply(`✅ **Successfully sold ${percentage}%!**\nTX: \`${result.hash}\``, { parse_mode: 'Markdown' });
      } else {
        ctx.reply(`❌ **Sell Failed:** ${result.error}`);
      }
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

      const profile = await userService.getProfile(ctx.from.id);
      const val = parseFloat(ctx.message.text);

      if (state.action === 'await_custom_buy') {
        if (isNaN(val) || val <= 0) return ctx.reply('❌ **Invalid amount.** Please enter a number like 0.5', { parse_mode: 'Markdown' });
        await userService.updateSettings(ctx.from.id, { ...profile.settings, defaultBuyAmount: val });
        this.userStates.delete(ctx.from.id);
        ctx.reply(`✅ **Buy Amount set to ${val} SOL**`, { parse_mode: 'Markdown' });
        this.sendDashboard(ctx);
      }
      else if (state.action === 'await_custom_tp') {
        if (isNaN(val) || val <= 0) return ctx.reply('❌ **Invalid percentage.** Please enter a number like 150', { parse_mode: 'Markdown' });
        await userService.updateSettings(ctx.from.id, { ...profile.settings, tpPercent: val });
        this.userStates.delete(ctx.from.id);
        ctx.reply(`✅ **Take Profit set to +${val}%**`, { parse_mode: 'Markdown' });
        this.sendDashboard(ctx);
      }
      else if (state.action === 'await_custom_sl') {
        if (isNaN(val) || val <= 0) return ctx.reply('❌ **Invalid percentage.** Please enter a number like 20', { parse_mode: 'Markdown' });
        await userService.updateSettings(ctx.from.id, { ...profile.settings, slPercent: val });
        this.userStates.delete(ctx.from.id);
        ctx.reply(`✅ **Stop Loss set to -${val}%**`, { parse_mode: 'Markdown' });
        this.sendDashboard(ctx);
      }
      else if (state.action === 'await_custom_slip') {
        if (isNaN(val) || val <= 0 || val > 99) return ctx.reply('❌ **Invalid percentage.** (Max 99%)', { parse_mode: 'Markdown' });
        await userService.updateSettings(ctx.from.id, { ...profile.settings, slippage: val });
        this.userStates.delete(ctx.from.id);
        ctx.reply(`✅ **Slippage set to ${val}%**`, { parse_mode: 'Markdown' });
        this.sendDashboard(ctx);
      }
      else if (state.action === 'await_rename') {
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

      // 3. Fetch Balance
      const balance = await userService.getSolBalance(activeWallet.solAddress);
      const balanceStr = `${balance.amount.toFixed(3)} SOL (~$${balance.usdValue.toFixed(2)})`;

      // 4. Build Dashboard
      const welcomeMsg = `
🤖 **Welcome to Cora, ${userName}!**

I am your personal autonomous trading agent powered by **ZERION**, connected to the Coresight Alpha detection system.

💳 **Primary Wallet:**
\`${activeWallet.solAddress}\`
💰 **Balance:** \`${balanceStr}\`

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
      [Markup.button.callback('🎯 Alpha Sniper', 'alpha_sniper'), Markup.button.callback('👥 Copytrade', 'copytrade_hub')],
      [Markup.button.callback('💰 Wallet', 'wallet_settings'), Markup.button.callback('📈 PnL Stats', 'pnl_dashboard')],
      [Markup.button.callback('⚙️ Tactics', 'tactics_settings'), Markup.button.callback('📦 Positions', 'positions_hub')]
    ]);
  }
}
