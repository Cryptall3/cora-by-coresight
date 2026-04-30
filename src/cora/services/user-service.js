import { connectToDatabase } from '../db.js';
import * as keystore from '../../../cli/utils/wallet/keystore.js';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

export class UserService {
  constructor() {
    this.collectionName = 'user_profiles';
    this.dbName = process.env.CORA_DB_NAME || 'cora';
  }

  /**
   * Initialize a new user profile and generate a trading wallet.
   */
  async createUserProfile(userId) {
    try {
      const db = await connectToDatabase();
      const collection = db.collection(this.collectionName);

      // 1. Check if user already exists in Cora DB
      const existingUser = await collection.findOne({ userId });
      if (existingUser) return existingUser;

      // 2. Generate a secure passphrase for the Zerion wallet
      // We use the Telegram userId + a server secret to ensure it's unique and reproducible if needed
      const serverSecret = process.env.ZERION_API_KEY || 'default_secret'; // Fallback for dev
      const walletName = `cora-${userId}`;
      const passphrase = crypto.createHmac('sha256', serverSecret).update(userId.toString()).digest('hex');

      // 3. Create the Zerion wallet (EVM + Solana)
      const wallet = keystore.createWallet(walletName, passphrase);

      // 4. Create an Agent Token for this wallet (allows Cora to sign without prompting)
      // Default expiry is 1 year from now
      const expiresAt = new Date();
      expiresAt.setFullYear(expiresAt.getFullYear() + 1);
      
      const agentToken = keystore.createAgentToken(
        `cora-token-${userId}`, 
        walletName, 
        passphrase, 
        Math.floor(expiresAt.getTime() / 1000).toString()
      );

      // 5. Store the profile in the 'cora' database
      const profile = {
        userId,
        walletName,
        evmAddress: wallet.evmAddress,
        solAddress: wallet.solAddress,
        agentToken: agentToken.token,
        agentTokenId: agentToken.id,
        settings: {
          snipeEnabled: false,
          copytradeEnabled: false,
          defaultBuyAmount: 0.1, // Default in native asset (SOL/ETH)
          tpPercent: 100,       // +100%
          slPercent: 50,        // -50%
          slippage: 1.0         // 1%
        },
        followList: [],
        createdAt: new Date()
      };

      await collection.insertOne(profile);
      console.log(`✅ [USER SERVICE] Created profile for user ${userId} with wallet ${wallet.solAddress}`);
      
      return profile;
    } catch (error) {
      console.error(`❌ [USER SERVICE] Error creating profile for user ${userId}:`, error);
      throw error;
    }
  }

  async getProfile(userId) {
    const db = await connectToDatabase();
    return await db.collection(this.collectionName).findOne({ userId });
  }

  /**
   * Export the Solana private key for a user.
   */
  async exportPrivateKey(userId) {
    try {
      const profile = await this.getProfile(userId);
      if (!profile) throw new Error('User profile not found');

      const serverSecret = process.env.ZERION_API_KEY || 'default_secret';
      const passphrase = crypto.createHmac('sha256', serverSecret).update(userId.toString()).digest('hex');

      // Export from Zerion keystore
      const exported = keystore.exportWallet(profile.walletName, passphrase);
      
      // The exported object contains mnemonic and private keys
      // We only care about Solana for now
      const solKey = exported.privateKeys.find(k => k.network === 'solana');
      
      return solKey ? solKey.key : null;
    } catch (error) {
      console.error(`❌ [USER SERVICE] Error exporting key for ${userId}:`, error);
      throw error;
    }
  }

  async updateSettings(userId, settings) {
    const db = await connectToDatabase();
    return await db.collection(this.collectionName).updateOne(
      { userId },
      { $set: { 'settings': { ...settings } } }
    );
  }
}
