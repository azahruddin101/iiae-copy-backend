const mongoose = require('mongoose');

const academicRecordSchema = mongoose.Schema(
  {
    board: { type: String, default: '' },
    passingYear: { type: String, default: '' },
    school: { type: String, default: '' },
    stream: { type: String, default: '' },
    percentage: { type: Number, default: 0 },
  },
  { _id: false }
);

const documentSchema = mongoose.Schema(
  {
    name: { type: String, required: true }, // e.g. "10th Marksheet", "Aadhar Card"
    url: { type: String, required: true },
  },
  { _id: false }
);

const studentProfileSchema = mongoose.Schema(
  {
    studentId: {
      type: String, // e.g. "Innovbit/2026/001"
      unique: true,
      sparse: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    fatherName: {
      type: String,
      default: '',
    },
    motherName: {
      type: String,
      default: '',
    },
    dob: {
      type: Date,
    },
    gender: {
      type: String,
      enum: ['', 'Male', 'Female', 'Other'],
      default: '',
    },
    address: {
      type: String,
      default: '',
    },
    category: {
      type: String,
      default: '',
    },
    parentMobile: {
      type: String,
      default: '',
    },
    parentEmail: {
      type: String,
      default: '',
    },
    city: {
      type: String,
      default: '',
    },
    state: {
      type: String,
      default: '',
    },
    country: {
      type: String,
      default: '',
    },
    pin: {
      type: String,
      default: '',
    },
    qualification: {
      type: String,
      default: '',
    },
    academics: {
      classX: { type: academicRecordSchema, default: () => ({}) },
      classXII: { type: academicRecordSchema, default: () => ({}) },
      diploma: { type: academicRecordSchema, default: () => ({}) },
      iti: { type: academicRecordSchema, default: () => ({}) },
      graduation: { type: academicRecordSchema, default: () => ({}) },
      postGraduation: { type: academicRecordSchema, default: () => ({}) },
    },
    classXBoard: {
      type: String,
      default: '',
    },
    classXPassingYear: {
      type: String,
      default: '',
    },
    classXSchool: {
      type: String,
      default: '',
    },
    examCentreFirst: {
      type: String,
      default: '',
    },
    examCentreSecond: {
      type: String,
      default: '',
    },
    photoUrl: {
      type: String,
      default: '',
    },
    extraAnswers: {
      type: [
        {
          fieldId: { type: String, default: '' },
          label: { type: String, default: '' },
          value: { type: String, default: '' },
        },
      ],
      default: [],
    },
    registrationFeeAmount: {
      type: Number,
      default: 0,
    },
    course: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course',
    },
    batch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Batch',
    },
    entranceStatus: {
      type: String,
      required: true,
      enum: ['pending', 'admit_card_generated', 'appeared', 'passed', 'failed'],
      default: 'pending',
    },
    entranceScore: {
      type: Number,
      default: 0,
    },
    registrationFeePaid: {
      type: Boolean,
      default: false,
    },
    // Set when the registration form is submitted. Paid and unpaid lists only include these.
    formSubmittedAt: {
      type: Date,
    },
    registeredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    lead: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lead',
    },
    feeDetails: {
      totalFee: {
        type: Number,
        default: 0,
      },
      scholarshipAmount: {
        type: Number,
        default: 0,
      },
      discountRemarks: {
        type: String,
        default: '',
      },
      netFee: {
        type: Number,
        default: 0, // netFee = totalFee - scholarshipAmount
      },
      paidFee: {
        type: Number,
        default: 0,
      },
    },
    academicDetails: {
      tenthPercentage: { type: Number, default: 0 },
      twelfthPercentage: { type: Number, default: 0 },
    },
    documents: [documentSchema],
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Pre-save hook to calculate netFee. Mongoose 9 does not pass next into middleware.
studentProfileSchema.pre('save', function () {
  if (this.feeDetails) {
    const total = this.feeDetails.totalFee || 0;
    const scholarship = this.feeDetails.scholarshipAmount || 0;
    this.feeDetails.netFee = Math.max(0, total - scholarship);
  }
});

studentProfileSchema.index({ registeredBy: 1, registrationFeePaid: 1 });

const StudentProfile = mongoose.model('StudentProfile', studentProfileSchema);

module.exports = StudentProfile;
