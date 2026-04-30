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
      
      // Look for an active subscription matching the REAL schema
      const subscription = await collection.findOne({
        userId: parseInt(userId),
        active: true,
        endDate: { $gt: now }
      });

      if (subscription) {
        console.log(`✅ [SUBSCRIPTION] Access granted for user ${userId} (${subscription.planType})`);
        return { 
          hasAccess: true, 
          plan: subscription.planType 
        };
      }

      return { hasAccess: false, plan: null };
    } catch (error) {
      console.error('❌ [SUBSCRIPTION] Error checking access:', error);
      return { hasAccess: false, plan: null, error: true };
    }
  }
}
