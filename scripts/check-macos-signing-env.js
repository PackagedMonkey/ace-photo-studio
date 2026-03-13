#!/usr/bin/env node

const strict = process.argv.includes('--strict');

const requiredNotarizationVars = [
  'APPLE_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_TEAM_ID',
];

const optionalSigningVars = [
  'CSC_LINK',
  'CSC_KEY_PASSWORD',
];

const missingRequired = requiredNotarizationVars.filter((name) => !process.env[name]);
const missingOptional = optionalSigningVars.filter((name) => !process.env[name]);

console.log('macOS signing/notarization environment check');
console.log(`Strict mode: ${strict ? 'on' : 'off'}`);

if (!missingRequired.length) {
  console.log('Required notarization environment: ready');
} else {
  console.log(`Required notarization environment: missing (${missingRequired.join(', ')})`);
}

if (!missingOptional.length) {
  console.log('Optional certificate environment: ready');
} else {
  console.log(`Optional certificate environment: missing (${missingOptional.join(', ')})`);
}

if (missingRequired.length && strict) {
  process.exit(1);
}
