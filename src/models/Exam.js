const mongoose = require('mongoose');

const examResultSchema = mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    marksObtained: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ['pending', 'passed', 'failed'],
      default: 'pending',
    },
    remarks: {
      type: String,
      default: '',
    },
  },
  { _id: false }
);

const examSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      required: true,
      enum: ['entrance', 'midterm', 'final'],
      default: 'entrance',
    },
    maxMarks: {
      type: Number,
      required: true,
      default: 100,
    },
    date: {
      type: Date,
      required: true,
    },
    results: [examResultSchema],
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

const Exam = mongoose.model('Exam', examSchema);

module.exports = Exam;
