const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const Lead = require('../models/Lead');
const MetaLead = require('../models/MetaLead');
const MetaLeadStatus = require('../models/MetaLeadStatus');
const MetaLeadAssignment = require('../models/MetaLeadAssignment');
const User = require('../models/User');
const Course = require('../models/Course');
const StudentProfile = require('../models/StudentProfile');
const CRMSetting = require('../models/CRMSetting');
const { ROLES } = require('../utils/rbac');
const {
  DEFAULT_EXAM_CENTRES,
  CATEGORIES,
  QUALIFICATIONS,
  GENDERS,
  educationLevelsFor,
  describeRegistrationWindow,
  parseIndiaDateTime,
  toIndiaDateTimeLocal,
  resolveFormFields,
  fieldChoice,
  normalizeFieldChoices,
  sanitizeCustomFields,
} = require('../utils/registrationWindow');

const PHOTO_DIR = path.join(__dirname, '../../uploads/photos');
const DOC_DIR = path.join(__dirname, '../../uploads/documents');
const PHOTO_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const DOC_TYPES = {
  ...PHOTO_TYPES,
  'application/pdf': '.pdf',
};

const httpError = (statusCode, message, step) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.step = step;
  return error;
};

const removeFile = (file) => {
  if (!file?.path) return;
  fs.unlink(file.path, () => {});
};

fs.mkdirSync(PHOTO_DIR, { recursive: true });
fs.mkdirSync(DOC_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, file, callback) => {
      callback(null, file.fieldname === 'photo' ? PHOTO_DIR : DOC_DIR);
    },
    filename: (_req, file, callback) => {
      const types = file.fieldname === 'photo' ? PHOTO_TYPES : DOC_TYPES;
      const ext = types[file.mimetype] || '.bin';
      callback(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 16 },
  fileFilter: (_req, file, callback) => {
    if (file.fieldname === 'photo') {
      if (!PHOTO_TYPES[file.mimetype]) {
        callback(new Error('Photo must be a JPG, PNG, or WEBP image'));
        return;
      }
      callback(null, true);
      return;
    }
    if (!/^extraFile_[a-zA-Z0-9-]{8,40}$/.test(file.fieldname)) {
      callback(new Error('This file is not for a question on the form'));
      return;
    }
    if (!DOC_TYPES[file.mimetype]) {
      callback(new Error('Upload a PDF, JPG, PNG, or WEBP file'));
      return;
    }
    callback(null, true);
  },
});

const removeUploaded = (req) => {
  removeFile(req.file);
  (req.files || []).forEach(removeFile);
};

const uploadPhoto = (req, res, next) => {
  upload.any()(req, res, (error) => {
    if (error) {
      removeUploaded(req);
      const tooLarge = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
      const photoError = tooLarge ? error.field === 'photo' : String(error.message || '').startsWith('Photo');
      res.status(400).json({
        message: tooLarge
          ? (photoError ? 'Photo must be 2 MB or smaller' : 'Each file must be 5 MB or smaller')
          : (error.message || 'Could not upload the file'),
        step: photoError ? 3 : undefined,
      });
      return;
    }

    const photo = (req.files || []).find((item) => item.fieldname === 'photo');
    if (photo && photo.size > 2 * 1024 * 1024) {
      removeUploaded(req);
      res.status(400).json({ message: 'Photo must be 2 MB or smaller', step: 3 });
      return;
    }
    req.file = photo;
    next();
  });
};

const getSettings = async () => {
  let settings = await CRMSetting.findOne();
  if (!settings) settings = await CRMSetting.create({});

  const form = settings.registrationForm || {};
  if (!form.examCentres || form.examCentres.length === 0) {
    form.examCentres = [...DEFAULT_EXAM_CENTRES];
    settings.markModified('registrationForm');
    await settings.save();
  }
  return settings;
};

const windowPayload = (settings) => {
  const form = settings.registrationForm || {};
  const status = describeRegistrationWindow(form);
  return {
    open: status.open,
    phase: status.phase,
    message: status.message,
    enabled: Boolean(form.enabled),
    liveFrom: form.liveFrom || null,
    disableAt: form.disableAt || null,
    liveFromInput: toIndiaDateTimeLocal(form.liveFrom),
    disableAtInput: toIndiaDateTimeLocal(form.disableAt),
    registrationFee: Number(form.registrationFee) || 0,
    examCentres: form.examCentres?.length ? form.examCentres : [...DEFAULT_EXAM_CENTRES],
    fields: resolveFormFields(form.fields),
    customFields: Array.isArray(form.customFields) ? form.customFields : [],
    categories: CATEGORIES,
    qualifications: QUALIFICATIONS,
    genders: GENDERS,
    educationByQualification: Object.fromEntries(
      QUALIFICATIONS.map((qualification) => [qualification, educationLevelsFor(qualification)])
    ),
  };
};

