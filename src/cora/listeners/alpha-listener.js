import { EventEmitter } from 'events';
import { connectToDatabase } from '../db.js';

export class AlphaListener extends EventEmitter {
  constructor() {
    super();
    this.collectionName = 'alpha_alerts';
    this.isListening = false;
  }

  async start() {
    if (this.isListening) return;

    try {
      const db = await connectToDatabase();
      const collection = db.collection(this.collectionName);

      console.log(`📡 [ALPHA LISTENER] Starting MongoDB Change Stream on ${this.collectionName}...`);

      // Watch for new insertions in the alpha_alerts collection
      const changeStream = collection.watch([
        { $match: { operationType: 'insert' } }
      ]);

      this.isListening = true;

      changeStream.on('change', (change) => {
        const alert = change.fullDocument;
        console.log(`🚀 [ALPHA LISTENER] New Alert Detected: ${alert.tokenId}`);
        
        // Emit the 'alert' event with the alert data
        this.emit('alert', alert);
      });

      changeStream.on('error', (error) => {
        console.error('❌ [ALPHA LISTENER] Change Stream Error:', error);
        this.isListening = false;
        // Attempt to restart after a delay
        setTimeout(() => this.start(), 5000);
      });

    } catch (error) {
      console.error('❌ [ALPHA LISTENER] Failed to start listener:', error);
      setTimeout(() => this.start(), 5000);
    }
  }
}
