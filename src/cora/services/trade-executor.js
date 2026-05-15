import { connectToDatabase } from '../db.js';
import { UserService } from './user-service.js';
import * as jupiter from '../../../cli/utils/api/jupiter.js';
import * as ows from '../../../cli/utils/wallet/keystore.js';
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
   * Execute a snipe for a specific user and token using pure Jupiter Trigger V2 OTOCO flow.
   * No fallback. Pure Jupiter.
   */
  async executeSnipe(user, token) {
    try {
      await this.initialize();
      
      const activeProfile = await userService.createUserProfile(user.userId);
      const settings = activeProfile.settings;
      
      const wallet = activeProfile.wallets[0]; 
      const agentToken = wallet.agentToken;

      if (!agentToken) {
        throw new Error(`User ${user.userId} has no agent token for wallet ${wallet.walletName}`);
      }

      console.log(`🚀 [EXECUTOR] Starting Pure Jupiter Mission | User: ${user.userId} | Token: ${token.symbol}`);

      // 1. Derive passphrase for OWS signing
      const serverSecret = process.env.ZERION_API_KEY || 'default_secret';
      const passphrase = crypto.createHmac('sha256', serverSecret).update(user.userId.toString() + wallet.id).digest('hex');

      // 2. Authenticate with Jupiter Trigger API
      console.log(`🔑 [EXECUTOR] Authenticating session via challenge-response...`);
      const jwtToken = await jupiter.getJwtToken(wallet.walletName, wallet.solAddress, passphrase);

      // 3. Ensure Custodial Vault is Provisioned
      console.log(`🏦 [EXECUTOR] Provisioning/Verifying custodial trading vault...`);
      const vaultData = await jupiter.getVault(jwtToken);

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
        slSlippageBps: 2000,
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 // 30-day standard expiry
      };

      const orderRes = await jupiter.createOtocoOrder(jwtToken, orderPayload);
      const jupiterOrderId = orderRes.order?.id || orderRes.id || depositCraft.requestId;
      console.log(`✅ [EXECUTOR] Jupiter OTOCO successfully locked! Order ID: ${jupiterOrderId}`);

      // 8. Record the trade securely
      const actualPriceSol = currentTokenPriceUsd / solPriceUsd;
      await this.recordJupiterTrade(user, token, settings.defaultBuyAmount, actualPriceSol, jupiterOrderId, settings.currentMissionId);

      return {
        success: true,
        hash: depositCraft.requestId,
        symbol: token.symbol,
        amount: settings.defaultBuyAmount,
        price: actualPriceSol,
        engine: "jupiter",
        orderId: jupiterOrderId
      };

    } catch (error) {
      console.error(`❌ [EXECUTOR] Jupiter Execution failed for user ${user.userId}:`, error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Execute a manual exit via Jupiter Swap API V2
   */
  async executeSell(user, trade, sellPercentage = 100) {
    try {
      await this.initialize();
      const wallet = user.wallets[0]; 
      
      console.log(`📉 [EXECUTOR] Starting Jupiter SELL for ${user.userId} | Token: ${trade.symbol} | Amount: ${sellPercentage}%`);

      const balance = await this.getTokenBalance(wallet.solAddress, trade.mint);
      if (balance <= 0) {
        await this.recordExit(trade._id, 0, 'closed_zero_balance', null);
        return { success: true };
      }

      const SOL_MINT = "So11111111111111111111111111111111111111112";
      const tokenInfo = await this.getTokenMetadata(trade.mint);
      const amountToSell = balance * (sellPercentage / 100);
      const rawAmount = Math.floor(amountToSell * Math.pow(10, tokenInfo.decimals || 6));
      
      // 1. Get Quote and Transaction from Jupiter Swap API V2
      const orderRes = await fetch(`https://api.jup.ag/swap/v2/order?inputMint=${trade.mint}&outputMint=${SOL_MINT}&amount=${rawAmount}&taker=${wallet.solAddress}`);
      if (!orderRes.ok) throw new Error(`Jupiter Swap Quote failed: ${await orderRes.text()}`);
      
      const orderData = await orderRes.json();
      
      // 2. Sign Transaction with OWS
      const serverSecret = process.env.ZERION_API_KEY || 'default_secret';
      const passphrase = crypto.createHmac('sha256', serverSecret).update(user.userId.toString() + wallet.id).digest('hex');
      
      const txBuf = Buffer.from(orderData.transaction, "base64");
      const txHex = txBuf.toString("hex");
      const signResult = ows.signSolanaTransaction(wallet.walletName, txHex, passphrase);
      const signatureBytes = Buffer.from(signResult.signature, "hex");
      signatureBytes.copy(txBuf, 1);
      const signedTxBase64 = txBuf.toString("base64");

      // 3. Execute via Jupiter Managed Landing
      const execRes = await fetch(`https://api.jup.ag/swap/v2/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: orderData.requestId,
          transaction: signedTxBase64
        })
      });

      if (!execRes.ok) throw new Error(`Jupiter Swap Execute failed: ${await execRes.text()}`);
      const execData = await execRes.json();

      console.log(`✅ [SELL] Confirmed On-Chain via Jupiter! TX: ${execData.txid}`);
      const solReceived = orderData.routePlan[orderData.routePlan.length - 1].swapInfo.outAmount / 1e9;
      const sellPrice = solReceived / balance; 
      await this.recordExit(user.userId, trade.mint, sellPrice, sellPercentage, execData.txid, solReceived);
      
      return { success: true, hash: execData.txid, solReceived, sellPrice };

    } catch (error) {
      console.error(`❌ [EXECUTOR] Jupiter Sell failed for user ${user.userId}:`, error.message);
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
      txHash: jupiterOrderId,
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
    console.log(`💰 [EXIT] ${percentage}% sold for ${mint} | Realized Profit: ${realizedProfitSOL.toFixed(4)} SOL`);
  }
}
