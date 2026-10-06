const mongoose = require('mongoose');

const callLogSchema = mongoose.Schema(
  {
    remark: {
      type: String,
      required: true,
    },
    date: {
      type: Date,
      default: Date.now,
    },
    caller: {
      type: String, // Name of the telecaller/staff who made the call
      required: true,
    },
  },
  { _id: false }
);

const leadSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      default: '',
    },
    phone: {
      type: String,
      required: true,
    },
    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
    },
    status: {
      type: String,
      required: true,
      enum: ['interested', 'not_interested', 'callback', 'not_picked', 'not_eligible', 'registered'],
      default: 'interested',
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User', // Role: counsellor
    },
    // Who fills the registration form after the lead is marked registered.
    registrationBy: {
      type: String,
      enum: ['student', 'counsellor'],
    },
    // Counsellor (or admin/manager) who started this registration. Students they
    // register are the only student records that counsellor can see.
    registeredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    registrationToken: {
      type: String,
      unique: true,
      sparse: true,
    },
    formSubmittedAt: {
      type: Date,
    },
    studentUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    callLogs: [callLogSchema],
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

leadSchema.set('toJSON', {
  transform: (_doc, ret) => {
    if (ret.registrationToken && !ret.formSubmittedAt) {
      ret.registrationPath = `/register/${ret.registrationToken}`;
    }
    ret.formSubmitted = Boolean(ret.formSubmittedAt);
    delete ret.registrationToken;
    return ret;
  },
});

const Lead = mongoose.model('Lead', leadSchema);

module.exports = Lead;
