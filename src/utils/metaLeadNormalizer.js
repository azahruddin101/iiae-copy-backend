const MAX_SEARCH_TEXT_LENGTH = 2000;

// Form question keys become object keys, so make them safe to store in MongoDB
const sanitizeFieldKey = (name, index) => {
  const key = String(name || '')
    .trim()
    .replace(/\./g, '_')
    .replace(/^[$_]+/, '');
  return key || `field_${index + 1}`;
};

// Convert a Graph API lead into the fields stored on MetaLead.
// Forms differ per customer, so every answer is kept under its own question key.
const normalizeMetaLead = (raw) => {
  const fields = {};
  const fieldData = Array.isArray(raw.field_data) ? raw.field_data : [];

  fieldData.forEach((item, index) => {
    let key = sanitizeFieldKey(item && item.name, index);
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      key = `${key}_${index + 1}`;
    }
    const values = item && Array.isArray(item.values) ? item.values.map((v) => String(v)) : [];
    fields[key] = values.length <= 1 ? values[0] || '' : values;
  });

  const first = (...keys) => {
    for (const key of keys) {
      const value = Array.isArray(fields[key]) ? fields[key][0] : fields[key];
      if (value) return value;
    }
    return '';
  };

  const searchText = Object.values(fields)
    .flat()
    .join(' ')
    .toLowerCase()
    .slice(0, MAX_SEARCH_TEXT_LENGTH);

  const createdAt = raw.created_time ? new Date(raw.created_time) : null;

  const normalized = {
    fields,
    fullName: first('full_name') || [first('first_name'), first('last_name')].filter(Boolean).join(' '),
    email: first('email', 'work_email'),
    phone: first('phone_number', 'work_phone_number', 'phone'),
    searchText,
    leadCreatedAt: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : undefined,
    campaignId: raw.campaign_id,
    campaignName: raw.campaign_name,
    adSetId: raw.adset_id,
    adSetName: raw.adset_name,
    adId: raw.ad_id,
    adName: raw.ad_name,
    platform: raw.platform,
    isOrganic: typeof raw.is_organic === 'boolean' ? raw.is_organic : undefined,
  };

  // Keep whatever the webhook already stored when the Graph API omits a value
  Object.keys(normalized).forEach((key) => {
    if (normalized[key] === undefined || normalized[key] === null) delete normalized[key];
  });

  return normalized;
};

module.exports = { normalizeMetaLead };
