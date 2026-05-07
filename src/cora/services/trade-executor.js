import { connectToDatabase } from '../db.js';
import { UserService } from './user-service.js';
import * as solanaTracker from '../../../cli/utils/api/solana-tracker.js';
import { signAndSendRaptorTransaction } from '../../../cli/utils/chain/solana.js';

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
      
      const activeProfile = await userService.createUserProfile(user.userId);
      const settings = activeProfile.settings;
      
      // Use the primary wallet and its secure agent token
      const wallet = activeProfile.wallets[0]; 
      const agentToken = wallet.agentToken;

      if (!agentToken) {
        throw new Error(`User ${user.userId} has no agent token for wallet ${wallet.walletName}`);
      }

      console.log(`🚀 [EXECUTOR] Starting Raptor Snipe | User: ${user.userId} | Token: ${token.symbol}`);

      // 1. Get Quote and Swap Transaction from Solana Tracker (Raptor)
      const SOL_MINT = "So11111111111111111111111111111111111111112";
      const amountLamports = Math.floor(settings.defaultBuyAmount * 1e9); // Convert SOL to lamports
      
      const raptorResult = await solanaTracker.quoteAndSwap({
        userPublicKey: wallet.solAddress,
        inputMint: SOL_MINT,
        outputMint: token.mint,
        amount: amountLamports,
        slippage: settings.slippage || 3.0, // Uses full user-defined slippage
        priorityFee: "high", // Sniper mode!
        feeAccount: process.env.TREASURY_ADDRESS, // Platform fee recipient
        feeBps: process.env.TREASURY_ADDRESS ? 100 : 0 // 1% fee if treasury set
      });

      console.log(`📡 [RAPTOR-QUOTE] Est. ${token.symbol} Out: ${raptorResult.quote.amountOut / 1e6}`);

      // 2. Sign and Send via Yellowstone Jet TPU
      // Inject the agent token into the environment for secure OWS signing
      process.env.ZERION_AGENT_TOKEN = agentToken;
      let result;
      try {
        result = await signAndSendRaptorTransaction(
          raptorResult.swapTransaction,
          wallet.walletName,
          null // Passphrase handled by agent token
        );
      } finally {
        // Always clean up the agent token
        delete process.env.ZERION_AGENT_TOKEN;
      }

      console.log(`✅ [TRADE] Success! TX: ${result.hash}`);
      
      // 3. Record trade in DB
      await this.recordTrade(user.userId, token, raptorResult.quote, result, settings.currentMissionId);

      return {
        success: true,
        hash: result.hash,
        symbol: token.symbol,
        amount: settings.defaultBuyAmount
      };

    } catch (error) {
      console.error(`❌ [EXECUTOR] Raptor Snipe failed for user ${user.userId}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Execute a sell (swap back to SOL) for a specific trade
   */
  async executeSell(user, trade, sellPercentage = 100) {
    try {
      await this.initialize();
      
      // Use the primary wallet and its secure agent token
      const wallet = user.wallets[0]; 
      const agentToken = wallet.agentToken;

      if (!agentToken) {
        throw new Error('No secure agent token found.');
      }

      console.log(`📉 [EXECUTOR] Starting Raptor SELL for ${user.userId} | Token: ${trade.symbol} | Amount: ${sellPercentage}%`);

      // 1. Get the current balance of the token to sell
      const balance = await this.getTokenBalance(wallet.solAddress, trade.mint);
      if (balance <= 0) {
        console.log(`⚠️ [EXECUTOR] Zero balance for ${trade.symbol}. Marking as closed.`);
        await this.recordExit(trade._id, 0, 'closed_zero_balance', null);
        return { success: true };
      }

      // 2. Get Quote and Swap Transaction for SELL (Token -> SOL)
      const SOL_MINT = "So11111111111111111111111111111111111111112";
      
      const tokenInfo = await this.getTokenMetadata(trade.mint);
      const amountToSell = balance * (sellPercentage / 100);
      const rawAmount = Math.floor(amountToSell * Math.pow(10, tokenInfo.decimals || 6));

      const raptorResult = await solanaTracker.quoteAndSwap({
        userPublicKey: wallet.solAddress,
        inputMint: trade.mint,
        outputMint: SOL_MINT,
        amount: rawAmount,
        slippage: user.settings.slippage || 3.0,
        priorityFee: "medium",
        feeAccount: process.env.TREASURY_ADDRESS,
        feeBps: process.env.TREASURY_ADDRESS ? 100 : 0
      });

      console.log(`📝 [RAPTOR-QUOTE] Found exit route for ${trade.symbol}. Est. SOL: ${raptorResult.quote.amountOut / 1e9}`);

      // 3. Sign and Send
      process.env.ZERION_AGENT_TOKEN = agentToken;
      let result;
      try {
        result = await signAndSendRaptorTransaction(
          raptorResult.swapTransaction,
          wallet.walletName,
          null
        );
      } finally {
        delete process.env.ZERION_AGENT_TOKEN;
      }

      if (result.hash) {
        console.log(`✅ [SELL] Success! TX: ${result.hash}`);
        const solReceived = raptorResult.quote.amountOut / 1e9;
        const sellPrice = solReceived / balance; 
        await this.recordExit(trade._id, sellPrice, 'closed', result.hash, solReceived);
        return { success: true, hash: result.hash };
      } else {
        throw new Error('Sell swap failed to return hash');
      }

    } catch (error) {
      console.error(`❌ [EXECUTOR] Raptor Sell failed for user ${user.userId}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  async getTokenBalance(address, mint) {
    try {
      // We can use Zerion for balance checking (it's reliable for indexer data)
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

  async getTokenMetadata(mint) {
    try {
      const { getFungible } = await import('../../../cli/utils/api/client.js');
      const response = await getFungible(`solana/${mint}`);
      return {
        decimals: response.data?.attributes?.implementations?.[0]?.decimals || 6,
        symbol: response.data?.attributes?.symbol || 'TOKEN'
      };
    } catch (error) {
      return { decimals: 6, symbol: 'TOKEN' };
    }
  }

  async recordTrade(userId, token, quote, result, missionId = null) {
    const meta = await this.getTokenMetadata(token.mint);
    const trade = {
      userId,
      missionId,
      mint: token.mint,
      symbol: token.symbol,
      buyAmount: parseFloat(quote.amountIn) / 1e9, // SOL spent
      buyPrice: token.price || 0, // Market price at detection
      receivedAmount: parseFloat(quote.amountOut) / Math.pow(10, meta.decimals),
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
    
    const trade = await this.db.collection('trades').findOne({ _id: tradeId });
    if (trade && trade.buyPrice > 0 && sellPrice > 0) {
      const pnlPercent = ((sellPrice - trade.buyPrice) / trade.buyPrice) * 100;
      update.$set.pnl = pnlPercent;
    }

    await this.db.collection('trades').updateOne({ _id: tradeId }, update);
  }
}
