import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uri = process.env.MONGO_URI;
const dbName = 'coresight-bot'; // The database Cora monitors

if (!uri) {
  console.error('❌ MONGO_URI not found in .env');
  process.exit(1);
}

async function simulateAlpha() {
  const client = new MongoClient(uri);

  try {
    await client.connect();
    console.log('✅ Connected to MongoDB');

    const db = client.db(dbName);
    const collection = db.collection('alpha_tokens');

    // Parse the CHIMP data into the expected format
    const mockToken = {
      symbol: 'CHIMP',
      name: 'chimping out',
      mint: '4XTaitDjvAAvHM1F8ZiiiWq3mCDdvQ7RfbKQ1wdVpump',
      marketCap: 142590.578,
      liquidity: 30080.86,
      holders: 946,
      lpBurn: 100,
      devPercentage: 0.0,
      sniperPercentage: 0.3,
      top10: 19.3,
      market: 'pumpfun-amm',
      createdAt: new Date(), // This triggers the sniper
      isSimulated: true
    };

    console.log(`🚀 [SIMULATOR] Broadcasting Mock Alpha: $${mockToken.symbol}...`);
    
    const result = await collection.insertOne(mockToken);
    
    console.log('✅ [SUCCESS] Token inserted into alpha_tokens.');
    console.log(`📡 Cora (on Koyeb) should detect this event and execute for active users.`);
    console.log(`Token ID: ${result.insertedId}`);

  } catch (error) {
    console.error('❌ [ERROR] Simulation failed:', error.message);
  } finally {
    await client.close();
  }
}

simulateAlpha();
