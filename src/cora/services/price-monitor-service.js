import { connectToDatabase } from '../db.js';
import fetch from 'node-fetch';

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
        // 1. Find all unique mints currently in "open" trades
        const activeTrades = await this.db.collection('trades').find({ status: 'open' }).toArray();
        const uniqueMints = [...new Set(activeTrades.map(t => t.mint))];

        if (uniqueMints.length === 0) {
          await new Promise(resolve => setTimeout(resolve, this.interval));
          continue;
        }

        // 2. Fetch prices in bulk (or iterate if API is single-token)
        // Solana Tracker Price API: We iterate for now, but use a high-speed endpoint
        for (const mint of uniqueMints) {
          const priceRes = await fetch(`https://api.solanatracker.io/price?tokenAddress=${mint}`).catch(() => null);
          const priceData = priceRes ? await priceRes.json() : null;

          if (priceData && priceData.price) {
            // 3. Update Global Price Table
            await this.db.collection('token_prices').updateOne(
              { mint },
              { 
                $set: { 
                  price: priceData.price,
                  updatedAt: new Date()
                } 
              },
              { upsert: true }
            );
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
