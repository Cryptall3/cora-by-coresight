import { connectToDatabase } from '../db.js';
import { TradeExecutor } from './trade-executor.js';
import { UserService } from './user-service.js';
import { getFungible } from '../../../cli/utils/api/client.js';

const tradeExecutor = new TradeExecutor();
const userService = new UserService();

export class AutoExitService {
  constructor() {
    this.isRunning = false;
    this.interval = 2000; // Check every 2 seconds for high-speed trading
    this.db = null;
  }

  async start(bot = null) {
    if (this.isRunning) return;
    this.isRunning = true;
    this.bot = bot;
    this.db = await connectToDatabase();
    
    console.log('🔄 [AUTO-EXIT] Service started. Monitoring open trades & missions...');
    this.monitor();
  }

  async monitor() {
    while (this.isRunning) {
      try {
        // 1. Check for open trades (TP/SL)
        const openTrades = await this.db.collection('trades').find({ status: 'open' }).toArray();
        if (openTrades.length > 0) {
          console.log(`🔍 [AUTO-EXIT] Checking ${openTrades.length} open trades...`);
          for (const trade of openTrades) {
            await this.checkTrade(trade);
          }
        }

        // 2. Check for expired missions (Mission Reaper)
        await this.checkMissions();

      } catch (error) {
        console.error('❌ [AUTO-EXIT] Monitor error:', error);
      }
      
      await new Promise(resolve => setTimeout(resolve, this.interval));
    }
  }

  async checkMissions() {
    try {
      const expiredProfiles = await this.db.collection('user_profiles').find({
        'settings.snipeEnabled': true,
        'settings.snipeExpiration': { $lt: new Date() }
      }).toArray();

      for (const profile of expiredProfiles) {
        console.log(`⏱️ [AUTO-EXIT] Mission expired for ${profile.userId}. Stopping sniper...`);
        
        const missionId = profile.settings.currentMissionId;
        
        // Disable Sniper
        await this.db.collection('user_profiles').updateOne(
          { userId: profile.userId },
          { $set: { 'settings.snipeEnabled': false } }
        );

        // Generate Report
        const { TradeService } = await import('./trade-service.js');
        const tradeService = new TradeService();
        const report = await tradeService.generateMissionReport(profile.userId, missionId);

        if (report && this.bot) {
          await this.sendMissionDebrief(profile.userId, report);
        }
      }
    } catch (error) {
      console.error('❌ [AUTO-EXIT] Mission reaper error:', error);
    }
  }

  async sendMissionDebrief(userId, report) {
    const pnlEmoji = report.netRealizedPnL >= 0 ? '🟢' : '🔴';
    const unrealizedEmoji = report.unrealizedPnL >= 0 ? '🟢' : '🔴';

    let msg = `
📋 **MISSION DEBRIEF: ${report.missionId}**

Cora has completed her mission window. New signals will not be sniped.

**📊 Realized Performance:**
• Tokens Sniped: \`${report.totalSniped}\`
• Completed Trades: \`${report.completedCount}\`
• Total Invested: \`${report.totalInvested.toFixed(2)} SOL\`
• Total Recovered: \`${report.totalRecovered.toFixed(2)} SOL\`
• Net Realized: ${pnlEmoji} \`${report.netRealizedPnL >= 0 ? '+' : ''}${report.netRealizedPnL.toFixed(3)} SOL\`

**⏳ Open Positions (Targets Pending):**
`;

    if (report.openTrades.length === 0) {
      msg += `_No open positions remaining._\n`;
    } else {
      report.openTrades.forEach(t => {
        const emoji = t.pnl >= 0 ? '🟢' : '🔴';
        msg += `• **${t.symbol}**: ${emoji} \`${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(1)}%\` (Val: \`${t.value.toFixed(3)} SOL\`)\n`;
      });
      msg += `• Total Unrealized: ${unrealizedEmoji} \`${report.unrealizedPnL >= 0 ? '+' : ''}${report.unrealizedPnL.toFixed(3)} SOL\`\n`;
    }

    msg += `\n**Status:** ⏹️ **STANDBY**\n_Cora will continue to monitor open positions for your TP/SL targets._`;

    try {
      await this.bot.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error(`❌ [DEBRIEF] Failed to send to ${userId}:`, err.message);
    }
  }

  async checkTrade(trade) {
    try {
      // 1. Get User Profile for settings
      const profile = await userService.getProfile(trade.userId);
      if (!profile || !profile.settings.autoExit) {
        return; // Auto-exit disabled for this user
      }

      const { tpPercent, slPercent } = profile.settings;

      // 2. Get Current Price from Solana Tracker (much faster and more reliable than Zerion for new tokens)
      const priceRes = await fetch(`https://api.solanatracker.io/price?tokenAddress=${trade.mint}`);
      const priceData = await priceRes.json();
      const currentPrice = priceData.price || 0;

      if (currentPrice === 0) {
        // Fallback for extremely new tokens: wait for indexer
        return;
      }

      // 3. Calculate PnL
      const buyPrice = trade.buyPrice;
      const pnlPercent = ((currentPrice - buyPrice) / buyPrice) * 100;

      console.log(`📊 [AUTO-EXIT] ${trade.symbol} | Buy: ${buyPrice} | Now: ${currentPrice} | PnL: ${pnlPercent.toFixed(2)}%`);

      // 4. Check Targets
      if (pnlPercent >= tpPercent) {
        console.log(`🎯 [AUTO-EXIT] TP REACHED for ${trade.symbol} (+${pnlPercent.toFixed(2)}%)! Selling...`);
        const res = await tradeExecutor.executeSell(profile, trade);
        if (!res.success && this.bot) {
          const msg = `
⚠️ **Auto-Exit: Sell Failed**

**Token:** $${trade.symbol}
**Address:** \`${trade.mint}\`
**Reason:** Insufficient SOL for gas.

Cora tried to secure your profit at **+${pnlPercent.toFixed(1)}%** but couldn't cover the network fees.
_Please add at least 0.005 SOL to your wallet immediately._
          `;
          await this.bot.telegram.sendMessage(profile.userId, msg, { parse_mode: 'Markdown' }).catch(() => {});
        }
      } else if (pnlPercent <= -slPercent) {
        console.log(`📉 [AUTO-EXIT] SL REACHED for ${trade.symbol} (-${Math.abs(pnlPercent).toFixed(2)}%)! Selling...`);
        const res = await tradeExecutor.executeSell(profile, trade);
        if (!res.success && this.bot) {
          const msg = `
⚠️ **Auto-Exit: Stop Loss Failed**

**Token:** $${trade.symbol}
**Address:** \`${trade.mint}\`
**Reason:** Insufficient SOL for gas.

Cora tried to exit your position at **${pnlPercent.toFixed(1)}%** but couldn't cover the network fees.
_Please add at least 0.005 SOL to your wallet immediately._
          `;
          await this.bot.telegram.sendMessage(profile.userId, msg, { parse_mode: 'Markdown' }).catch(() => {});
        }
      }

    } catch (error) {
      console.error(`❌ [AUTO-EXIT] Error checking trade ${trade._id}:`, error.message);
    }
  }

  stop() {
    this.isRunning = false;
  }
}
