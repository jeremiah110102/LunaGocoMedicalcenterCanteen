import { useAuth } from '../context/AuthContext';
import { can } from '../lib/roles';

/** Blocks a page unless the signed-in user's role allows it. */
export default function Guard({ area, children }) {
  const { profile } = useAuth();
  if (!can(profile, area)) {
    return (
      <div className="card narrow">
        <h1>No access</h1>
        <p className="muted">Your role can't open this page. Ask an administrator if you need it.</p>
      </div>
    );
  }
  return children;
}

