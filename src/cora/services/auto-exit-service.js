import { connectToDatabase } from '../db.js';
import { TradeExecutor } from './trade-executor.js';
import { UserService } from './user-service.js';
import { getFungible } from '../../../cli/utils/api/client.js';

const tradeExecutor = new TradeExecutor();
const userService = new UserService();

export class AutoExitService {
  constructor() {
    this.isRunning = false;
    this.interval = 60000; // Check every 60 seconds
    this.db = null;
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.db = await connectToDatabase();
    
    console.log('🔄 [AUTO-EXIT] Service started. Monitoring open trades...');
    this.monitor();
  }

  async monitor() {
    while (this.isRunning) {
      try {
        const openTrades = await this.db.collection('trades').find({ status: 'open' }).toArray();
        
        if (openTrades.length > 0) {
          console.log(`🔍 [AUTO-EXIT] Checking ${openTrades.length} open trades...`);
          
          for (const trade of openTrades) {
            await this.checkTrade(trade);
          }
        }
      } catch (error) {
        console.error('❌ [AUTO-EXIT] Monitor error:', error);
      }
      
      await new Promise(resolve => setTimeout(resolve, this.interval));
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

      // 2. Get Current Price
      // Zerion fungibleId format for Solana is usually "solana:mintAddress"
      const fungibleId = `solana:${trade.mint}`;
      const tokenData = await getFungible(fungibleId);
      const currentPrice = tokenData.data?.attributes?.market_data?.price || 0;

      if (currentPrice === 0) {
        console.warn(`⚠️ [AUTO-EXIT] Could not fetch price for ${trade.symbol}`);
        return;
      }

      // 3. Calculate PnL
      const buyPrice = trade.buyPrice;
      const pnlPercent = ((currentPrice - buyPrice) / buyPrice) * 100;

      console.log(`📊 [AUTO-EXIT] ${trade.symbol} | Buy: ${buyPrice} | Now: ${currentPrice} | PnL: ${pnlPercent.toFixed(2)}%`);

      // 4. Check Targets
      if (pnlPercent >= tpPercent) {
        console.log(`🎯 [AUTO-EXIT] TP REACHED for ${trade.symbol} (+${pnlPercent.toFixed(2)}%)! Selling...`);
        await tradeExecutor.executeSell(profile, trade);
      } else if (pnlPercent <= -slPercent) {
        console.log(`📉 [AUTO-EXIT] SL REACHED for ${trade.symbol} (-${Math.abs(pnlPercent).toFixed(2)}%)! Selling...`);
        await tradeExecutor.executeSell(profile, trade);
      }

    } catch (error) {
      console.error(`❌ [AUTO-EXIT] Error checking trade ${trade._id}:`, error.message);
    }
  }

  stop() {
    this.isRunning = false;
  }
}
