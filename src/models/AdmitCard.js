const mongoose = require('mongoose');

const admitCardSchema = mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    rollNumber: {
      type: String,
      required: true,
      unique: true,
    },
    examDate: {
      type: Date,
      required: true,
    },
    examTime: {
      type: String, // e.g. "10:00 AM - 1:00 PM"
      required: true,
    },
    examCenter: {
      type: String,
      default: 'Innovbit Campus',
    },
    instructions: {
      type: String,
      default: '1. Please bring a printed copy of this admit card.\n2. Carry a valid photo ID card.\n3. Report to the center 30 minutes before the scheduled exam time.',
    },
    generatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
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

const AdmitCard = mongoose.model('AdmitCard', admitCardSchema);

module.exports = AdmitCard;
