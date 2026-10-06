const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  QUALIFICATIONS,
  describeRegistrationWindow,
  educationLevelsFor,
  parseIndiaDateTime,
  toIndiaDateTimeLocal,
  resolveFormFields,
  sanitizeCustomFields,
} = require('../src/utils/registrationWindow');

const at = (iso) => new Date(iso);

test('a turned-off form stays closed even when the dates say it is open', () => {
  const status = describeRegistrationWindow({
    enabled: false,
    liveFrom: at('2026-10-01T00:00:00.000Z'),
    disableAt: at('2026-10-20T00:00:00.000Z'),
  }, at('2026-10-06T04:00:00.000Z'));

  assert.equal(status.open, false);
  assert.equal(status.phase, 'disabled');
});

test('an enabled form stays closed until the live date', () => {
  const liveFrom = parseIndiaDateTime('2026-10-10T09:00');
  const status = describeRegistrationWindow({
    enabled: true,
    liveFrom,
    disableAt: parseIndiaDateTime('2026-10-20T18:00'),
  }, at('2026-10-06T04:00:00.000Z'));

  assert.equal(status.open, false);
  assert.equal(status.phase, 'scheduled');
  assert.match(status.message, /10 Oct 2026, 9:00 am/);
});

test('an enabled form is live between the two dates', () => {
  const status = describeRegistrationWindow({
    enabled: true,
    liveFrom: parseIndiaDateTime('2026-10-01T09:00'),
    disableAt: parseIndiaDateTime('2026-10-20T18:00'),
  }, at('2026-10-06T04:00:00.000Z'));

  assert.equal(status.open, true);
  assert.equal(status.phase, 'live');
  assert.match(status.message, /20 Oct 2026, 6:00 pm/);
});

test('an enabled form with no dates is live immediately', () => {
  const status = describeRegistrationWindow({ enabled: true }, at('2026-10-06T04:00:00.000Z'));
  assert.equal(status.open, true);
  assert.equal(status.phase, 'live');
});

test('the form closes at the disable date', () => {
  const disableAt = parseIndiaDateTime('2026-10-06T09:30');
  const status = describeRegistrationWindow({
    enabled: true,
    disableAt,
  }, disableAt);

  assert.equal(status.open, false);
  assert.equal(status.phase, 'closed');
});

test('each qualification asks for the education records that match it', () => {
  assert.deepEqual([...QUALIFICATIONS], ['10th', '12th', 'Diploma', 'ITI', 'Graduate', 'Post Graduate']);
  assert.deepEqual(educationLevelsFor('10th'), ['classX']);
  assert.deepEqual(educationLevelsFor('12th'), ['classX', 'classXII']);
  assert.deepEqual(educationLevelsFor('Diploma'), ['classX', 'diploma']);
  assert.deepEqual(educationLevelsFor('ITI'), ['classX', 'iti']);
  assert.deepEqual(educationLevelsFor('Graduate'), ['classX', 'classXII', 'graduation']);
  assert.deepEqual(educationLevelsFor('Post Graduate'), ['classX', 'classXII', 'graduation', 'postGraduation']);
  assert.deepEqual(educationLevelsFor('Unknown'), []);
});

test('India date times round-trip and reject impossible dates', () => {
  const parsed = parseIndiaDateTime('2026-10-10T09:00');
  assert.equal(parsed.toISOString(), '2026-10-10T03:30:00.000Z');
  assert.equal(toIndiaDateTimeLocal(parsed), '2026-10-10T09:00');
  assert.equal(parseIndiaDateTime('2026-02-31T09:00'), null);
  assert.equal(parseIndiaDateTime(''), null);
});

test('built-in fields stay on until an admin turns one off', () => {
  const defaults = resolveFormFields();
  const email = defaults.find((field) => field.key === 'email');
  const parentEmail = defaults.find((field) => field.key === 'parentEmail');
  const gender = defaults.find((field) => field.key === 'gender');
  assert.equal(email.enabled, true);
  assert.equal(email.locked, true);
  assert.equal(parentEmail.required, false);
  assert.equal(gender.enabled, true);
  assert.equal(gender.required, true);

  const hidden = resolveFormFields({ gender: { enabled: false, required: true } });
  const hiddenGender = hidden.find((field) => field.key === 'gender');
  assert.equal(hiddenGender.enabled, false);
  assert.equal(hiddenGender.required, false);
  assert.equal(hidden.find((field) => field.key === 'email').enabled, true);
});

test('extra questions need a label and a dropdown needs two choices', () => {
  assert.match(sanitizeCustomFields([{ label: '  ' }]).error, /label/);
  assert.match(sanitizeCustomFields([{ id: 'aadhaar01', label: 'ID proof', type: 'select', options: ['Aadhaar'] }]).error, /two dropdown/);

  const saved = sanitizeCustomFields([{
    id: 'hostelquestion01',
    label: 'Need hostel?',
    type: 'yesno',
    required: true,
    step: 1,
  }]);
  assert.equal(saved.error, undefined);
  assert.equal(saved.fields[0].id, 'hostelquestion01');
  assert.equal(saved.fields[0].type, 'yesno');
  assert.equal(saved.fields[0].required, true);

  const fileQuestion = sanitizeCustomFields([{
    id: 'marksheet01',
    label: 'Class X marksheet',
    type: 'file',
    required: true,
    step: 2,
  }]);
  assert.equal(fileQuestion.error, undefined);
  assert.equal(fileQuestion.fields[0].type, 'file');
});
