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
      symbol: 'TEST_SNIPE',
      name: 'Test Token',
      mint: 'CipCfJTUvfuoJzRHRKbWGDDtdkLiUwaf5xb9iyzXpump',
      marketCap: 10000,
      liquidity: 1000,
      buy_amount: 0.018,
      holders: 100,
      lpBurn: 100,
      devPercentage: 0.0,
      sniperPercentage: 0.0,
      top10: 1.0,
      market: 'pumpfun',
      createdAt: new Date(),
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
