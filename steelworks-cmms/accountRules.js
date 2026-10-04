'use strict';
// Validation for a person changing their OWN password or profile. Kept free
// of dependencies so it can be tested without a database.

const MIN_PASSWORD = 8;
// bcrypt only looks at the first 72 bytes, so anything longer would be
// silently truncated: two different long passwords could then unlock the
// same account. Better to refuse than to quietly accept.
const MAX_PASSWORD_BYTES = 72;
const USERNAME_RE = /^[A-Za-z0-9._@-]{3,40}$/;

function validateNewPassword(currentPassword, newPassword) {
  if (!currentPassword) return 'Enter your current password';
  if (typeof newPassword !== 'string' || !newPassword.trim()) return 'Enter a new password';
  if (newPassword.length < MIN_PASSWORD) return `New password must be at least ${MIN_PASSWORD} characters`;
  if (Buffer.byteLength(newPassword, 'utf8') > MAX_PASSWORD_BYTES) return `New password is too long (${MAX_PASSWORD_BYTES} bytes at most)`;
  if (newPassword === currentPassword) return 'New password must be different from your current one';
  return null;
}

// Returns { error } or { name, username, usernameChanged }.
// The username format is only enforced when it is being CHANGED, so someone
// whose existing username predates these rules can still update their name.
function cleanProfile({ name, username, currentUsername }) {
  const cleanName = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  if (!cleanName) return { error: 'Name is required' };
  if (cleanName.length > 80) return { error: 'Name is too long (80 characters at most)' };

  const wanted = username == null ? currentUsername : String(username).trim();
  const usernameChanged = wanted !== currentUsername;
  if (usernameChanged && !USERNAME_RE.test(wanted)) {
    return { error: 'Username must be 3 to 40 characters: letters, numbers, dot, dash, underscore or @ (no spaces)' };
  }
  return { name: cleanName, username: wanted, usernameChanged };
}

module.exports = { validateNewPassword, cleanProfile, MIN_PASSWORD, MAX_PASSWORD_BYTES };
