import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './components/ui';
import { initDb } from './db';
import App from './App';
import './styles.css';

const root = createRoot(document.getElementById('root'));
root.render(<div className="center-screen"><div className="spinner" aria-label="Loading" /></div>);

// Installable app + opens without internet (production builds only)
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// Find out which database the canteen uses (Firebase, Supabase or Google Sheets) before starting.
initDb().finally(() => {
  root.render(
    <StrictMode>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </StrictMode>,
  );
});
