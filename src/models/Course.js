const mongoose = require('mongoose');

const courseSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
    },
    code: {
      type: String,
      required: true,
      unique: true,
    },
    duration: {
      type: String, // e.g. "3 Years", "2 Years"
      required: true,
    },
    baseFees: {
      type: Number,
      required: true,
    },
    description: {
      type: String,
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

const Course = mongoose.model('Course', courseSchema);

module.exports = Course;
