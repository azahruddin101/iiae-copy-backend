const mongoose = require('mongoose');
const dns = require('dns');

// Use reliable Google/Cloudflare DNS servers to prevent querySrv ECONNREFUSED on local ISPs
try {
  dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
} catch (e) {
  // Ignore if setting DNS fails
}

const connectDB = async () => {
  const connectWithRetry = async () => {
    try {
      const conn = await mongoose.connect(process.env.MONGO_URI);
      console.log(`MongoDB Connected: ${conn.connection.host}`);

      // Existing accounts created under the old role name keep working.
      try {
        const User = require('../models/User');
        const Announcement = require('../models/Announcement');
        const renamed = await User.updateMany({ role: 'telecaller' }, { $set: { role: 'counsellor' } });
        if (renamed.modifiedCount) {
          console.log(`Renamed ${renamed.modifiedCount} telecaller account(s) to counsellor`);
        }
        await Announcement.updateMany(
          { targetRoles: 'telecaller' },
          { $set: { 'targetRoles.$[role]': 'counsellor' } },
          { arrayFilters: [{ role: 'telecaller' }] }
        );
      } catch (migrationError) {
        console.error('Error renaming telecaller role:', migrationError.message);
      }

      // Auto-seed default admin if no admin exists
      try {
        const User = require('../models/User');
        const adminExists = await User.findOne({ role: 'admin' });
        if (!adminExists) {
          console.log('No admin user found. Auto-seeding default admin...');
          await User.create({
            name: 'Innovbit Admin',
            email: process.env.ADMIN_EMAIL || 'admin@innovbit.in',
            phone: '9999999999',
            password: process.env.ADMIN_PASSWORD || 'admin123',
            role: 'admin',
            status: 'active'
          });
          console.log('Default admin user auto-seeded successfully!');
        }
      } catch (seedError) {
        console.error('Error during auto-seeding admin:', seedError.message);
      }
    } catch (error) {
      console.error(`MongoDB Connection Error: ${error.message}`);
      console.log('Retrying MongoDB connection in 10 seconds...');
      setTimeout(connectWithRetry, 10000);
    }
  };

  await connectWithRetry();
};

module.exports = connectDB;
