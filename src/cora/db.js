import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const uri = process.env.MONGO_URI;
const dbName = process.env.CORA_DB_NAME || 'cora-bot';

let client;
let db;

export async function connectToDatabase() {
  if (db) return db;

  if (!uri) {
    throw new Error('MONGO_URI is not defined in environment variables');
  }

  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);
  console.log(`✅ [DB] Connected to ${dbName}`);
  return db;
}

export async function closeConnection() {
  if (client) {
    await client.close();
    db = null;
    client = null;
  }
}