const buildWindowResponse = async () => {
  const settings = await getSettings();
  const courses = await Course.find({ isDeleted: false }).select('name code').sort({ name: 1 }).lean();
  return { ...windowPayload(settings), courses };
};

const getRegistrationWindow = async (req, res) => {
  try {
    res.json(await buildWindowResponse());
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const readDateField = (value, label) => {
  if (value === '' || value === null || value === undefined) return null;
  const date = parseIndiaDateTime(value);
  if (!date) throw httpError(400, `Enter a valid date and time for when the form ${label}`);
  return date;
};

const updateRegistrationWindow = async (req, res) => {
  const body = req.body || {};

  try {
    const settings = await getSettings();
    const form = settings.registrationForm || {};
    const storedFields = form.fields && typeof form.fields === 'object' ? { ...form.fields } : {};
    const next = {
      enabled: Boolean(form.enabled),
      liveFrom: form.liveFrom || null,
      disableAt: form.disableAt || null,
      registrationFee: Number(form.registrationFee) || 0,
      examCentres: form.examCentres?.length ? [...form.examCentres] : [...DEFAULT_EXAM_CENTRES],
      fields: storedFields,
      customFields: Array.isArray(form.customFields)
        ? form.customFields.map((item) => ({
          id: item.id,
          label: item.label,
          type: item.type,
          options: [...(item.options || [])],
          required: Boolean(item.required),
          step: item.step,
        }))
        : [],
    };

    if (body.enabled !== undefined) next.enabled = Boolean(body.enabled);
    if (Object.prototype.hasOwnProperty.call(body, 'liveFrom')) {
      next.liveFrom = readDateField(body.liveFrom, 'goes live');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'disableAt')) {
      next.disableAt = readDateField(body.disableAt, 'is disabled');
    }
    if (next.liveFrom && next.disableAt && next.disableAt <= next.liveFrom) {
      throw httpError(400, 'The disable date must be after the live date');
    }

    if (body.registrationFee !== undefined && body.registrationFee !== '') {
      const fee = Number(body.registrationFee);
      if (!Number.isFinite(fee) || fee < 0 || fee > 10000000) {
        throw httpError(400, 'Enter a valid registration fee');
      }
      next.registrationFee = Math.round(fee * 100) / 100;
    }

    if (body.examCentres !== undefined) {
      const raw = Array.isArray(body.examCentres) ? body.examCentres : String(body.examCentres).split(/\r?\n/);
      const examCentres = [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))];
      if (examCentres.length < 2) throw httpError(400, 'Add at least two exam centres, one per line');
      if (examCentres.some((item) => item.length > 80)) {
        throw httpError(400, 'Exam centre names must be 80 characters or less');
      }
      next.examCentres = examCentres;
    }

    if (body.fields !== undefined) next.fields = normalizeFieldChoices(body.fields);
    if (body.customFields !== undefined) {
      const custom = sanitizeCustomFields(body.customFields);
      if (custom.error) throw httpError(400, custom.error);
      next.customFields = custom.fields;
    }

    settings.registrationForm = next;
    settings.markModified('registrationForm');
    await settings.save();

    const courses = await Course.find({ isDeleted: false }).select('name code').sort({ name: 1 }).lean();
    res.json({ ...windowPayload(settings), courses });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.message });
  }
};

const requireText = (value, label, step, max = 120) => {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) throw httpError(400, `${label} is required`, step);
  if (text.length > max) throw httpError(400, `${label} must be ${max} characters or less`, step);
  return text;
};

const requireBlock = (value, label, step, max) => {
  const text = String(value || '').trim();
  if (!text) throw httpError(400, `${label} is required`, step);
  if (text.length > max) throw httpError(400, `${label} must be ${max} characters or less`, step);
  return text;
};

const requireEmail = (value, label, step) => {
  const email = requireText(value, label, step, 160).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw httpError(400, `Enter a valid ${label.toLowerCase()}`, step);
  }
  return email;
};

