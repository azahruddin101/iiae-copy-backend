const crypto = require('crypto');
const mongoose = require('mongoose');
const Lead = require('../models/Lead');
const MetaLead = require('../models/MetaLead');
const Course = require('../models/Course');
const CRMSetting = require('../models/CRMSetting');
const { ROLES } = require('../utils/rbac');
const { describeRegistrationWindow } = require('../utils/registrationWindow');

// The form link can be prepared before anyone submits. The lead stays on its
// current status until that submission succeeds.
const assertRegistrationFormOpen = async () => {
  const settings = await CRMSetting.findOne();
  const status = describeRegistrationWindow(settings?.registrationForm || {});
  if (!status.open) {
    const error = new Error(status.message);
    error.statusCode = 403;
    throw error;
  }
};

// Called when a counsellor asks for the form and it has not been submitted yet.
const applyRegistrationChoice = (lead, registrationBy, actor) => {
  if (lead.formSubmittedAt) return;

  if (!['student', 'counsellor'].includes(registrationBy)) {
    const error = new Error('Choose whether the student or the counsellor will fill the registration form');
    error.statusCode = 400;
    throw error;
  }

  lead.registrationBy = registrationBy;
  if (!lead.registrationToken) {
    lead.registrationToken = crypto.randomBytes(24).toString('hex');
  }
  if (!lead.registeredBy) {
    lead.registeredBy = actor.role === ROLES.COUNSELLOR ? actor._id : (lead.assignedTo || actor._id);
  }
};

const httpError = (statusCode, message) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const firstText = (...values) => {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
};

// Prepares the form link for a Meta lead. Status stays unchanged until the form is submitted.
const startRegistrationForMetaLead = async ({ metaLeadId, registrationBy, courseId, actor }) => {
  const metaLead = await MetaLead.findById(metaLeadId);
  if (!metaLead || metaLead.isDeleted) throw httpError(404, 'Lead not found');

  let lead = metaLead.crmLead
    ? await Lead.findOne({ _id: metaLead.crmLead, isDeleted: false })
    : null;
  if (lead?.formSubmittedAt) return lead;

  await assertRegistrationFormOpen();

  if (!['student', 'counsellor'].includes(registrationBy)) {
    throw httpError(400, 'Choose whether the student or the counsellor will fill the registration form');
  }

  const name = firstText(metaLead.fullName, metaLead.fields?.full_name, metaLead.fields?.fullName, 'Student');
  const phone = firstText(metaLead.phone, metaLead.fields?.phone_number, metaLead.fields?.phone);
  const email = firstText(metaLead.email, metaLead.fields?.email).toLowerCase();
  if (!phone) throw httpError(400, 'This lead needs a phone number before it can be registered');

  let course = null;
  if (courseId) {
    if (!mongoose.isValidObjectId(courseId)) throw httpError(400, 'Invalid course');
    course = await Course.findOne({ _id: courseId, isDeleted: false });
    if (!course) throw httpError(404, 'Course not found');
  }

  if (!lead) {
    lead = new Lead({
      name,
      email,
      phone,
      assignedTo: actor._id,
    });
  } else {
    lead.name = name || lead.name;
    lead.phone = phone || lead.phone;
    if (email) lead.email = email;
    if (!lead.assignedTo) lead.assignedTo = actor._id;
  }
  if (course) lead.course = course._id;

  applyRegistrationChoice(lead, registrationBy, actor);
  await lead.save();

  if (!metaLead.crmLead || String(metaLead.crmLead) !== String(lead._id)) {
    metaLead.crmLead = lead._id;
    await metaLead.save();
  }
  return lead;
};

module.exports = {
  applyRegistrationChoice,
  assertRegistrationFormOpen,
  startRegistrationForMetaLead,
};
