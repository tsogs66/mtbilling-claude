import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, Plus, Pencil, Trash2, UserPlus, Wallet, ExternalLink } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, Modal, ModalFooter, FormField, PageHeader } from '../components/ui';
import { api } from '../api';

const PERMISSIONS = [
  'dashboard', 'terminal', 'ai', 'routers', 'network', 'pppoe', 'ipoe', 'map',
  'zerotier', 'twingate', 'noc', 'super-router', 'tech-tools', 'files', 'sales', 'inventory', 'hotspot',
  'notifications', 'uptime', 'logs', 'company', 'settings', 'roles', 'updater', 'license',
  'job-orders', 'invoices', 'finance', 'portal', 'rogue',
];

export default function PanelRoles() {
  const [roles, setRoles] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [cashiers, setCashiers] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const [editUser, setEditUser] = useState<any>(null);
  const [editCashier, setEditCashier] = useState<any>(null);

  const load = () => {
    api.get('/roles').then((r) => setRoles(r.data));
    api.get('/panel-users').then((r) => setUsers(r.data));
    api
      .get('/merchants')
      .then((r) => setCashiers(r.data.merchants || r.data.cashiers || []))
      .catch(() => setCashiers([]));
  };
  useEffect(() => {
    load();
  }, []);

  const del = async (id: number) => {
    if (!confirm('Delete this role?')) return;
    try {
      await api.delete(`/roles/${id}`);
      load();
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Could not delete role');
    }
  };

  const delUser = async (id: number) => {
    if (!confirm('Delete this panel user?')) return;
    try {
      await api.delete(`/panel-users/${id}`);
      load();
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Could not delete user');
    }
  };

  const delCashier = async (id: number) => {
    if (!confirm('Delete this merchant portal account?')) return;
    try {
      await api.delete(`/merchants/${id}`);
      load();
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Could not delete merchant');
    }
  };

  return (
    <Layout title="Panel Roles">
      <PageHeader
        title="Roles & Users"
        description="Assign menu access by role. Create merchant portal accounts for business partners (email login, mobile = initial password)."
        icon={ShieldCheck}
      />

      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">Merchant portal accounts</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Partners sign in at{' '}
            <Link to="/merchant" className="text-sky-600 hover:underline font-medium">
              /merchant
            </Link>{' '}
            (email = login; initial password = mobile). If you are already in the staff panel, sign out
            there first (or use a private window). Recovery uses email + mobile.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/merchant" className="btn-secondary inline-flex items-center gap-1.5 text-sm">
            <ExternalLink size={14} /> Open portal
          </Link>
          <button
            type="button"
            className="btn-primary"
            onClick={() => setEditCashier({ email: '', mobile: '' })}
          >
            <Wallet size={16} /> New Merchant
          </button>
        </div>
      </div>
      <div className="card mb-6 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-400 bg-slate-50 border-b border-slate-100">
              <th className="px-4 py-2.5">Email (login)</th>
              <th className="px-4 py-2.5">Mobile</th>
              <th className="px-4 py-2.5">Theme</th>
              <th className="px-4 py-2.5 w-40" />
            </tr>
          </thead>
          <tbody>
            {cashiers.map((c) => (
              <tr key={c.id} className="border-b border-slate-50">
                <td className="px-4 py-2.5 font-medium text-slate-800">{c.email}</td>
                <td className="px-4 py-2.5 text-slate-600 font-mono text-xs">{c.mobile}</td>
                <td className="px-4 py-2.5 text-slate-500 text-xs capitalize">{c.theme}</td>
                <td className="px-4 py-2.5 text-right space-x-2">
                  <button type="button" className="text-sky-600 hover:underline" onClick={() => setEditCashier(c)}>
                    Edit
                  </button>
                  <button type="button" className="text-rose-600 hover:underline" onClick={() => delCashier(c.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {cashiers.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  No merchant portal accounts yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-slate-700">Panel users</h2>
        <button
          type="button"
          className="btn-primary"
          onClick={() => setEditUser({ username: '', password: '', role: roles[0]?.name || 'Read-only' })}
        >
          <UserPlus size={16} /> New User
        </button>
      </div>
      <div className="card mb-6 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-400 bg-slate-50 border-b border-slate-100">
              <th className="px-4 py-2.5">Username</th>
              <th className="px-4 py-2.5">Role</th>
              <th className="px-4 py-2.5 w-28" />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-slate-50">
                <td className="px-4 py-2.5 font-medium text-slate-800">{u.username}</td>
                <td className="px-4 py-2.5 text-slate-600">{u.role}</td>
                <td className="px-4 py-2.5 text-right space-x-2">
                  <button type="button" className="text-sky-600 hover:underline" onClick={() => setEditUser({ ...u, password: '' })}>Edit</button>
                  <button type="button" className="text-rose-600 hover:underline" onClick={() => delUser(u.id)}>Delete</button>
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr><td colSpan={3} className="px-4 py-6 text-center text-slate-400">No users yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex justify-between items-center mb-4">
        <h2 className="text-sm font-semibold text-slate-700">Roles</h2>
        <button type="button" className="btn-primary" onClick={() => setEdit({ name: '', description: '', permissions: [] })}>
          <Plus size={16} /> Add Role
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {roles.map((r) => (
          <Card key={r.id}>
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center"><ShieldCheck size={20} /></div>
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold text-slate-800">{r.name}</h3>
                  <div className="flex items-center gap-2 text-slate-400">
                    <button type="button" className="hover:text-sky-600" onClick={() => setEdit({ ...r })}><Pencil size={15} /></button>
                    <button type="button" className="hover:text-rose-600" onClick={() => del(r.id)}><Trash2 size={15} /></button>
                  </div>
                </div>
                <div className="text-xs text-slate-400 mt-1">{r.description}</div>
                <div className="flex flex-wrap gap-1 mt-3">
                  {(r.permissions || []).map((p: string) => (
                    <span key={p} className="badge bg-slate-100 text-slate-600">{p === '*' ? 'all access' : p}</span>
                  ))}
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {edit && (
        <RoleModal
          role={edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            load();
          }}
        />
      )}
      {editUser && (
        <UserModal
          user={editUser}
          roles={roles}
          onClose={() => setEditUser(null)}
          onSaved={() => {
            setEditUser(null);
            load();
          }}
        />
      )}
      {editCashier && (
        <MerchantModal
          cashier={editCashier}
          onClose={() => setEditCashier(null)}
          onSaved={() => {
            setEditCashier(null);
            load();
          }}
        />
      )}
    </Layout>
  );
}

function RoleModal({ role, onClose, onSaved }: any) {
  const [form, setForm] = useState({ name: role.name || '', description: role.description || '', permissions: role.permissions || [] });
  const [busy, setBusy] = useState(false);
  const isEdit = !!role.id;
  const all = form.permissions.includes('*');
  const toggle = (p: string) =>
    setForm((f: any) => ({ ...f, permissions: f.permissions.includes(p) ? f.permissions.filter((x: string) => x !== p) : [...f.permissions, p] }));
  const save = async () => {
    if (!form.name.trim()) return;
    setBusy(true);
    try {
      if (isEdit) await api.put(`/roles/${role.id}`, form);
      else await api.post('/roles', form);
      onSaved();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={isEdit ? 'Edit Role' : 'Add Role'}
      onClose={onClose}
      footer={<ModalFooter onCancel={onClose} onConfirm={save} busy={busy} confirmLabel="Save" />}
    >
      <div className="space-y-3">
        <FormField label="Role Name" required>
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </FormField>
        <FormField label="Description">
          <input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </FormField>
        <FormField label="Permissions">
          <label className="flex items-center gap-2 text-sm mb-2">
            <input type="checkbox" checked={all} onChange={() => setForm((f: any) => ({ ...f, permissions: all ? [] : ['*'] }))} /> Full access (all modules)
          </label>
          {!all && (
            <div className="grid grid-cols-2 gap-1.5 max-h-44 overflow-y-auto">
              {PERMISSIONS.map((p) => (
                <label key={p} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.permissions.includes(p)} onChange={() => toggle(p)} /> {p}
                </label>
              ))}
            </div>
          )}
        </FormField>
      </div>
    </Modal>
  );
}

function UserModal({ user, roles, onClose, onSaved }: any) {
  const [form, setForm] = useState({
    username: user.username || '',
    password: '',
    role: user.role || roles[0]?.name || '',
  });
  const [busy, setBusy] = useState(false);
  const isEdit = !!user.id;
  const save = async () => {
    if (!form.username.trim()) return;
    if (!isEdit && form.password.length < 6) return;
    setBusy(true);
    try {
      if (isEdit) await api.put(`/panel-users/${user.id}`, form);
      else await api.post('/panel-users', form);
      onSaved();
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Could not save user');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={isEdit ? 'Edit User' : 'New User'}
      onClose={onClose}
      footer={<ModalFooter onCancel={onClose} onConfirm={save} busy={busy} confirmLabel="Save User" />}
    >
      <div className="space-y-3">
        <FormField label="Username" required>
          <input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        </FormField>
        <FormField label={isEdit ? 'New Password (optional)' : 'Password'} required={!isEdit}>
          <input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={isEdit ? 'Leave blank to keep' : 'Min 6 characters'} />
        </FormField>
        <FormField label="Role" required>
          <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {roles.map((r: any) => (
              <option key={r.id} value={r.name}>{r.name}</option>
            ))}
          </select>
        </FormField>
      </div>
    </Modal>
  );
}

function MerchantModal({ cashier, onClose, onSaved }: any) {
  const [form, setForm] = useState({
    email: cashier.email || '',
    mobile: cashier.mobile || '',
    resetPasswordToMobile: false,
  });
  const [busy, setBusy] = useState(false);
  const isEdit = !!cashier.id;
  const save = async () => {
    if (!form.email.trim() || !form.mobile.trim()) return;
    setBusy(true);
    try {
      if (isEdit) {
        await api.put(`/merchants/${cashier.id}`, form);
      } else {
        await api.post('/merchants', form);
      }
      onSaved();
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Could not save merchant');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={isEdit ? 'Edit Merchant' : 'New Merchant'}
      onClose={onClose}
      footer={<ModalFooter onCancel={onClose} onConfirm={save} busy={busy} confirmLabel="Save Merchant" />}
    >
      <div className="space-y-3">
        <p className="text-xs text-slate-500">
          Email is the login username. Initial password is the mobile number. Partners use{' '}
          <code className="text-slate-700">/merchant</code> only (not the full staff panel).
        </p>
        <FormField label="Email" required>
          <input
            className="input"
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="cashier@example.com"
          />
        </FormField>
        <FormField label="Mobile number" required hint="Used as initial password and for account recovery">
          <input
            className="input"
            value={form.mobile}
            onChange={(e) => setForm({ ...form, mobile: e.target.value })}
            placeholder="09XXXXXXXXX"
          />
        </FormField>
        {isEdit && (
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.resetPasswordToMobile}
              onChange={(e) => setForm({ ...form, resetPasswordToMobile: e.target.checked })}
            />
            Reset password to this mobile number
          </label>
        )}
      </div>
    </Modal>
  );
}
