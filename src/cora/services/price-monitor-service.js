import { connectToDatabase } from '../db.js';

export class PriceMonitorService {
  constructor() {
    this.isRunning = false;
    this.interval = 5000; // Global price sync every 5 seconds
    this.db = null;
  }

  async start() {
    if (this.isRunning) return;
    
    try {
      this.db = await connectToDatabase();
      this.isRunning = true;
      console.log('🔄 [PRICE-MONITOR] Global Sync Service started.');
      
      this.run();
    } catch (error) {
      console.error('❌ [PRICE-MONITOR] Start error:', error);
    }
  }

  async run() {
    while (this.isRunning) {
      try {
        const now = new Date();
        
        // 1. Find all unique mints currently in "open" trades
        const activeTrades = await this.db.collection('trades').find({ status: 'open' }).toArray();
        const uniqueMints = [...new Set(activeTrades.map(t => t.mint))];

        if (uniqueMints.length === 0) {
          await new Promise(resolve => setTimeout(resolve, this.interval));
          continue;
        }

        const mintsToPoll = [];
        for (const mint of uniqueMints) {
          const cached = await this.db.collection('token_prices').findOne({ mint });
          
          if (!cached) {
            mintsToPoll.push(mint);
            continue;
          }

          const lastChangedAt = cached.lastChangedAt || cached.updatedAt || new Date(0);
          const diffHours = (now - lastChangedAt) / (1000 * 60 * 60);

          if (diffHours > 24) continue; // Dead: Stop polling

          if (diffHours > 1) {
            // Stagnant: Poll every 5 minutes (every 60 cycles)
            const cycleCount = Math.floor(now.getTime() / this.interval);
            if (cycleCount % 60 !== 0) continue;
          }

          mintsToPoll.push(mint);
        }

        if (mintsToPoll.length > 0) {
          console.log(`📡 [PRICE-SYNC] Polling ${mintsToPoll.length}/${uniqueMints.length} active tokens...`);
          
          for (const mint of mintsToPoll) {
            const priceRes = await fetch(`https://api.solanatracker.io/price?tokenAddress=${mint}`).catch(() => null);
            const priceData = priceRes ? await priceRes.json() : null;

            if (priceData && priceData.price) {
              const cached = await this.db.collection('token_prices').findOne({ mint });
              const hasChanged = !cached || cached.price !== priceData.price;

              const update = {
                $set: { 
                  price: priceData.price,
                  updatedAt: new Date()
                } 
              };

              if (hasChanged) {
                update.$set.lastChangedAt = new Date();
                update.$set.lastPrice = cached?.price || 0;
              }

              await this.db.collection('token_prices').updateOne({ mint }, update, { upsert: true });
            }
          }
        }

      } catch (error) {
        console.error('⚠️ [PRICE-MONITOR] Sync loop error:', error.message);
      }
      
      await new Promise(resolve => setTimeout(resolve, this.interval));
    }
  }

  stop() {
    this.isRunning = false;
  }
}
