import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const uri = process.env.MONGO_URI;
const dbName = process.env.CORA_DB_NAME || 'cora-bot';

let client;
let db;

export async function connectToDatabase(name) {
  if (db && !name) return db;

  if (!uri) {
    throw new Error('MONGO_URI is not defined in environment variables');
  }

  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
  }

  const targetDb = client.db(name || dbName);
  if (!name) db = targetDb;
  
  console.log(`✅ [DB] Connected to ${name || dbName}`);
  return targetDb;
}

export async function closeConnection() {
  if (client) {
    await client.close();
    db = null;
    client = null;
  }
}
