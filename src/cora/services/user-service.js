import { connectToDatabase } from '../db.js';
import * as keystore from '../../../cli/utils/wallet/keystore.js';
import crypto from 'crypto';
import { 
  Connection, 
  PublicKey, 
  SystemProgram, 
  Transaction,
  LAMPORTS_PER_SOL
} from "@solana/web3.js";
import dotenv from 'dotenv';

dotenv.config();
const ALGORITHM = 'aes-256-cbc';

function encrypt(text, secret) {
  const iv = crypto.randomBytes(16);
  const key = crypto.createHash('sha256').update(secret).digest();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text, secret) {
  const [ivHex, encryptedHex] = text.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const key = crypto.createHash('sha256').update(secret).digest();
  const encryptedText = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

export class UserService {
  constructor() {
    this.collectionName = 'user_profiles';
    this.dbName = process.env.CORA_DB_NAME || 'cora';
  }

  /**
   * Initialize or fetch the user's profile.
   */
  async createUserProfile(userId) {
    try {
      const db = await connectToDatabase();
      const collection = db.collection(this.collectionName);

      const existingUser = await collection.findOne({ userId });
      
      // If user exists and has at least one wallet locally, we're good
      if (existingUser && existingUser.wallets && existingUser.wallets.length > 0) {
        let allLocal = true;
        for (const w of existingUser.wallets) {
          try { keystore.getWallet(w.walletName); } catch(e) { allLocal = false; break; }
        }
        if (allLocal) return existingUser;
      }

      // If we need to restore or create the first wallet
      if (!existingUser || !existingUser.wallets || existingUser.wallets.length === 0) {
        return await this.addWallet(userId, 'Main Wallet');
      }

      // Restore missing wallets from encrypted backups
      const serverSecret = process.env.ZERION_API_KEY || 'default_secret';
      for (const w of existingUser.wallets) {
        try {
          keystore.getWallet(w.walletName);
        } catch (e) {
          console.log(`📡 [USER SERVICE] Restoring wallet ${w.name} for ${userId}...`);
          const mnemonic = decrypt(w.encryptedMnemonic, serverSecret);
          const passphrase = crypto.createHmac('sha256', serverSecret).update(userId.toString() + w.id).digest('hex');
          keystore.importFromMnemonic(w.walletName, mnemonic, passphrase);
        }
      }

      return await collection.findOne({ userId });
    } catch (error) {
      console.error(`❌ [USER SERVICE] Error in profile initialization for ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Add a new wallet to the user's profile.
   */
  async addWallet(userId, nickname = 'New Wallet') {
    const db = await connectToDatabase();
    const collection = db.collection(this.collectionName);
    const existingUser = await collection.findOne({ userId });

    const serverSecret = process.env.ZERION_API_KEY || 'default_secret';
    const walletId = crypto.randomBytes(4).toString('hex'); // Unique ID for this wallet in the list
    const walletName = `cora-${userId}-${walletId}`;
    const passphrase = crypto.createHmac('sha256', serverSecret).update(userId.toString() + walletId).digest('hex');

    // Generate
    const wallet = keystore.createWallet(walletName, passphrase);
    const mnemonic = keystore.exportWallet(walletName, passphrase);
    
    // Create Agent Token for this specific wallet
    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);
    const agentToken = keystore.createAgentToken(`cora-tk-${walletId}`, walletName, passphrase, Math.floor(expiresAt.getTime() / 1000).toString());

    const newWallet = {
      id: walletId,
      name: nickname,
      walletName,
      solAddress: wallet.solAddress,
      evmAddress: wallet.evmAddress,
      encryptedMnemonic: encrypt(mnemonic, serverSecret),
      agentToken: agentToken.token,
      createdAt: new Date()
    };

    if (existingUser) {
      await collection.updateOne(
        { userId },
        { $push: { wallets: newWallet } }
      );
    } else {
      await collection.insertOne({
        userId,
        wallets: [newWallet],
        settings: {
          snipeEnabled: false,
          copytradeEnabled: false,
          defaultBuyAmount: 0.1,
          tpPercent: 100,
          slPercent: 50,
          slippage: 1.0,
          autoExit: false
        },
        createdAt: new Date()
      });
    }

    return await collection.findOne({ userId });
  }

  async getProfile(userId) {
    const db = await connectToDatabase();
    return await db.collection(this.collectionName).findOne({ userId });
  }

  /**
   * Export the seed phrase for a specific wallet index.
   */
  async exportSeedPhrase(userId, walletId) {
    const profile = await this.getProfile(userId);
    const wallet = profile.wallets.find(w => w.id === walletId);
    if (!wallet) throw new Error('Wallet not found');

    const serverSecret = process.env.ZERION_API_KEY || 'default_secret';
    return decrypt(wallet.encryptedMnemonic, serverSecret);
  }

  async updateSettings(userId, settings) {
    const db = await connectToDatabase();
    await db.collection(this.collectionName).updateOne(
      { userId },
      { $set: { settings } }
    );
  }

  /**
   * Rename a wallet.
   */
  async renameWallet(userId, walletId, newName) {
    const db = await connectToDatabase();
    await db.collection(this.collectionName).updateOne(
      { userId, "wallets.id": walletId },
      { $set: { "wallets.$.name": newName } }
    );
  }

  /**
   * Delete a wallet from the profile and local keystore.
   */
  async deleteWallet(userId, walletId) {
    const profile = await this.getProfile(userId);
    const wallet = profile.wallets.find(w => w.id === walletId);
    if (!wallet) throw new Error('Wallet not found');

    // Remove from local keystore
    try { keystore.deleteWallet(wallet.walletName); } catch (e) {}

    // Remove from DB
    const db = await connectToDatabase();
    await db.collection(this.collectionName).updateOne(
      { userId },
      { $pull: { wallets: { id: walletId } } }
    );
  }

  /**
   * Send SOL from an agent wallet to an external address.
   */
  async sendSOL(userId, walletId, toAddress, amount) {
    const profile = await this.getProfile(userId);
    const wallet = profile.wallets.find(w => w.id === walletId);
    if (!wallet) throw new Error('Wallet not found');

    const serverSecret = process.env.ZERION_API_KEY || 'default_secret';
    const passphrase = crypto.createHmac('sha256', serverSecret).update(userId.toString() + walletId).digest('hex');

    // 1. Setup Connection
    const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
    const fromPubkey = new PublicKey(wallet.solAddress);
    const toPubkey = new PublicKey(toAddress);

    // 2. Build Transaction
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey,
        toPubkey,
        lamports: Math.floor(amount * LAMPORTS_PER_SOL),
      })
    );

    const { blockhash } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = fromPubkey;

    // 3. Serialize to hex for OWS to sign
    const txBuffer = transaction.serializeMessage();
    const txHex = txBuffer.toString('hex');

    // 4. Sign and Broadcast
    try {
      const signResult = keystore.signSolanaTransaction(wallet.walletName, txHex, passphrase);
      const signedTxBytes = Buffer.from(signResult.signature, "hex");
      
      const txHash = await connection.sendRawTransaction(signedTxBytes, {
        skipPreflight: false,
        commitment: "confirmed",
      });

      return txHash;
    } catch (error) {
      console.error(`❌ [USER SERVICE] Send SOL Error:`, error);
      throw error;
    }
  }
}
