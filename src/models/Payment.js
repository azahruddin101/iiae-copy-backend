const mongoose = require('mongoose');

const paymentSchema = mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    receiptNumber: {
      type: String,
      required: true,
      unique: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    date: {
      type: Date,
      default: Date.now,
    },
    mode: {
      type: String,
      required: true,
      enum: ['cash', 'online', 'bank_transfer'],
      default: 'cash',
    },
    remarks: {
      type: String,
      default: '',
    },
    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User', // Accountant who recorded this payment
      required: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

const Payment = mongoose.model('Payment', paymentSchema);

module.exports = Payment;