const requireMobile = (value, label, step) => {
  const mobile = String(value || '').trim();
  if (!/^[0-9]{10}$/.test(mobile)) throw httpError(400, `${label} must be a 10 digit number`, step);
  return mobile;
};

const parseDateOnly = (value) => {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
};

const ageInYears = (dob, now) => {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
};

const LEVEL_FIELDS = {
  classX: { name: 'Class X', board: 'board', school: 'school name and address', stream: '' },
  classXII: { name: 'Class XII', board: 'board', school: 'school name and address', stream: 'stream' },
  diploma: { name: 'Diploma', board: 'institute', school: 'institute address', stream: 'specialization' },
  iti: { name: 'ITI', board: 'institute', school: 'institute address', stream: 'trade' },
  graduation: { name: 'Graduation', board: 'university', school: 'college', stream: 'degree' },
  postGraduation: { name: 'Post graduation', board: 'university', school: 'college', stream: 'degree' },
};

const emptyAcademicRecord = () => ({
  board: '',
  passingYear: '',
  school: '',
  stream: '',
  percentage: 0,
});

const parseAcademics = (value) => {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    throw httpError(400, 'Enter the education details', 2);
  }
};

const readAcademicRecord = (key, raw) => {
  const spec = LEVEL_FIELDS[key];
  const record = raw?.[key] || {};
  const year = Number(record.passingYear);
  const currentYear = new Date().getFullYear();
  if (!Number.isInteger(year) || year < 1970 || year > currentYear) {
    throw httpError(400, `Select a valid ${spec.name} passing year`, 2);
  }

  let percentage = 0;
  if (String(record.percentage ?? '').trim()) {
    percentage = Number(record.percentage);
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      throw httpError(400, `${spec.name} percentage must be between 0 and 100`, 2);
    }
  }

  return {
    board: requireText(record.board, `${spec.name} ${spec.board}`, 2),
    passingYear: String(year),
    school: requireBlock(record.school, `${spec.name} ${spec.school}`, 2, 400),
    stream: spec.stream ? requireText(record.stream, `${spec.name} ${spec.stream}`, 2) : '',
    percentage,
  };
};

const optionalText = (value, label, step, max, required) => {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) {
    if (required) throw httpError(400, `${label} is required`, step);
    return '';
  }
  if (text.length > max) throw httpError(400, `${label} must be ${max} characters or less`, step);
  return text;
};

const optionalBlock = (value, label, step, max, required) => {
  const text = String(value || '').trim();
  if (!text) {
    if (required) throw httpError(400, `${label} is required`, step);
    return '';
  }
  if (text.length > max) throw httpError(400, `${label} must be ${max} characters or less`, step);
  return text;
};

const parseExtraAnswers = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    throw httpError(400, 'Check the extra questions and try again', 1);
  }
};

const readCustomAnswers = (body, customFields, files) => {
  const submitted = parseExtraAnswers(body.extraAnswers);
  const byId = new Map(submitted.map((item) => [String(item?.id || ''), item]));
  const filesById = new Map();
  (files || []).forEach((file) => {
    const match = String(file.fieldname || '').match(/^extraFile_(.+)$/);
    if (match) filesById.set(match[1], file);
  });
  const expectedFiles = new Set(customFields.filter((field) => field.type === 'file').map((field) => field.id));
  filesById.forEach((file, id) => {
    if (!expectedFiles.has(id)) removeFile(file);
  });

  return customFields.map((field) => {
    if (field.type === 'file') {
      const uploaded = filesById.get(field.id);
      if (!uploaded) {
        if (field.required) throw httpError(400, `Upload ${field.label}`, field.step);
        return null;
      }
      return {
        fieldId: field.id,
        label: field.label,
        value: `/uploads/documents/${uploaded.filename}`,
      };
    }

    const raw = String(byId.get(field.id)?.value ?? '').trim();
    if (!raw) {
      if (field.required) throw httpError(400, `${field.label} is required`, field.step);
      return null;
    }

    if (field.type === 'yesno' && raw !== 'Yes' && raw !== 'No') {
      throw httpError(400, `Select ${field.label}`, field.step);
    }
    if (field.type === 'select' && !field.options.includes(raw)) {
      throw httpError(400, `Select ${field.label}`, field.step);
    }
    if (field.type === 'number') {
      const number = Number(raw);
      if (!Number.isFinite(number)) throw httpError(400, `${field.label} must be a number`, field.step);
    }

    const max = field.type === 'textarea' ? 1000 : 200;
    if (raw.length > max) throw httpError(400, `${field.label} must be ${max} characters or less`, field.step);
    return { fieldId: field.id, label: field.label, value: raw.replace(/\s+/g, ' ') };
  }).filter(Boolean);
};

