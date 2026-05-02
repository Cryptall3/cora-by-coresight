import { connectToDatabase } from '../db.js';

export class TradeService {
  constructor() {
    this.db = null;
  }

  async initialize() {
    if (!this.db) {
      this.db = await connectToDatabase();
    }
  }

  async getTradeHistory(userId, limit = 10) {
    await this.initialize();
    return await this.db.collection('trades')
      .find({ userId })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
  }

  async getStats(userId) {
    await this.initialize();
    const trades = await this.db.collection('trades').find({ userId }).toArray();
    
    let totalPnL = 0;
    let winCount = 0;
    let lossCount = 0;
    let totalVolume = 0;

    trades.forEach(t => {
      if (t.status === 'closed' || t.status === 'closed_zero_balance') {
        totalPnL += (t.pnl || 0);
        if (t.pnl > 0) winCount++;
        else if (t.pnl < 0) lossCount++;
      }
      totalVolume += parseFloat(t.buyAmount || 0);
    });

    const avgPnL = trades.length > 0 ? totalPnL / trades.length : 0;
    const winRate = (winCount + lossCount) > 0 ? (winCount / (winCount + lossCount)) * 100 : 0;

    return {
      totalTrades: trades.length,
      totalPnL,
      winCount,
      lossCount,
      winRate,
      totalVolume,
      avgPnL
    };
  }
}
