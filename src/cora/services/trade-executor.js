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
      isAutoExit: true // Based on user settings
    };

    await this.db.collection('trades').insertOne(trade);
  }
}