const validateApplication = (body, { centres, courseAvailable, fields, customFields, files }) => {
  const asked = (key) => fieldChoice(fields, key).enabled;
  const needed = (key) => fieldChoice(fields, key).required;

  const firstName = requireText(body.firstName, 'First name', 1);
  const lastName = requireText(body.lastName, 'Last name', 1);
  const mobile = requireMobile(body.mobile, 'Mobile', 1);
  const email = requireEmail(body.email, 'Student email', 1);

  let gender = '';
  if (asked('gender')) {
    gender = optionalText(body.gender, 'Gender', 1, 20, needed('gender'));
    if (gender && !GENDERS.includes(gender)) throw httpError(400, 'Select a gender', 1);
  }

  let dob = null;
  if (asked('dob')) {
    const rawDob = String(body.dob || '').trim();
    if (!rawDob && needed('dob')) throw httpError(400, 'Select a valid date of birth', 1);
    if (rawDob) {
      dob = parseDateOnly(rawDob);
      if (!dob) throw httpError(400, 'Select a valid date of birth', 1);
      const age = ageInYears(dob, new Date());
      if (age < 14 || age > 70) throw httpError(400, 'Date of birth must be between 14 and 70 years ago', 1);
    }
  }

  let category = '';
  if (asked('category')) {
    category = optionalText(body.category, 'Category', 1, 20, needed('category'));
    if (category && !CATEGORIES.includes(category)) throw httpError(400, 'Select a category', 1);
  }

  const fatherName = asked('fatherName')
    ? optionalText(body.fatherName, "Father's name", 1, 120, needed('fatherName'))
    : '';
  const motherName = asked('motherName')
    ? optionalText(body.motherName, "Mother's name", 1, 120, needed('motherName'))
    : '';

  let parentMobile = '';
  if (asked('parentMobile')) {
    const raw = String(body.parentMobile || '').trim();
    if (!raw && needed('parentMobile')) throw httpError(400, "Parent's mobile must be a 10 digit number", 1);
    if (raw) parentMobile = requireMobile(raw, "Parent's mobile", 1);
  }

  let parentEmail = '';
  if (asked('parentEmail')) {
    const raw = String(body.parentEmail || '').trim();
    if (!raw && needed('parentEmail')) throw httpError(400, 'Parent email is required', 1);
    if (raw) parentEmail = requireEmail(raw, 'Parent email', 1);
  }

  const address = asked('address') ? optionalBlock(body.address, 'Address', 1, 400, needed('address')) : '';
  const city = asked('city') ? optionalText(body.city, 'City', 1, 120, needed('city')) : '';
  const state = asked('state') ? optionalText(body.state, 'State', 1, 120, needed('state')) : '';
  const country = asked('country') ? optionalText(body.country, 'Country', 1, 120, needed('country')) : '';

  let pin = '';
  if (asked('pin')) {
    pin = String(body.pin || '').trim();
    if (!pin && needed('pin')) throw httpError(400, 'Pin must be a 6 digit number', 1);
    if (pin && !/^[0-9]{6}$/.test(pin)) throw httpError(400, 'Pin must be a 6 digit number', 1);
  }

  let qualification = '';
  const academics = {
    classX: emptyAcademicRecord(),
    classXII: emptyAcademicRecord(),
    diploma: emptyAcademicRecord(),
    iti: emptyAcademicRecord(),
    graduation: emptyAcademicRecord(),
    postGraduation: emptyAcademicRecord(),
  };
  if (asked('qualification')) {
    qualification = optionalText(body.qualification, 'Qualification', 2, 40, needed('qualification'));
    if (qualification) {
      if (!QUALIFICATIONS.includes(qualification)) throw httpError(400, 'Select a qualification', 2);
      const submittedAcademics = parseAcademics(body.academics);
      educationLevelsFor(qualification).forEach((level) => {
        academics[level] = readAcademicRecord(level, submittedAcademics);
      });
    }
  }

  let examCentreFirst = '';
  let examCentreSecond = '';
  if (asked('examCentres')) {
    examCentreFirst = optionalText(body.examCentreFirst, 'First exam centre', 2, 80, needed('examCentres'));
    examCentreSecond = optionalText(body.examCentreSecond, 'Second exam centre', 2, 80, needed('examCentres'));
    const either = examCentreFirst || examCentreSecond;
    if (either && (!examCentreFirst || !examCentreSecond)) {
      throw httpError(400, 'Select both exam centres', 2);
    }
    if (examCentreFirst || examCentreSecond) {
      if (!centres.includes(examCentreFirst) || !centres.includes(examCentreSecond)) {
        throw httpError(400, 'Select exam centres from the list', 2);
      }
      if (examCentreFirst === examCentreSecond) {
        throw httpError(400, 'Choose two different exam centres', 2);
      }
    }
  }

  let courseId = '';
  if (asked('course')) {
    courseId = String(body.courseId || '').trim();
    if (courseAvailable && needed('course') && !courseId) throw httpError(400, 'Select a course', 2);
  }

  return {
    fullName: `${firstName} ${lastName}`,
    firstName,
    lastName,
    gender,
    dob,
    category,
    fatherName,
    motherName,
    mobile,
    parentMobile,
    email,
    parentEmail,
    address,
    city,
    state,
    country,
    pin,
    qualification,
    academics,
    examCentreFirst,
    examCentreSecond,
    courseId,
    extraAnswers: readCustomAnswers(body, customFields, files),
  };
};

