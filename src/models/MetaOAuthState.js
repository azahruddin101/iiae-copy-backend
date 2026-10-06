const mongoose = require('mongoose');

// Single-use OAuth state issued when a user starts the Meta connect flow (CSRF protection)
const metaOAuthStateSchema = mongoose.Schema(
  {
    // SHA-256 of the state value sent to Meta
    stateHash: {
      type: String,
      required: true,
      unique: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Expired states are removed automatically by MongoDB
metaOAuthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const MetaOAuthState = mongoose.model('MetaOAuthState', metaOAuthStateSchema);

module.exports = MetaOAuthState;
