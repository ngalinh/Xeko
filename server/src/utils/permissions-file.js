const fs = require('fs');
const path = require('path');

function migratePermissionsFile(target, legacy) {
  if (fs.existsSync(target) || !fs.existsSync(legacy)) return false;
  // Validate before copying so a corrupt backup cannot become the active store.
  const data = JSON.parse(fs.readFileSync(legacy, 'utf8'));
  if (!data || !data.users || typeof data.users !== 'object' || Array.isArray(data.users)) {
    throw new Error('Invalid legacy permissions file');
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(legacy, target, fs.constants.COPYFILE_EXCL);
  return true;
}

module.exports = { migratePermissionsFile };
