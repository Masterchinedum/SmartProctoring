import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { STAFF_ROLES, type StaffRole, type StaffUserDTO } from '@sp/shared';
import { api, errorMessage, shouldRetry } from '../api/client';
import { qk } from '../api/queries';
import { useAuth } from '../auth';
import { formatDate } from '../lib/format';
import { ROLE_LABELS } from '../lib/labels';
import { ErrorState, Loading, PageHeader } from '../components/Common';
import { ConfirmDialog, Modal } from '../components/Modal';

const ROLE_HELP: Record<StaffRole, string> = {
  owner: 'Everything, including managing administrators.',
  admin: 'Manage exams, candidates, settings and reviewers; review sessions.',
  reviewer: 'View sessions and evidence, review events, add notes, decide pauses and holds.',
};

/** Roles the current user may assign: only owners may create/promote owners and admins. */
export function assignableRoles(myRole: StaffRole): StaffRole[] {
  return myRole === 'owner' ? [...STAFF_ROLES] : ['reviewer'];
}

export function UsersPage() {
  const { user: me } = useAuth();
  const q = useQuery({ queryKey: qk.users, queryFn: api.users, retry: shouldRetry });
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<StaffUserDTO | null>(null);
  const [toggling, setToggling] = useState<StaffUserDTO | null>(null);
  const qc = useQueryClient();
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof api.updateUser>[1] }) => api.updateUser(id, patch),
    onSuccess: (u) => {
      qc.setQueryData<{ items: StaffUserDTO[] }>(qk.users, (old) => (old ? { items: old.items.map((x) => (x.id === u.id ? u : x)) } : old));
      setToggling(null);
    },
  });
  const roles = assignableRoles(me.role);
  const canManage = (u: StaffUserDTO) => u.id !== me.id && (me.role === 'owner' || u.role === 'reviewer');

  return (
    <div className="stack">
      <PageHeader
        title="Users"
        subtitle="Staff accounts. Every staff action is recorded in the audit log."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            Add user
          </button>
        }
      />
      <div className="card small role-help">
        {STAFF_ROLES.map((r) => (
          <div key={r}>
            <strong>{ROLE_LABELS[r]}:</strong> {ROLE_HELP[r]}
          </div>
        ))}
      </div>
      {update.isError ? <div className="banner banner-danger" role="alert">{errorMessage(update.error)}</div> : null}
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.items.map((u) => (
                <tr key={u.id} className={u.disabled ? 'row-disabled' : ''}>
                  <td>
                    <strong>{u.name}</strong>
                    {u.id === me.id ? <span className="badge badge-info">you</span> : null}
                  </td>
                  <td>{u.email}</td>
                  <td>
                    {canManage(u) ? (
                      <select
                        aria-label={`Role of ${u.name}`}
                        value={u.role}
                        disabled={update.isPending}
                        onChange={(e) => update.mutate({ id: u.id, patch: { role: e.target.value as StaffRole } })}
                      >
                        {[...new Set([u.role, ...roles])].map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      ROLE_LABELS[u.role]
                    )}
                  </td>
                  <td>{u.disabled ? <span className="badge badge-danger">Disabled</span> : <span className="badge badge-success">Active</span>}</td>
                  <td className="small">{formatDate(u.createdAt)}</td>
                  <td>
                    {canManage(u) ? (
                      <div className="row tight nowrap">
                        <button type="button" className="btn btn-sm" onClick={() => setResetting(u)}>
                          Reset password
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => setToggling(u)}>
                          {u.disabled ? 'Enable' : 'Disable'}
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating ? <CreateUserModal roles={roles} onClose={() => setCreating(false)} /> : null}
      {resetting ? <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} /> : null}
      {toggling ? (
        <ConfirmDialog
          title={toggling.disabled ? `Enable ${toggling.name}?` : `Disable ${toggling.name}?`}
          message={toggling.disabled ? 'They will be able to sign in again.' : 'They will be signed out and unable to sign in. Their past actions stay in the audit log.'}
          confirmLabel={toggling.disabled ? 'Enable' : 'Disable'}
          danger={!toggling.disabled}
          busy={update.isPending}
          error={update.isError ? errorMessage(update.error) : null}
          onConfirm={() => update.mutate({ id: toggling.id, patch: { disabled: !toggling.disabled } })}
          onCancel={() => setToggling(null)}
        />
      ) : null}
    </div>
  );
}

function CreateUserModal({ roles, onClose }: { roles: StaffRole[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<StaffRole>('reviewer');
  const [password, setPassword] = useState('');
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && name.trim() && password.length >= 10;
  const m = useMutation({
    mutationFn: () => api.createUser({ email: email.trim(), name: name.trim(), role, password }),
    onSuccess: (u) => {
      qc.setQueryData<{ items: StaffUserDTO[] }>(qk.users, (old) => (old ? { items: [...old.items, u] } : old));
      onClose();
    },
  });
  return (
    <Modal
      title="Add user"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="create-user" className="btn btn-primary" disabled={!valid || m.isPending}>
            {m.isPending ? 'Creating…' : 'Create user'}
          </button>
        </>
      }
    >
      <form
        id="create-user"
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) m.mutate();
        }}
      >
        <label>
          Name
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        </label>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
          <span className="muted small">{ROLE_HELP[role]}</span>
        </label>
        <label>
          Initial password (at least 10 characters)
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          {password && password.length < 10 ? <span className="text-danger small">At least 10 characters</span> : null}
        </label>
        <p className="muted small">Share the password with the user through a secure channel.</p>
        {m.isError ? <div className="banner banner-danger" role="alert">{errorMessage(m.error)}</div> : null}
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose }: { user: StaffUserDTO; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const m = useMutation({ mutationFn: () => api.updateUser(user.id, { password }), onSuccess: () => setDone(true) });
  return (
    <Modal
      title={`Reset password — ${user.name}`}
      onClose={onClose}
      footer={
        done ? (
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={password.length < 10 || m.isPending} onClick={() => m.mutate()}>
              {m.isPending ? 'Saving…' : 'Set password'}
            </button>
          </>
        )
      }
    >
      {done ? (
        <div className="banner banner-success">Password updated. Share it with {user.name} through a secure channel.</div>
      ) : (
        <div className="stack">
          <label>
            New password (at least 10 characters)
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </label>
          {m.isError ? <div className="banner banner-danger" role="alert">{errorMessage(m.error)}</div> : null}
        </div>
      )}
    </Modal>
  );
}