const splitName = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' '),
  };
};

// The counsellor's chosen status is applied only after the form is submitted.
const applyPendingRegistrationStatus = async (crmLead) => {
  if (!crmLead?._id) return;
  const metaLead = await MetaLead.findOne({ crmLead: crmLead._id, isDeleted: false }).select('_id');
  if (!metaLead) return;

  const assignment = await MetaLeadAssignment.findOne({
    lead: metaLead._id,
    isActive: true,
    pendingRegistrationStatus: { $exists: true, $ne: null },
  });
  if (!assignment) return;

  const status = await MetaLeadStatus.findOne({
    _id: assignment.pendingRegistrationStatus,
    isDeleted: false,
  });
  const remark = assignment.pendingRegistrationRemark || '';
  assignment.pendingRegistrationStatus = null;
  assignment.pendingRegistrationRemark = '';
  if (status) {
    const now = new Date();
    assignment.currentStatus = status._id;
    assignment.history.push({
      status: status._id,
      statusName: status.name,
      statusColor: status.color,
      remark,
      changedAt: now,
    });
    assignment.lastActivityAt = now;
  }
  await assignment.save();
};

const generateStudentId = async () => {
  const currentYear = new Date().getFullYear();
  const prefix = `Innovbit/${currentYear}/`;
  const count = await StudentProfile.countDocuments({
    studentId: new RegExp(`^Innovbit/${currentYear}/`),
  });
  return `${prefix}${String(count + 1).padStart(4, '0')}`;
};

