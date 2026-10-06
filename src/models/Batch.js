const mongoose = require('mongoose');

const batchSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
    },
    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
      required: true,
    },
    teacher: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User', // Needs to be role: 'teacher'
      required: true,
    },
    students: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User', // Needs to be role: 'student'
      },
    ],
    schedule: {
      type: String, // e.g. "Monday - Friday, 9 AM - 2 PM"
      default: '',
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

const Batch = mongoose.model('Batch', batchSchema);

module.exports = Batch;
