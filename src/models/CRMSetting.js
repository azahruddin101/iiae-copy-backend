const mongoose = require('mongoose');
const { DEFAULT_EXAM_CENTRES } = require('../utils/registrationWindow');

const customQuestionSchema = mongoose.Schema(
  {
    id: { type: String, required: true },
    label: { type: String, required: true },
    type: {
      type: String,
      enum: ['text', 'textarea', 'number', 'yesno', 'select', 'file'],
      default: 'text',
    },
    options: { type: [String], default: [] },
    required: { type: Boolean, default: false },
    step: { type: Number, enum: [1, 2], default: 1 },
  },
  { _id: false }
);

const registrationFormSchema = mongoose.Schema(
  {
    enabled: {
      type: Boolean,
      default: false,
    },
    liveFrom: {
      type: Date,
      default: null,
    },
    disableAt: {
      type: Date,
      default: null,
    },
    registrationFee: {
      type: Number,
      default: 0,
    },
    examCentres: {
      type: [String],
      default: () => [...DEFAULT_EXAM_CENTRES],
    },
    fields: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({}),
    },
    customFields: {
      type: [customQuestionSchema],
      default: [],
    },
  },
  { _id: false }
);

const crmSettingSchema = mongoose.Schema(
  {
    admitCardEnabled: {
      type: Boolean,
      default: false,
    },
    resultEnabled: {
      type: Boolean,
      default: false,
    },
    counsellingLetterEnabled: {
      type: Boolean,
      default: false,
    },
    registrationForm: {
      type: registrationFormSchema,
      default: () => ({}),
    },
  },
  {
    timestamps: true,
  }
);

const CRMSetting = mongoose.model('CRMSetting', crmSettingSchema);

module.exports = CRMSetting;
