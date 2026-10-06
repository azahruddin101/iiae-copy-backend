const crypto = require('crypto');

// Registration opens only while the admin has turned it on and the current time
// sits inside the optional live and disable dates. Dates are stored in UTC and
// edited as India time (IST, UTC+5:30).

const IST_OFFSET_MS = 330 * 60 * 1000;

const DEFAULT_EXAM_CENTRES = Object.freeze([
  'Delhi',
  'Lucknow',
  'Mumbai',
  'Kolkata',
  'Chennai',
  'Hyderabad',
  'Bengaluru',
  'Jaipur',
  'Patna',
  'Chandigarh',
]);

const CATEGORIES = Object.freeze(['General', 'OBC', 'SC', 'ST', 'EWS']);
const QUALIFICATIONS = Object.freeze(['10th', '12th', 'Diploma', 'ITI', 'Graduate', 'Post Graduate']);
const GENDERS = Object.freeze(['Male', 'Female', 'Other']);

// Each qualification asks for the records a student would actually have at that level.
const EDUCATION_BY_QUALIFICATION = Object.freeze({
  '10th': Object.freeze(['classX']),
  '12th': Object.freeze(['classX', 'classXII']),
  Diploma: Object.freeze(['classX', 'diploma']),
  ITI: Object.freeze(['classX', 'iti']),
  Graduate: Object.freeze(['classX', 'classXII', 'graduation']),
  'Post Graduate': Object.freeze(['classX', 'classXII', 'graduation', 'postGraduation']),
});

const educationLevelsFor = (qualification) => EDUCATION_BY_QUALIFICATION[qualification] || [];

// Name, mobile and email stay on. They are how the student account is created.
const BUILTIN_FIELDS = Object.freeze([
  { key: 'firstName', label: 'First name', group: 'Personal details', locked: true, required: true },
  { key: 'lastName', label: 'Last name', group: 'Personal details', locked: true, required: true },
  { key: 'gender', label: 'Gender', group: 'Personal details', required: true },
  { key: 'dob', label: 'Date of birth', group: 'Personal details', required: true },
  { key: 'category', label: 'Category', group: 'Personal details', required: true },
  { key: 'fatherName', label: "Father's name", group: 'Personal details', required: true },
  { key: 'motherName', label: "Mother's name", group: 'Personal details', required: true },
  { key: 'mobile', label: 'Mobile', group: 'Personal details', locked: true, required: true },
  { key: 'parentMobile', label: "Parent's mobile", group: 'Personal details', required: true },
  { key: 'email', label: 'Student email', group: 'Personal details', locked: true, required: true },
  { key: 'parentEmail', label: "Parent's email", group: 'Personal details', required: false },
  { key: 'address', label: 'Address', group: 'Personal details', required: true },
  { key: 'city', label: 'City', group: 'Personal details', required: true },
  { key: 'state', label: 'State', group: 'Personal details', required: true },
  { key: 'country', label: 'Country', group: 'Personal details', required: true },
  { key: 'pin', label: 'Pin', group: 'Personal details', required: true },
  { key: 'course', label: 'Course', group: 'Education', required: true },
  { key: 'qualification', label: 'Qualification and education details', group: 'Education', required: true },
  { key: 'examCentres', label: 'Exam centres', group: 'Education', required: true },
  { key: 'photo', label: 'Photograph', group: 'Photo', required: true },
]);

const CUSTOM_FIELD_TYPES = Object.freeze(['text', 'textarea', 'number', 'yesno', 'select', 'file']);

const plainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  if (typeof value.toObject === 'function') return value.toObject();
  return value;
};

const resolveFormFields = (saved) => {
  const stored = plainObject(saved);
  return BUILTIN_FIELDS.map((field) => {
    const choice = stored[field.key] && typeof stored[field.key] === 'object' ? stored[field.key] : {};
    const enabled = field.locked ? true : choice.enabled !== false;
    const required = field.locked
      ? true
      : (choice.required === undefined ? Boolean(field.required) : Boolean(choice.required));
    return {
      key: field.key,
      label: field.label,
      group: field.group,
      locked: Boolean(field.locked),
      enabled,
      required: enabled && required,
    };
  });
};

const fieldChoice = (fields, key) => fields.find((field) => field.key === key) || { enabled: false, required: false };

