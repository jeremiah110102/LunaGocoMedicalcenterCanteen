export const ROLES = ['admin', 'manager', 'cashier', 'inventory', 'accountant'];

export const ROLE_LABELS = {
  admin: 'Admin',
  manager: 'Manager',
  cashier: 'Cashier',
  inventory: 'Inventory staff',
  accountant: 'Accountant',
  pending: 'Pending approval',
};

// Which roles may open each page. Firestore rules enforce the same limits on the data.
export const ACCESS = {
  dashboard: ['admin', 'manager', 'cashier', 'inventory', 'accountant'],
  pos: ['admin', 'manager', 'cashier'],
  sales: ['admin', 'manager', 'cashier', 'accountant'],
  shifts: ['admin', 'manager', 'cashier'],
  expenses: ['admin', 'manager', 'cashier'],
  products: ['admin', 'manager', 'inventory'],
  ingredients: ['admin', 'manager', 'inventory'],
  inventory: ['admin', 'manager', 'inventory'],
  purchasing: ['admin', 'manager', 'inventory'],
  credit: ['admin', 'manager', 'cashier'],
  reports: ['admin', 'manager', 'accountant'],
  accounting: ['admin', 'manager', 'accountant'],
  users: ['admin'],
  backup: ['admin'],
  audit: ['admin'],
  settings: ['admin'],
};

export const can = (profile, area) =>
  !!profile && profile.active !== false && (ACCESS[area] || []).includes(profile.role);

export const canManageCredit = (profile) => ['admin', 'manager'].includes(profile?.role);
