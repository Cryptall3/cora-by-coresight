import { connectToDatabase } from '../db.js';
import { UserService } from './user-service.js';
import * as solanaTracker from '../../../cli/utils/api/solana-tracker.js';
import { signAndSendRaptorTransaction } from '../../../cli/utils/chain/solana.js';
import crypto from 'crypto';

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
      console.log(`⚙️ [SETTINGS] Buy: ${settings.defaultBuyAmount} SOL | Slippage: ${settings.slippage} | Wallet: ${wallet.solAddress}`);

      // 1. Get Quote and Swap Transaction from Solana Tracker
      const SOL_MINT = "So11111111111111111111111111111111111111112";
      const amountLamports = Math.floor(settings.defaultBuyAmount * 1e9); 
      
      console.log(`📡 [EXECUTOR] Fetching Raptor quote with VERY HIGH priority and SOL fees...`);
      
      const raptorResult = await solanaTracker.quoteAndSwap({
        userPublicKey: wallet.solAddress,
        inputMint: SOL_MINT,
        outputMint: token.mint,
        amount: amountLamports,
        slippage: settings.slippage || 'auto', 
        priorityFee: "veryHigh",
        feeAccount: process.env.TREASURY_ADDRESS,
        feeBps: 100, // 1% platform fee
        feeFromInput: true // CRITICAL: Take fee in SOL to avoid ATA reverts
      });

      console.log(`📡 [RAPTOR-QUOTE] Est. Out: ${raptorResult.quote.amountOut / 1e6} | Impact: ${raptorResult.quote.priceImpact}%`);

      // 2. Sign and Send via Yellowstone Jet TPU
      // Compute the deterministic passphrase used by OWS to decrypt the local wallet file
      const serverSecret = process.env.ZERION_API_KEY || 'default_secret';
      const passphrase = crypto.createHmac('sha256', serverSecret).update(user.userId.toString() + wallet.id).digest('hex');

      const result = await signAndSendRaptorTransaction(
        raptorResult.swapTransaction,
        wallet.walletName,
        passphrase
      );

      // 3. Confirm Transaction Status On-Chain
      console.log(`⏳ [EXECUTOR] Tx broadcasted (${result.hash}). Verifying on-chain status...`);
      let txConfirmed = false;
      let txStatusData = null;
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          txStatusData = await solanaTracker.getTransactionStatus(result.hash);
          console.log(`🔍 [STATUS-POLL] Attempt ${i+1}: ${txStatusData.status}`);
          if (txStatusData.status !== "pending") {
            txConfirmed = true;
            break;
          }
        } catch (e) {}
      }

      console.log(`📊 [FULL-STATUS] ${JSON.stringify(txStatusData, null, 2)}`);

      if (!txConfirmed) {
        throw new Error("Transaction verification timed out. It may have been dropped.");
      }

      const hasError = txStatusData.status === "failed" || txStatusData.error || (txStatusData.meta && txStatusData.meta.err);
      if (hasError) {
        const errorMsg = txStatusData.error || (txStatusData.meta && JSON.stringify(txStatusData.meta.err)) || "Unknown Revert";
        throw new Error(`Transaction reverted on-chain: ${errorMsg}`);
      }

      console.log(`✅ [TRADE] Confirmed On-Chain! TX: ${result.hash}`);
      
      // 4. Record trade in DB
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
      const slippage = user.settings.slippage;

      const raptorResult = await solanaTracker.quoteAndSwap({
        userPublicKey: wallet.solAddress,
        inputMint: trade.mint,
        outputMint: SOL_MINT,
        amount: rawAmount,
        slippageBps: (slippage === 'auto' || !slippage) ? "dynamic" : (parseFloat(slippage) * 100).toString(),
        txVersion: "LEGACY",
        priorityFee: "medium",
        feeAccount: process.env.TREASURY_ADDRESS,
        feeBps: process.env.TREASURY_ADDRESS ? 100 : 0
      });

      console.log(`📝 [RAPTOR-QUOTE] Found exit route for ${trade.symbol}. Est. SOL: ${raptorResult.quote.amountOut / 1e9}`);

      // 3. Sign and Send
      const serverSecret = process.env.ZERION_API_KEY || 'default_secret';
      const passphrase = crypto.createHmac('sha256', serverSecret).update(user.userId.toString() + wallet.id).digest('hex');

      const result = await signAndSendRaptorTransaction(
        raptorResult.swapTransaction,
        wallet.walletName,
        passphrase
      );

      // 4. Confirm Transaction Status On-Chain
      console.log(`⏳ [EXECUTOR] Sell Tx broadcasted (${result.hash}). Verifying on-chain status...`);
      let txConfirmed = false;
      let txSuccess = false;
      for (let i = 0; i < 15; i++) { 
        await new Promise(r => setTimeout(r, 2000));
        try {
          const statusResult = await solanaTracker.getTransactionStatus(result.hash);
          if (statusResult.status !== "pending") {
            txConfirmed = true;
            if (statusResult.status === "failed" || statusResult.error || (statusResult.meta && statusResult.meta.err)) {
              txSuccess = false;
            } else {
              txSuccess = true;
            }
            break;
          }
        } catch (e) {}
      }

      if (!txConfirmed) {
        throw new Error("Sell transaction verification timed out. It may have been dropped.");
      }
      if (!txSuccess) {
        throw new Error("Sell transaction reverted on-chain (likely Slippage Exceeded).");
      }

      console.log(`✅ [SELL] Confirmed On-Chain! TX: ${result.hash}`);
      const solReceived = raptorResult.quote.amountOut / 1e9;
      const sellPrice = solReceived / balance; 
      await this.recordExit(trade._id, sellPrice, 'closed', result.hash, solReceived);
      return { success: true, hash: result.hash };

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
      const response = await getFungible(`solana:${mint}`);
      return {
        decimals: response.data?.attributes?.implementations?.[0]?.decimals || 6,
        symbol: response.data?.attributes?.symbol || 'TOKEN'
      };
    } catch (error) {
      // Silence log for unindexed new tokens to avoid spam
      return { decimals: 6, symbol: 'TOKEN' };
    }
  }

  async recordTrade(userId, token, quote, result, missionId = null) {
    // Extract metadata directly from the Raptor quote if available
    const decimals = quote.outputToken?.decimals || 6;
    const symbol = quote.outputToken?.symbol || token.symbol;

    const trade = {
      userId,
      missionId,
      mint: token.mint,
      symbol: symbol,
      decimals: decimals, 
      buyAmount: parseFloat(quote.amountIn) / 1e9, 
      buyPrice: token.price || (parseFloat(quote.amountIn) / 1e9 / (parseFloat(quote.amountOut) / Math.pow(10, decimals))), 
      entryMarketCap: (token.price || (parseFloat(quote.amountIn) / 1e9 / (parseFloat(quote.amountOut) / Math.pow(10, decimals)))) * 1000000000, 
      txHash: result.hash,
      timestamp: new Date(),
      status: 'open',
      pnl: 0,
      isAutoExit: true
    };

    await this.db.collection('trades').insertOne(trade);
    console.log(`📝 [EXECUTOR] Trade recorded for ${symbol} (Decimals: ${decimals})`);
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