const normalizeFieldChoices = (input) => {
  const source = plainObject(input);
  const saved = {};
  BUILTIN_FIELDS.forEach((field) => {
    if (field.locked) return;
    const choice = source[field.key];
    if (!choice || typeof choice !== 'object') return;
    const enabled = choice.enabled !== false;
    saved[field.key] = {
      enabled,
      required: enabled && Boolean(choice.required),
    };
  });
  return saved;
};

const cryptoRandomId = () => crypto.randomBytes(8).toString('hex');

const sanitizeCustomFields = (input) => {
  if (!Array.isArray(input)) return { error: 'Extra questions must be a list' };
  if (input.length > 15) return { error: 'You can add up to 15 extra questions' };

  const fields = [];
  const seen = new Set();
  for (const item of input) {
    const label = String(item?.label || '').trim().replace(/\s+/g, ' ');
    if (!label) return { error: 'Every extra question needs a label' };
    if (label.length > 80) return { error: 'Question labels must be 80 characters or less' };

    const type = String(item?.type || 'text');
    if (!CUSTOM_FIELD_TYPES.includes(type)) return { error: 'Choose a valid question type' };

    const step = Number(item?.step) === 2 ? 2 : 1;
    let id = String(item?.id || '').trim();
    if (!/^[a-zA-Z0-9-]{8,40}$/.test(id)) {
      id = cryptoRandomId();
    }
    if (seen.has(id)) return { error: 'Each extra question must be unique' };
    seen.add(id);

    let options = [];
    if (type === 'select') {
      const raw = Array.isArray(item?.options) ? item.options : String(item?.options || '').split(/\r?\n/);
      options = [...new Set(raw.map((option) => String(option).trim()).filter(Boolean))];
      if (options.length < 2) return { error: `"${label}" needs at least two dropdown choices` };
      if (options.length > 12) return { error: `"${label}" can have up to 12 dropdown choices` };
      if (options.some((option) => option.length > 60)) {
        return { error: 'Dropdown choices must be 60 characters or less' };
      }
    }

    fields.push({
      id,
      label,
      type,
      options,
      required: Boolean(item?.required),
      step,
    });
  }

  return { fields };
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const asDate = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const pad = (value) => String(value).padStart(2, '0');

const formatWhen = (date) => {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  let hours = ist.getUTCHours();
  const suffix = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12 || 12;
  return `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}, ${hours}:${pad(ist.getUTCMinutes())} ${suffix}`;
};

const toIndiaDateTimeLocal = (value) => {
  const date = asDate(value);
  if (!date) return '';
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}T${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}`;
};

// Accepts a datetime-local value such as 2026-10-10T09:00 and treats it as IST.
const parseIndiaDateTime = (value) => {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;

  const utc = Date.UTC(year, month - 1, day, hour, minute) - IST_OFFSET_MS;
  const date = new Date(utc);
  if (toIndiaDateTimeLocal(date) !== text) return null;
  return date;
};

const describeRegistrationWindow = (form = {}, now = new Date()) => {
  const enabled = Boolean(form.enabled);
  const liveFrom = asDate(form.liveFrom);
  const disableAt = asDate(form.disableAt);

  if (!enabled) {
    return {
      open: false,
      phase: 'disabled',
      message: 'Registration is turned off.',
    };
  }

  if (liveFrom && now < liveFrom) {
    return {
      open: false,
      phase: 'scheduled',
      message: `Registration opens on ${formatWhen(liveFrom)}.`,
    };
  }

  if (disableAt && now >= disableAt) {
    return {
      open: false,
      phase: 'closed',
      message: `Registration closed on ${formatWhen(disableAt)}.`,
    };
  }

  return {
    open: true,
    phase: 'live',
    message: disableAt
      ? `The registration form is live until ${formatWhen(disableAt)}.`
      : 'The registration form is live.',
  };
};

module.exports = {
  IST_OFFSET_MS,
  DEFAULT_EXAM_CENTRES,
  CATEGORIES,
  QUALIFICATIONS,
  GENDERS,
  EDUCATION_BY_QUALIFICATION,
  educationLevelsFor,
  BUILTIN_FIELDS,
  CUSTOM_FIELD_TYPES,
  resolveFormFields,
  fieldChoice,
  normalizeFieldChoices,
  sanitizeCustomFields,
  describeRegistrationWindow,
  parseIndiaDateTime,
  toIndiaDateTimeLocal,
  formatWhen,
};
