import { getSwapQuote, executeSwap } from '../../../cli/utils/trading/swap.js';
import { connectToDatabase } from '../db.js';
import { UserService } from './user-service.js';

const userService = new UserService();

export class TradeExecutor {
  constructor() {
    this.db = null;
  }

  async initialize() {
    if (!this.db) {
      this.db = await connectToDatabase();
    }
  }

  /**
   * Execute a snipe for a specific user and token
   */
  async executeSnipe(user, token) {
    try {
      await this.initialize();
      const settings = user.settings;
      
      // Use the primary wallet and its secure agent token
      const wallet = user.wallets[0]; 
      const agentToken = wallet.agentToken;

      if (!agentToken) {
        throw new Error('No secure agent token found. Please restart the sniper.');
      }

      console.log(`🚀 [EXECUTOR] Starting trade for ${user.userId} | Token: ${token.symbol}`);

      // 1. Get Quote
      const quote = await getSwapQuote({
        fromToken: 'SOL',
        toToken: token.mint,
        amount: settings.defaultBuyAmount.toString(),
        fromChain: 'solana',
        toChain: 'solana',
        walletAddress: wallet.solAddress,
        slippage: settings.slippage
      });

      console.log(`📝 [QUOTE] Found route for ${token.symbol}. Est. Output: ${quote.estimatedOutput}`);

      // 2. Execute Swap using the Agent Token
      // We temporarily set the agent token in the environment for the OWS signer
      process.env.ZERION_AGENT_TOKEN = agentToken;
      
      const result = await executeSwap(
        quote,
        wallet.walletName,
        null // We pass NULL because we are using the Agent Token for signing
      );

      // Cleanup
      delete process.env.ZERION_AGENT_TOKEN;

      if (result.status === 'success') {
        console.log(`✅ [TRADE] Success! TX: ${result.hash}`);
        await this.recordTrade(user.userId, token, quote, result);
        return { success: true, hash: result.hash };
      } else {
        throw new Error(result.error || 'Swap failed');
      }

    } catch (error) {
      console.error(`❌ [EXECUTOR] Trade failed for user ${user.userId}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Execute a sell (swap back to SOL) for a specific trade
   */
  async executeSell(user, trade) {
    try {
      await this.initialize();
      
      // Use the primary wallet and its secure agent token
      const wallet = user.wallets[0]; 
      const agentToken = wallet.agentToken;

      if (!agentToken) {
        throw new Error('No secure agent token found.');
      }

      console.log(`📉 [EXECUTOR] Starting SELL for ${user.userId} | Token: ${trade.symbol}`);

      // 1. Get the current balance of the token to sell
      const balance = await this.getTokenBalance(wallet.solAddress, trade.mint);
      if (balance <= 0) {
        console.log(`⚠️ [EXECUTOR] Zero balance for ${trade.symbol}. Marking as closed.`);
        await this.recordExit(trade._id, 0, 'closed_zero_balance', null);
        return { success: true };
      }

      // 2. Get Quote for SELL (Token -> SOL)
      const quote = await getSwapQuote({
        fromToken: trade.mint,
        toToken: 'SOL',
        amount: balance.toString(),
        fromChain: 'solana',
        toChain: 'solana',
        walletAddress: wallet.solAddress,
        slippage: user.settings.slippage || 1.0
      });

      console.log(`📝 [QUOTE] Found exit route for ${trade.symbol}. Est. SOL: ${quote.estimatedOutput}`);

      // 3. Execute Swap
      process.env.ZERION_AGENT_TOKEN = agentToken;
      const result = await executeSwap(quote, wallet.walletName, null);
      delete process.env.ZERION_AGENT_TOKEN;

      if (result.status === 'success') {
        console.log(`✅ [SELL] Success! TX: ${result.hash}`);
        const sellPrice = quote.estimatedOutput / balance; // Rough estimate or use market price
        await this.recordExit(trade._id, sellPrice, 'closed', result.hash, quote.estimatedOutput);
        return { success: true, hash: result.hash };
      } else {
        throw new Error(result.error || 'Sell swap failed');
      }

    } catch (error) {
      console.error(`❌ [EXECUTOR] Sell failed for user ${user.userId}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  async getTokenBalance(address, mint) {
    // This is a helper to get balance via Zerion API or web3
    try {
      const { getPositions } = await import('../../../cli/utils/api/client.js');
      const response = await getPositions(address, { chainId: 'solana' });
      const match = (response.data || []).find(
        p => p.attributes.fungible_info?.implementations?.some(i => i.address === mint)
      );
      return match?.attributes?.quantity?.float ?? 0;
    } catch (error) {
      console.error('❌ [EXECUTOR] Balance fetch error:', error);
      return 0;
    }
  }

  async recordTrade(userId, token, quote, result) {
    const trade = {
      userId,
      mint: token.mint,
      symbol: token.symbol,
      buyAmount: quote.inputAmount,
      buyPrice: token.price || 0, // Market price at detection
      receivedAmount: quote.estimatedOutput,
      txHash: result.hash,
      timestamp: new Date(),
      status: 'open',
      pnl: 0,
      isAutoExit: true
    };

    await this.db.collection('trades').insertOne(trade);
  }

  async recordExit(tradeId, sellPrice, status, hash, solReceived = 0) {
    const update = {
      $set: {
        status,
        sellPrice,
        sellHash: hash,
        solReceived,
        closedAt: new Date()
      }
    };
    
    // Calculate PnL if we have buyPrice and sellPrice
    const trade = await this.db.collection('trades').findOne({ _id: tradeId });
    if (trade && trade.buyPrice > 0 && sellPrice > 0) {
      const pnlPercent = ((sellPrice - trade.buyPrice) / trade.buyPrice) * 100;
      update.$set.pnl = pnlPercent;
    }

    await this.db.collection('trades').updateOne({ _id: tradeId }, update);
  }
}
