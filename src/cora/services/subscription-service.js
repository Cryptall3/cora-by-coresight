import { connectToDatabase } from '../db.js';

export class SubscriptionService {
  constructor() {
    this.collectionName = 'subscriptions';
  }

  async checkAccess(userId) {
    try {
      // 0. Bypass for Admin
      const adminId = process.env.ADMIN_ID;
      if (adminId && userId.toString() === adminId.toString()) {
        console.log(`👑 [SUBSCRIPTION] Admin bypass for user ${userId}`);
        return { hasAccess: true, plan: 'admin' };
      }

      const db = await connectToDatabase();
      const collection = db.collection(this.collectionName);

      const now = new Date();
      
      // Look for an active premium subscription
      const subscription = await collection.findOne({
        userId: parseInt(userId),
        planType: 'premium',
        status: 'active',
        expiresAt: { $gt: now }
      });

      if (subscription) {
        return { hasAccess: true, plan: 'premium' };
      }

      // Check for basic if premium is not found
      const basicSub = await collection.findOne({
        userId: parseInt(userId),
        planType: 'basic',
        status: 'active',
        expiresAt: { $gt: now }
      });

      if (basicSub) {
        return { hasAccess: true, plan: 'basic' };
      }

      return { hasAccess: false, plan: null };
    } catch (error) {
      console.error('❌ [SUBSCRIPTION] Error checking access:', error);
      return { hasAccess: false, plan: null, error: true };
    }
  }
}
