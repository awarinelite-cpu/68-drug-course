// The set of roles an admin can assign when creating an account (see
// Admin.jsx "Create Account"). `admin` and `subadmin` are deliberately not
// in this list — subadmin is granted afterwards via "Make Subadmin", and
// admin accounts are provisioned directly in Firestore, not through this
// form.
export const ROLE_OPTIONS = [
  { value: 'nurse', label: 'Nurse' },
  { value: 'doctor', label: 'Doctor' }
];

// Abbreviation shown as a title in front of a person's name (e.g. on their
// Profile page, in the nav drawer, and in Admin's user list) wherever the
// name and role are both on display. Every other role — nurse, admin,
// subadmin — has no title and the plain name is used as-is.
export function roleAbbreviation(role) {
  return role === 'doctor' ? 'Dr.' : '';
}

// Prefixes name with the role's abbreviation when it has one, e.g.
// formatNameWithTitle('Aisha Bello', 'doctor') -> 'Dr. Aisha Bello'.
export function formatNameWithTitle(name, role) {
  const n = (name || '').trim();
  const abbr = roleAbbreviation(role);
  if (!n) return n;
  return abbr ? abbr + ' ' + n : n;
}
