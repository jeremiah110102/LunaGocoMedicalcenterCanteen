import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { isConfigured } from './firebase';
import Layout from './components/Layout';
import Guard from './components/Guard';
import Login from './pages/Login';
import Pending from './pages/Pending';
import PinLock from './pages/PinLock';
import SetupAdmin from './pages/SetupAdmin';


const loaders = {
  Dashboard: () => import('./pages/Dashboard'),
  POS: () => import('./pages/POS'),
  Sales: () => import('./pages/Sales'),
  Products: () => import('./pages/Products'),
  Ingredients: () => import('./pages/Ingredients'),
  Inventory: () => import('./pages/Inventory'),
  Credit: () => import('./pages/Credit'),
  Reports: () => import('./pages/Reports'),
  Accounting: () => import('./pages/Accounting'),
  Users: () => import('./pages/Users'),
  Backup: () => import('./pages/Backup'),
  AuditLog: () => import('./pages/AuditLog'),
  Purchasing: () => import('./pages/Purchasing'),
  Settings: () => import('./pages/Settings'),
  Shifts: () => import('./pages/Shifts'),
  Expenses: () => import('./pages/Expenses'),
};
const Dashboard = lazy(loaders.Dashboard);
const POS = lazy(loaders.POS);
const Sales = lazy(loaders.Sales);
const Products = lazy(loaders.Products);
const Ingredients = lazy(loaders.Ingredients);
const Inventory = lazy(loaders.Inventory);
const Credit = lazy(loaders.Credit);
const Reports = lazy(loaders.Reports);
const Accounting = lazy(loaders.Accounting);
const Users = lazy(loaders.Users);
const Backup = lazy(loaders.Backup);
const AuditLog = lazy(loaders.AuditLog);
const Purchasing = lazy(loaders.Purchasing);
const Settings = lazy(loaders.Settings);
const Shifts = lazy(loaders.Shifts);
const Expenses = lazy(loaders.Expenses);

/** Downloads every page in the background, so the app keeps working offline later. */
let preloaded = false;
function preloadPages() {
  if (preloaded || !navigator.onLine) return;
  preloaded = true;
  const go = () => Object.values(loaders).forEach((load) => load().catch(() => {}));
  if ('requestIdleCallback' in window) window.requestIdleCallback(go, { timeout: 5000 });
  else setTimeout(go, 2000);
}

const Loading = () => <div className="center-screen"><div className="spinner" aria-label="Loading" /></div>;
const guarded = (area, el) => <Guard area={area}><Suspense fallback={<Loading />}>{el}</Suspense></Guard>;

export default function App() {
  const { user, account, approved, profile, needsAdminSetup, loading, error } = useAuth();
  useEffect(() => {
    if (profile) preloadPages();
  }, [profile]);

  if (!isConfigured) {
    return (
      <div className="center-screen">
        <div className="card narrow">
          <h1>Firebase not configured</h1>
          <p>Paste your Firebase web config into <code>src/firebase/config.js</code>, then restart <code>npm run dev</code>.</p>
        </div>
      </div>
    );
  }

  if (loading) return <div className="center-screen"><div className="spinner" aria-label="Loading" /></div>;

  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }

  if (error && !account) {
    return (
      <div className="center-screen">
        <div className="card narrow">
          <h1>Couldn't load your account</h1>
          <p className="muted">{error.code === 'permission-denied' ? 'Firestore rules blocked the request. Deploy firestore.rules from this project.' : error.message}</p>
        </div>
      </div>
    );
  }

  if (!account || !approved) return <Pending />;
  if (needsAdminSetup) return <SetupAdmin />;
  if (!profile) return <PinLock />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={guarded('dashboard', <Dashboard />)} />
        <Route path="pos" element={guarded('pos', <POS />)} />
        <Route path="sales" element={guarded('sales', <Sales />)} />
        <Route path="products" element={guarded('products', <Products />)} />
        <Route path="ingredients" element={guarded('ingredients', <Ingredients />)} />
        <Route path="inventory" element={guarded('inventory', <Inventory />)} />
        <Route path="credit" element={guarded('credit', <Credit />)} />
        <Route path="reports" element={guarded('reports', <Reports />)} />
        <Route path="accounting" element={guarded('accounting', <Accounting />)} />
        <Route path="users" element={guarded('users', <Users />)} />
        <Route path="backup" element={guarded('backup', <Backup />)} />
        <Route path="audit" element={guarded('audit', <AuditLog />)} />
        <Route path="purchasing" element={guarded('purchasing', <Purchasing />)} />
        <Route path="settings" element={guarded('settings', <Settings />)} />
        <Route path="shifts" element={guarded('shifts', <Shifts />)} />
        <Route path="expenses" element={guarded('expenses', <Expenses />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
