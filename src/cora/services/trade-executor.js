import { connectToDatabase } from '../db.js';
import { UserService } from './user-service.js';
import * as solanaTracker from '../../../cli/utils/api/solana-tracker.js';
import { signAndSendRaptorTransaction } from '../../../cli/utils/chain/solana.js';
import * as jupiter from '../../../cli/utils/api/jupiter.js';
import * as ows from '../../../cli/utils/wallet/keystore.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { Buffer } from 'node:buffer';
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
   * Check if a token mint uses the Token-2022 program.
   */
  async isToken2022Program(mintAddress) {
    try {
      const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
      const connection = new Connection(rpcUrl);
      const info = await connection.getAccountInfo(new PublicKey(mintAddress));
      if (info && info.owner.toString() === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") {
        return true;
      }
    } catch (err) {
      console.warn(`⚠️ [EXECUTOR] Could not verify program ID for ${mintAddress}:`, err.message);
    }
    return false;
  }

  /**
   * Execute a snipe for a specific user and token using Jupiter Trigger V2 OTOCO flow.
   * Automatically falls back to Raptor for Token-2022 compatibility.
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

      console.log(`🚀 [EXECUTOR] Starting Trade Mission | User: ${user.userId} | Token: ${token.symbol}`);

      // Perform pre-flight check for Token-2022 compatibility
      const isT2022 = await this.isToken2022Program(token.mint);
      if (isT2022) {
        console.log(`⚠️ [EXECUTOR] Token-2022 detected for ${token.symbol}. Falling back to legacy Raptor High-Speed Sniping.`);
        return await this.executeRaptorSnipe(user, token, activeProfile, wallet, settings);
      }

      console.log(`⚡️ [EXECUTOR] Standard SPL Token detected. Initiating Jupiter V2 Trigger OTOCO Flow...`);

      // 1. Derive passphrase for OWS signing
      const serverSecret = process.env.ZERION_API_KEY || 'default_secret';
      const passphrase = crypto.createHmac('sha256', serverSecret).update(user.userId.toString() + wallet.id).digest('hex');

      // 2. Authenticate with Jupiter Trigger API
      console.log(`🔑 [EXECUTOR] Authenticating session via challenge-response...`);
      const jwtToken = await jupiter.getJwtToken(wallet.walletName, wallet.solAddress, passphrase);

      // 3. Ensure Custodial Vault is Provisioned
      console.log(`🏦 [EXECUTOR] Provisioning/Verifying custodial trading vault...`);
      const vaultData = await jupiter.getVault(jwtToken);
      console.log(`✅ [EXECUTOR] Vault verified: ${vaultData.vaultPubkey}`);

      // 4. Fetch Live USD Prices for precise bracketing targets
      const [priceRes, solRes] = await Promise.all([
        fetch(`https://data.solanatracker.io/price?token=${token.mint}`, { headers: { 'x-api-key': process.env.SOLANATRACKER_API_KEY } }),
        fetch(`https://data.solanatracker.io/price?token=So11111111111111111111111111111111111111112`, { headers: { 'x-api-key': process.env.SOLANATRACKER_API_KEY } })
      ]).catch(() => [null, null]);

      const [priceData, solData] = await Promise.all([
        priceRes ? priceRes.json() : null,
        solRes ? solRes.json() : null
      ]);

      const solPriceUsd = solData?.price || 150;
      const currentTokenPriceUsd = priceData?.price || 0.0001;
      
      // Calculate tactics price brackets in absolute USD
      const parentTriggerPriceUsd = currentTokenPriceUsd * 0.95; // Trigger buy instantly since current price > 95%
      const tpPriceUsd = currentTokenPriceUsd * (1 + (settings.tpPercent || 100) / 100);
      const slPriceUsd = currentTokenPriceUsd * (1 - (settings.slPercent || 50) / 100);

      const SOL_MINT = "So11111111111111111111111111111111111111112";
      const amountLamports = Math.floor(settings.defaultBuyAmount * 1e9);
      const slippageBps = settings.slippage && settings.slippage !== 'auto' ? Math.floor(parseFloat(settings.slippage) * 100) : 250;

      // 5. Craft Deposit Transaction
      console.log(`📦 [EXECUTOR] Crafting Jupiter OTOCO deposit payload...`);
      const depositCraft = await jupiter.craftDeposit(jwtToken, {
        inputMint: SOL_MINT,
        outputMint: token.mint,
        userAddress: wallet.solAddress,
        amount: amountLamports,
        orderSubType: "otoco"
      });

      // 6. Sign Deposit Transaction natively via OWS injection
      console.log(`✍️ [EXECUTOR] Signing custodial vault deposit transaction...`);
      const txBuf = Buffer.from(depositCraft.transaction, "base64");
      const txHex = txBuf.toString("hex");
      const signResult = ows.signSolanaTransaction(wallet.walletName, txHex, passphrase);
      const signatureBytes = Buffer.from(signResult.signature, "hex");
      signatureBytes.copy(txBuf, 1);
      const depositSignedTx = txBuf.toString("base64");

      // 7. Submit Bundled OTOCO Order
      console.log(`🚀 [EXECUTOR] Broadcasting autonomous OTOCO trigger order...`);
      const orderPayload = {
        orderType: "otoco",
        depositRequestId: depositCraft.requestId,
        depositSignedTx,
        userPubkey: wallet.solAddress,
        inputMint: SOL_MINT,
        inputAmount: amountLamports.toString(),
        outputMint: token.mint,
        triggerMint: token.mint,
        triggerCondition: "above",
        triggerPriceUsd: Number(parentTriggerPriceUsd.toFixed(6)),
        tpPriceUsd: Number(tpPriceUsd.toFixed(6)),
        slPriceUsd: Number(slPriceUsd.toFixed(6)),
        slippageBps,
        tpSlippageBps: 250,
        slSlippageBps: 2000, // 20% stop-loss execution certainty
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 // 30-day standard expiry
      };

      const orderRes = await jupiter.createOtocoOrder(jwtToken, orderPayload);
      const jupiterOrderId = orderRes.order?.id || orderRes.id || depositCraft.requestId;
      console.log(`✅ [EXECUTOR] Jupiter OTOCO successfully locked! Order ID: ${jupiterOrderId}`);

      // 8. Record the trade securely
      const actualPriceSol = currentTokenPriceUsd / solPriceUsd;
      const tradeRecord = await this.recordJupiterTrade(user, token, settings.defaultBuyAmount, actualPriceSol, jupiterOrderId, settings.currentMissionId);

      return {
        success: true,
        hash: depositCraft.requestId, // Map request ID as identifier for tracking
        symbol: token.symbol,
        amount: settings.defaultBuyAmount,
        price: actualPriceSol,
        engine: "jupiter",
        orderId: jupiterOrderId
      };

    } catch (error) {
      console.error(`❌ [EXECUTOR] Execution failed for user ${user.userId}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Fallback Execution path for Token-2022 assets using legacy Raptor High-Speed logic.
   */
  async executeRaptorSnipe(user, token, activeProfile, wallet, settings) {
    try {
      console.log(`⚙️ [SETTINGS] Buy: ${settings.defaultBuyAmount} SOL | Slippage: ${settings.slippage} | Wallet: ${wallet.solAddress}`);

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
        feeBps: 100,
        feeFromInput: true
      });

      const serverSecret = process.env.ZERION_API_KEY || 'default_secret';
      const passphrase = crypto.createHmac('sha256', serverSecret).update(user.userId.toString() + wallet.id).digest('hex');

      const result = await signAndSendRaptorTransaction(
        raptorResult.swapTransaction,
        wallet.walletName,
        passphrase
      );

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

      if (!txConfirmed) {
        throw new Error("Transaction verification timed out. It may have been dropped.");
      }

      const hasError = txStatusData.status === "failed" || txStatusData.error || (txStatusData.meta && txStatusData.meta.err);
      if (hasError) {
        const errorMsg = txStatusData.error || (txStatusData.meta && JSON.stringify(txStatusData.meta.err)) || "Unknown Revert";
        throw new Error(`Transaction reverted on-chain: ${errorMsg}`);
      }

      console.log(`✅ [TRADE] Confirmed On-Chain! TX: ${result.hash}`);
      
      const executionData = await this.recordTrade(user, token, raptorResult.quote, result, settings.currentMissionId);

      return {
        success: true,
        hash: result.hash,
        symbol: token.symbol,
        amount: settings.defaultBuyAmount,
        price: executionData.buyPrice,
        engine: "raptor"
      };
    } catch (err) {
      throw err;
    }
  }

  /**
   * Execute a sell (swap back to SOL) for a specific trade
   */
  async executeSell(user, trade, sellPercentage = 100) {
    try {
      await this.initialize();
      
      const wallet = user.wallets[0]; 
      const agentToken = wallet.agentToken;

      if (!agentToken) {
        throw new Error('No secure agent token found.');
      }

      console.log(`📉 [EXECUTOR] Starting Raptor SELL for ${user.userId} | Token: ${trade.symbol} | Amount: ${sellPercentage}%`);

      const balance = await this.getTokenBalance(wallet.solAddress, trade.mint);
      if (balance <= 0) {
        console.log(`⚠️ [EXECUTOR] Zero balance for ${trade.symbol}. Marking as closed.`);
        await this.recordExit(trade._id, 0, 'closed_zero_balance', null);
        return { success: true };
      }

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

      const serverSecret = process.env.ZERION_API_KEY || 'default_secret';
      const passphrase = crypto.createHmac('sha256', serverSecret).update(user.userId.toString() + wallet.id).digest('hex');

      const result = await signAndSendRaptorTransaction(
        raptorResult.swapTransaction,
        wallet.walletName,
        passphrase
      );

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
      await this.recordExit(user.userId, trade.mint, sellPrice, sellPercentage, result.hash, solReceived);
      return { success: true, hash: result.hash, solReceived, sellPrice };

    } catch (error) {
      console.error(`❌ [EXECUTOR] Raptor Sell failed for user ${user.userId}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  async getTokenBalance(address, mint) {
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

  async getTokenMetadata(mint) {
    try {
      const { getFungible } = await import('../../../cli/utils/api/client.js');
      const response = await getFungible(`solana:${mint}`);
      return {
        decimals: response.data?.attributes?.implementations?.[0]?.decimals || 6,
        symbol: response.data?.attributes?.symbol || 'TOKEN'
      };
    } catch (error) {
      return { decimals: 6, symbol: 'TOKEN' };
    }
  }

  async recordTrade(user, token, quote, result, missionId) {
    const { symbol } = await this.getTokenMetadata(token.mint);
    
    const swapEvent = result.events?.find(e => e.name === 'SwapCompleteEvent')?.parsed;
    
    const decimals = swapEvent ? swapEvent.outputDecimals : 6;
    const receivedAmountRaw = swapEvent ? parseFloat(swapEvent.outputAmount) : parseFloat(quote.amountOut);
    const receivedAmount = receivedAmountRaw / Math.pow(10, decimals);
    
    const spentAmountSOL = swapEvent ? parseFloat(swapEvent.inputAmount) / 1e9 : parseFloat(quote.amountIn) / 1e9;
    const actualPrice = spentAmountSOL / receivedAmount;

    const trade = {
      userId: user.userId,
      missionId,
      mint: token.mint,
      symbol: symbol,
      decimals: decimals, 
      buyAmount: spentAmountSOL, 
      buyPrice: actualPrice,
      entryMarketCap: actualPrice * 1000000000,
      receivedAmount: receivedAmount,
      txHash: result.hash,
      timestamp: new Date(),
      status: 'open',
      pnl: 0,
      isAutoExit: true,
      engine: 'raptor'
    };

    await this.db.collection('trades').insertOne(trade);
    console.log(`📝 [EXECUTOR] Trade recorded for ${symbol} | Price: ${actualPrice.toFixed(10)} | MCap: ${(actualPrice * 1e9).toFixed(0)}`);
    
    return trade;
  }

  async recordJupiterTrade(user, token, spentAmountSOL, actualPriceSol, jupiterOrderId, missionId) {
    const { symbol, decimals } = await this.getTokenMetadata(token.mint);
    const receivedAmount = spentAmountSOL / actualPriceSol;

    const trade = {
      userId: user.userId,
      missionId,
      mint: token.mint,
      symbol: symbol,
      decimals: decimals, 
      buyAmount: spentAmountSOL, 
      buyPrice: actualPriceSol,
      entryMarketCap: actualPriceSol * 1000000000,
      receivedAmount: receivedAmount,
      txHash: jupiterOrderId, // Track request ID as virtual hash
      jupiterOrderId: jupiterOrderId,
      timestamp: new Date(),
      status: 'open',
      pnl: 0,
      isAutoExit: true,
      engine: 'jupiter'
    };

    await this.db.collection('trades').insertOne(trade);
    console.log(`📝 [EXECUTOR] Jupiter Trade recorded for ${symbol} | Order ID: ${jupiterOrderId}`);
    
    return trade;
  }

  async recordExit(userId, mint, sellPrice, percentage, hash, solReceived = 0) {
    const trades = await this.db.collection('trades').find({ userId, mint, status: 'open' }).toArray();
    if (trades.length === 0) return;

    let totalSpentSOL = 0;
    let totalTokensReceived = 0;
    trades.forEach(t => {
      totalSpentSOL += t.buyAmount || 0;
      totalTokensReceived += t.receivedAmount || (t.buyAmount / t.buyPrice);
    });

    const avgEntryPrice = totalSpentSOL / totalTokensReceived;
    const tokensToSell = totalTokensReceived * (percentage / 100);
    const profitPerToken = sellPrice - avgEntryPrice;
    const realizedProfitSOL = tokensToSell * profitPerToken;

    for (const trade of trades) {
      const tradeReductionFactor = percentage / 100;
      const soldFromThisTrade = trade.receivedAmount * tradeReductionFactor;
      const solBasisFromThisTrade = trade.buyAmount * tradeReductionFactor;
      
      const newReceivedAmount = trade.receivedAmount - soldFromThisTrade;
      const newBuyAmount = trade.buyAmount - solBasisFromThisTrade;

      if (newReceivedAmount < 0.000001 || percentage === 100) {
        await this.db.collection('trades').updateOne(
          { _id: trade._id },
          { 
            $set: { 
              status: 'closed',
              sellPrice,
              sellHash: hash,
              solReceived: solReceived * (trade.receivedAmount / totalTokensReceived),
              closedAt: new Date(),
              pnl: ((sellPrice - trade.buyPrice) / trade.buyPrice) * 100
            }
          }
        );
      } else {
        await this.db.collection('trades').updateOne(
          { _id: trade._id },
          { 
            $set: { 
              receivedAmount: newReceivedAmount,
              buyAmount: newBuyAmount
            },
            $push: {
              exits: {
                percentage,
                sellPrice,
                solReceived: solReceived * (soldFromThisTrade / totalTokensReceived),
                timestamp: new Date(),
                hash
              }
            }
          }
        );
      }
    }

    console.log(`💰 [DCA-EXIT] ${percentage}% sold for ${mint} | Realized Profit: ${realizedProfitSOL.toFixed(4)} SOL`);
  }
}
