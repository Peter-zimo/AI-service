function parseAllowedOrigins(value) {
  return value ? value.split(',').map(origin => origin.trim()).filter(Boolean) : [];
}

function isAllowedOrigin(origin, nodeEnv, allowedOriginsEnv) {
  if (!origin) return true;
  const allowedOrigins = parseAllowedOrigins(allowedOriginsEnv);
  if (nodeEnv === 'production' && allowedOrigins.length === 0) return false;
  return allowedOrigins.length === 0 || allowedOrigins.includes(origin);
}

module.exports = { isAllowedOrigin, parseAllowedOrigins };
