// Structured event logging for the Meta integration.
// Only pass IDs and status codes here - never tokens, secrets, OAuth codes or lead answers.

const format = (event, details) => {
  const suffix = details && Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
  return `[META] ${event}${suffix}`;
};

const logMetaEvent = (event, details = {}) => {
  console.log(format(event, details));
};

const logMetaError = (event, details = {}) => {
  console.error(format(event, details));
};

module.exports = { logMetaEvent, logMetaError };
