import { connectToDatabase } from '../db.js';
import { UserService } from './user-service.js';
import { TradeExecutor } from './trade-executor.js';

const userService = new UserService();
const tradeExecutor = new TradeExecutor();

export class AlphaListener {
  constructor() {
    this.isRunning = false;
    this.db = null;
    this.coraDb = null;
    this.changeStream = null;
  }

  async start(bot = null) {
    if (this.isRunning) return;
    this.bot = bot;
    
    try {
      console.log('📡 [ALPHA LISTENER] Connecting to signal stream...');
      
      // 1. Connect to both databases
      this.coraDb = await connectToDatabase(); // cora-bot (settings)
      this.db = await connectToDatabase('coresight-bot'); // coresight-bot (signals)
      
      const signalCollection = this.db.collection('alpha_tokens');
      const profileCollection = this.coraDb.collection('user_profiles');

      this.isRunning = true;
      console.log('✅ [ALPHA LISTENER] Watching alpha_tokens for new signals...');

      // 2. Use Change Stream for real-time detection (Requires Replica Set)
      this.changeStream = signalCollection.watch([
        { $match: { operationType: 'insert' } }
      ]);

      this.changeStream.on('change', async (change) => {
        const token = change.fullDocument;
        console.log(`🎯 [SIGNAL] New Alpha Detected: ${token.symbol} (${token.mint})`);

        // 3. Find all users with sniping enabled and valid mission window
        const activeSnipers = await profileCollection.find({
          'settings.snipeEnabled': true,
          $or: [
            { 'settings.snipeExpiration': { $exists: false } },
            { 'settings.snipeExpiration': null },
            { 'settings.snipeExpiration': { $gt: new Date() } }
          ]
        }).toArray();

        if (activeSnipers.length === 0) {
          console.log(`ℹ️ [SIGNAL] No active snipers found for ${token.symbol}. Skipping.`);
          return;
        }

        console.log(`🚀 [SNIPE] Executing trades for ${activeSnipers.length} users on ${token.symbol}...`);

        // 4. Trigger trade for each user
        for (const user of activeSnipers) {
          this.executeSnipe(user, token);
        }
      });

      // Fallback for environments without Change Streams (Polling)
      this.changeStream.on('error', (err) => {
        console.warn('⚠️ [ALPHA LISTENER] Change Stream failed. Falling back to polling...', err.message);
        this.startPolling(signalCollection, profileCollection);
      });

    } catch (error) {
      console.error('❌ [ALPHA LISTENER] Start error:', error);
    }
  }

  async startPolling(signalCollection, profileCollection) {
    let lastSeenId = null;

    setInterval(async () => {
      try {
        const query = lastSeenId ? { _id: { $gt: lastSeenId } } : {};
        const newTokens = await signalCollection.find(query).sort({ _id: 1 }).toArray();

        for (const token of newTokens) {
          lastSeenId = token._id;
          console.log(`🎯 [SIGNAL-POLL] New Alpha Detected: ${token.symbol}`);
          
          const activeSnipers = await profileCollection.find({ 
            'settings.snipeEnabled': true,
            $or: [
              { 'settings.snipeExpiration': { $exists: false } },
              { 'settings.snipeExpiration': null },
              { 'settings.snipeExpiration': { $gt: new Date() } }
            ]
          }).toArray();
          for (const user of activeSnipers) {
            this.executeSnipe(user, token);
          }
        }
      } catch (err) {
        console.error('❌ [POLLING] Error:', err);
      }
    }, 5000); // Poll every 5 seconds
  }

  async executeSnipe(user, token) {
    try {
      console.log(`🔫 [SNIPE-EXEC] User ${user.userId} is sniping ${token.symbol}...`);
      
      const result = await tradeExecutor.executeSnipe(user, token);
      
      if (result.success) {
        console.log(`💰 [SNIPE-SUCCESS] User ${user.userId} bought ${token.symbol}! Hash: ${result.hash}`);
        
        if (this.bot) {
          // Fetch MC for the alert
          const priceRes = await fetch(`https://data.solanatracker.io/price?token=${token.mint}`, {
            headers: { 'x-api-key': process.env.SOLANATRACKER_API_KEY }
          }).catch(() => null);
          const priceData = priceRes ? await priceRes.json() : null;
          const entryMC = priceData?.marketCap || 0;

          const formatMCap = (val) => {
            if (!val || val === 0) return 'N/A';
            if (val >= 1000000) return (val/1000000).toFixed(1) + 'M';
            if (val >= 1000) return (val/1000).toFixed(1) + 'k';
            return val.toFixed(0);
          };

          const tpPct = user.settings?.tpPercent || 100;
          const slPct = user.settings?.slPercent || 50;
          const footerStr = result.engine === 'jupiter'
            ? `⚡️ <b>Jupiter Trigger Activated:</b> Fully automated on-chain OTOCO limits locked at <b>+${tpPct}% TP</b> and <b>-${slPct}% SL</b>.`
            : `<i>Cora is now monitoring this position for Take Profit (+${tpPct}%) and Stop Loss (-${slPct}%).</i>`;

          const msg = `
🚀 <b>Alpha Sniper: Position Opened!</b>

<b>Token:</b> $${token.symbol}
<b>Amount:</b> <code>${result.amount} SOL</code>
<b>Price:</b> <code>${result.price > 0 ? result.price.toFixed(10) : 'Market'} SOL</code>
<b>Entry MC:</b> <b>$${formatMCap(entryMC)}</b>
<b>TX:</b> <a href="https://solscan.io/tx/${result.hash}">View on Solscan</a>

${footerStr}
          `;
          await this.bot.telegram.sendMessage(user.userId, msg, { 
            parse_mode: 'HTML',
            disable_web_page_preview: true
          }).catch(() => {});
        }
      } else {
        console.error(`⚠️ [SNIPE-FAIL] User ${user.userId} failed: ${result.error}`);
        
        if (this.bot) {
          const reason = result.error.includes('insufficient') ? 'Insufficient SOL balance' : result.error;
          const msg = `
⚠️ **Alpha Sniper: Buy Failed**

**Token:** $${token.symbol}
**Address:** \`${token.mint}\`
**Reason:** ${reason}

_Required: \`${(user.settings.defaultBuyAmount + 0.005).toFixed(3)} SOL\` (inc. gas)_
_Please fund your primary wallet to resume sniping._
          `;
          await this.bot.telegram.sendMessage(user.userId, msg, { parse_mode: 'Markdown' }).catch(() => {});
        }
      }
    } catch (error) {
      console.error(`❌ [SNIPE-EXEC] Critical Error for user ${user.userId}:`, error);
    }
  }
}
