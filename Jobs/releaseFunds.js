const Order = require('../models/Order');
const Wallet = require('../models/Wallet');

/**
 * Release funds to seller wallets when return policy period ends
 * This should be run as a cron job every day (e.g., at midnight)
 * 
 * Setup: node-cron or similar
 * Example: cron.schedule('0 0 * * *', releaseFundsJob);
 */

async function releaseFundsJob() {
  console.log('🔄 Running funds release job...');

  try {
    // Find all delivered orders where:
    // 1. Funds not yet released
    // 2. Return policy has ended (returnPolicyEndDate < now)
    // 3. Order not cancelled/refunded

    const now = new Date();

    const ordersToRelease = await Order.find({
      status: 'delivered',
      fundsReleased: false,
      returnPolicyEndDate: { $lt: now },
      paymentStatus: { $in: ['paid', 'pending'] }
    });

    console.log(`📦 Found ${ordersToRelease.length} orders to release funds for`);

    for (const order of ordersToRelease) {
      try {
        // Get or create seller wallet
        const wallet = await Wallet.getOrCreate(order.seller);

        // Credit seller earnings (90%)
        const sellerEarnings = order.sellerEarnings || (order.subtotal * 0.9);

        await wallet.addTransaction('credit', sellerEarnings, 
          `Earnings for order ${order.orderNumber} (Return period ended)`, 
          { order: order._id }
        );

        // Mark order as funds released
        order.fundsReleased = true;
        order.fundsReleasedAt = new Date();
        await order.save();

        console.log(`✅ Released Rs.${sellerEarnings} to seller ${order.seller} for order ${order.orderNumber}`);

      } catch (err) {
        console.error(`❌ Failed to release funds for order ${order.orderNumber}:`, err.message);
      }
    }

    console.log('✅ Funds release job completed');

  } catch (error) {
    console.error('❌ Funds release job failed:', error.message);
  }
}

// Manual run function
async function runManualRelease() {
  await releaseFundsJob();
  process.exit(0);
}

module.exports = { releaseFundsJob, runManualRelease };

// If run directly from command line
if (require.main === module) {
  // Connect to DB first
  const mongoose = require('mongoose');
  mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/shopp123')
    .then(() => {
      console.log('✅ DB Connected');
      return runManualRelease();
    })
    .catch(err => {
      console.error('❌ DB Error:', err);
      process.exit(1);
    });
}
