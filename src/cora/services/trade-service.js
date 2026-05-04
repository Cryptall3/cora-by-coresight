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

  async generateMissionReport(userId, missionId) {
    await this.initialize();
    const trades = await this.db.collection('trades').find({ userId, missionId }).toArray();
    
    if (trades.length === 0) return null;

    // Get live positions to value open trades
    const profileCollection = this.db.collection('user_profiles');
    const profile = await profileCollection.findOne({ userId });
    const activeWallet = profile.wallets[0];

    const { getPositions } = await import('../../../cli/utils/api/client.js');
    const positionsRes = await getPositions(activeWallet.solAddress, { chainId: 'solana' });
    const livePositions = positionsRes.data || [];

    let realizedPnL = 0;
    let totalInvested = 0;
    let totalRecovered = 0;
    let completedCount = 0;
    let unrealizedPnLSum = 0;
    const openTradesInfo = [];

    for (const t of trades) {
      totalInvested += parseFloat(t.buyAmount || 0);
      
      if (t.status === 'open') {
        const pos = livePositions.find(p => p.attributes.fungible_info?.implementations?.some(i => i.address === t.mint));
        if (pos) {
          const currentPrice = pos.attributes.price || 0;
          const pnlPercent = t.buyPrice > 0 ? ((currentPrice - t.buyPrice) / t.buyPrice) * 100 : 0;
          const currentValSOL = (t.receivedAmount || 0) * currentPrice;
          
          unrealizedPnLSum += (currentValSOL - parseFloat(t.buyAmount));
          
          openTradesInfo.push({
            symbol: t.symbol,
            pnl: pnlPercent,
            value: currentValSOL
          });
        }
      } else {
        realizedPnL += (t.pnl || 0);
        totalRecovered += parseFloat(t.solReceived || 0);
        completedCount++;
      }
    }

    return {
      missionId,
      totalSniped: trades.length,
      completedCount,
      totalInvested,
      totalRecovered,
      realizedPnL: (totalRecovered - (totalInvested - (totalInvested/trades.length * openTradesInfo.length))), // Rough realized SOL PnL
      netRealizedPnL: totalRecovered - (totalInvested - (totalInvested/trades.length * openTradesInfo.length)),
      openTrades: openTradesInfo,
      unrealizedPnL: unrealizedPnLSum
    };
  }
}