const createApplication = async ({ body, file, files, lead }) => {
  const settings = await getSettings();
  const form = settings.registrationForm || {};
  const status = describeRegistrationWindow(form);
  if (!status.open) throw httpError(403, status.message);

  const fields = resolveFormFields(form.fields);
  const photoField = fieldChoice(fields, 'photo');
  let photoFile = file;
  if (!photoField.enabled) {
    removeFile(photoFile);
    photoFile = null;
  } else if (photoField.required && !photoFile) {
    throw httpError(400, 'Upload a photograph to continue', 3);
  }

  const courses = await Course.find({ isDeleted: false }).select('name code baseFees');
  const centres = form.examCentres?.length ? form.examCentres : [...DEFAULT_EXAM_CENTRES];
  const data = validateApplication(body, {
    centres,
    courseAvailable: courses.length > 0,
    fields,
    customFields: Array.isArray(form.customFields) ? form.customFields : [],
    files,
  });

  let course = null;
  if (data.courseId) {
    course = courses.find((item) => String(item._id) === data.courseId);
    if (!course) throw httpError(400, 'Select a valid course', 2);
  }

  const emailTaken = await User.findOne({ email: data.email, isDeleted: false });
  if (emailTaken) throw httpError(400, 'An account with this email already exists', 1);

  const temporaryPassword = `Innovbit-${crypto.randomBytes(4).toString('hex')}`;
  const student = await User.create({
    name: data.fullName,
    email: data.email,
    phone: data.mobile,
    password: temporaryPassword,
    role: ROLES.STUDENT,
    status: 'active',
  });

  const now = new Date();
  try {
    await StudentProfile.create({
      studentId: await generateStudentId(),
      user: student._id,
      fatherName: data.fatherName,
      motherName: data.motherName,
      dob: data.dob,
      gender: data.gender,
      address: data.address,
      category: data.category,
      parentMobile: data.parentMobile,
      parentEmail: data.parentEmail,
      city: data.city,
      state: data.state,
      country: data.country,
      pin: data.pin,
      qualification: data.qualification,
      academics: data.academics,
      classXBoard: data.academics.classX.board,
      classXPassingYear: data.academics.classX.passingYear,
      classXSchool: data.academics.classX.school,
      examCentreFirst: data.examCentreFirst,
      examCentreSecond: data.examCentreSecond,
      photoUrl: photoFile ? `/uploads/photos/${photoFile.filename}` : '',
      extraAnswers: data.extraAnswers,
      registrationFeeAmount: Number(form.registrationFee) || 0,
      course: course?._id,
      entranceStatus: 'pending',
      registrationFeePaid: false,
      formSubmittedAt: now,
      registeredBy: lead?.registeredBy,
      lead: lead?._id,
      feeDetails: {
        totalFee: course?.baseFees || 0,
        scholarshipAmount: 0,
        netFee: course?.baseFees || 0,
        paidFee: 0,
      },
      academicDetails: {
        tenthPercentage: data.academics.classX.percentage,
        twelfthPercentage: data.academics.classXII.percentage,
      },
    });

    let savedLead = lead;
    if (lead) {
      lead.name = data.fullName;
      lead.email = data.email;
      lead.phone = data.mobile;
      lead.status = 'registered';
      if (course) lead.course = course._id;
      lead.studentUser = student._id;
      lead.formSubmittedAt = now;
      await lead.save();
    } else {
      savedLead = await Lead.create({
        name: data.fullName,
        email: data.email,
        phone: data.mobile,
        status: 'registered',
        course: course?._id,
        studentUser: student._id,
        formSubmittedAt: now,
      });
    }
    try {
      await applyPendingRegistrationStatus(savedLead);
    } catch (statusError) {
      console.error('Could not apply the pending registration status:', statusError.message);
    }
  } catch (error) {
    await StudentProfile.deleteOne({ user: student._id });
    await User.deleteOne({ _id: student._id });
    if (!lead) await Lead.deleteOne({ studentUser: student._id, formSubmittedAt: now });
    throw error;
  }

  return {
    message: 'Registration form submitted. The fee is still unpaid.',
    email: data.email,
    temporaryPassword,
  };
};

const sendApplicationResult = (res, error) => {
  if (error?.code === 11000) {
    res.status(409).json({ message: 'An account with this email already exists', step: 1 });
    return;
  }
  res.status(error.statusCode || 500).json({
    message: error.message || 'Could not submit the form',
    step: error.step,
  });
};

const submitPublicApplication = async (req, res) => {
  try {
    const result = await createApplication({ body: req.body, file: req.file, files: req.files, lead: null });
    res.status(201).json(result);
  } catch (error) {
    removeUploaded(req);
    sendApplicationResult(res, error);
  }
};

const submitTokenApplication = async (req, res) => {
  try {
    const lead = await Lead.findOne({ registrationToken: req.params.token, isDeleted: false });
    if (!lead) throw httpError(404, 'This registration link is not valid');
    if (lead.formSubmittedAt) throw httpError(409, 'This registration form has already been submitted');
    const result = await createApplication({ body: req.body, file: req.file, files: req.files, lead });
    res.status(201).json(result);
  } catch (error) {
    removeUploaded(req);
    sendApplicationResult(res, error);
  }
};

const getRegistrationForm = async (req, res) => {
  try {
    const lead = await Lead.findOne({ registrationToken: req.params.token, isDeleted: false })
      .populate('course', 'name code');
    if (!lead) return res.status(404).json({ message: 'This registration link is not valid' });

    const payload = await buildWindowResponse();
    if (lead.formSubmittedAt) return res.json({ ...payload, submitted: true });

    const name = splitName(lead.name);
    res.json({
      ...payload,
      submitted: false,
      lead: {
        firstName: name.firstName,
        lastName: name.lastName,
        email: lead.email || '',
        mobile: lead.phone || '',
        courseId: lead.course?._id || '',
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  uploadPhoto,
  getRegistrationWindow,
  updateRegistrationWindow,
  getRegistrationForm,
  submitPublicApplication,
  submitTokenApplication,
};
