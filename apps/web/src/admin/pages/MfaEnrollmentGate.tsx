import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { qk } from '../api/queries';
import { useAuth } from '../auth';
import { useDocumentTitle } from '../../lib/a11y';
import { MfaSetup } from '../components/MfaSetup';

/**
 * Shown instead of the staff app while the organisation requires two-step sign-in and this user has not set it up:
 * the server refuses everything else (403 mfa_enrollment_required) until they do.
 */
export function MfaEnrollmentGate() {
  const { user, org } = useAuth();
  const qc = useQueryClient();
  const [signingOut, setSigningOut] = useState(false);
  useDocumentTitle('Set up two-step sign-in — SmartProctoring staff');
  return (
    <main className="login-page">
      <section className="card login-card mfa-gate stack" aria-labelledby="mfa-gate-title" data-testid="mfa-gate">
        <h1 id="mfa-gate-title">Set up two-step sign-in</h1>
        <p>
          {org.name} requires two-step sign-in for your account: after your password you also enter a code from an authenticator app on your phone. Setting it up takes
          about a minute; you can use the staff app right after.
        </p>
        <MfaSetup account={user.email} org={org.name} onDone={() => void qc.invalidateQueries({ queryKey: qk.me })} />
        <button
          type="button"
          className="btn btn-link"
          disabled={signingOut}
          onClick={async () => {
            setSigningOut(true);
            await api.logout().catch(() => undefined);
            qc.setQueryData(qk.me, null);
          }}
        >
          Sign out
        </button>
      </section>
    </main>
  );
}
