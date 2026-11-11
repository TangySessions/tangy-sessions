import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useUserAuth } from '../../context/UserAuthContext';
import { supabase, isSupabaseConfigured } from '../../lib/supabaseClient';
import { changeRows, loadFailed } from '../../lib/mutation';
import { AgentRequestForm } from '../../components/ai/AgentRequestForm';
import { PortalShell, Badge, Empty, fmtDate, StatTile, ReadOnlyNote } from './portal/PortalUI';
import { usePartnerPortal, partnerTabs, PartnerSection } from '../../portal/PartnerPortal';

const TABS = [
  { id: 'overview', label: '📊 OVERVIEW' },
  { id: 'assignments', label: '📌 EVENT ASSIGNMENTS' },
  { id: 'applications', label: '📋 APPLICATIONS' },
  { id: 'profile', label: '🍵 PROFILE' },
  { id: 'help', label: '✦ MESSAGES' },
];

const TODAY = new Date().toISOString().slice(0, 10);

// `overrideProfile` + `readOnly` are set only by the admin preview route
// (src/pages/admin/AdminPortalPreview.jsx) — see the identical note in
// CrewDashboard.jsx for the security reasoning (RLS-backed, no impersonation).
// `demoData` ({ applications, profile, assignments }) is set only by the
// demo-admin build (src/pages/demoAdmin/DemoRoleDashboard.jsx) — when
// present, this skips every real Supabase call below. See demoAdminData.js.
export const VendorDashboard = ({ overrideProfile, readOnly, demoData } = {}) => {
  const navigate = useNavigate();
  const { user: authUser, logout } = useUserAuth();
  const user = overrideProfile || authUser;
  // Approved accounts get the shared partner portal (events, messages, requirements…).
  const portal = usePartnerPortal('vendor', ['overview', 'assignments', 'applications', 'profile', 'help'], { enabled: !readOnly && !demoData });
  const activeTab = portal.tab;
  const setActiveTab = portal.setTab;
  const [loading, setLoading] = useState(true);
  const [applications, setApplications] = useState([]);
  const [profile, setProfile] = useState(null);
  const [profileForm, setProfileForm] = useState({ business_name: '', category: '', gstin: '', phone: '', description: '' });
  const [profileMsg, setProfileMsg] = useState('');
  // A failed load or a refused change is shown, never mistaken for "nothing here" / success.
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [assignments, setAssignments] = useState([]);
  const [agentSent, setAgentSent] = useState(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    if (demoData) {
      setApplications(demoData.applications || []);
      setProfile(demoData.profile || null);
      if (demoData.profile) setProfileForm({ business_name: demoData.profile.business_name || '', category: demoData.profile.category || '', gstin: demoData.profile.gstin || '', phone: demoData.profile.phone || '', description: demoData.profile.description || '' });
      setAssignments(demoData.assignments || []);
      setLoading(false);
      return;
    }
    if (!isSupabaseConfigured) { setLoading(false); return; }

    const [{ data: apps, error: appsError }, { data: prof, error: profError }, { data: assigns, error: assignsError }] = await Promise.all([
      supabase.from('collaborations').select('*').eq('user_id', user.id).eq('type', 'vendor').order('created_at', { ascending: false }),
      supabase.from('vendor_profiles').select('*').eq('id', user.id).maybeSingle(),
      supabase
        .from('event_assignments')
        .select('*, events(name, event_date, event_time, venue)')
        .eq('assignee_id', user.id)
        .eq('assignee_role', 'vendor')
        .order('created_at', { ascending: false }),
    ]);

    setLoadError(loadFailed(appsError || profError || assignsError) || '');
    setApplications(apps || []);
    setProfile(prof || null);
    if (prof) setProfileForm({ business_name: prof.business_name || '', category: prof.category || '', gstin: prof.gstin || '', phone: prof.phone || '', description: prof.description || '' });
    setAssignments(assigns || []);
    setLoading(false);
  }, [user, demoData]);

  useEffect(() => { load(); }, [load]);

  const handleLogout = async () => { await logout(); navigate('/'); };

  const respond = async (id, status) => {
    if (readOnly) return;
    const r = await changeRows(supabase.from('event_assignments').update({ status }).eq('id', id), 'assignment response');
    setActionError(r.ok ? '' : r.message);
    load();
  };

  const saveProfile = async (e) => {
    e.preventDefault();
    if (readOnly) return;
    const r = await changeRows(supabase.from('vendor_profiles').update(profileForm).eq('id', user.id), 'profile save');
    setProfileMsg(r.ok ? '✓ SAVED' : r.message);
  };

  const upcoming = assignments.filter((a) => a.events?.event_date >= TODAY && a.status !== 'declined');
  const isApproved = applications.some((a) => a.status === 'approved');
  const portalMode = isApproved && !readOnly && !demoData;
  const tabs = portalMode
    ? [...partnerTabs('vendor'), ...TABS.filter((t) => ['applications', 'profile'].includes(t.id)).map((t) => ({ ...t, label: t.label.replace(/^[^A-Za-z]+/, '') }))]
    : TABS;

  if (loading || !user) {
    return <div className="min-h-screen ui-texture text-[#E7D5A4] flex items-center justify-center font-mono text-xs">LOADING VENDOR DASHBOARD...</div>;
  }

  return (
    <PortalShell
      icon="🍵"
      roleLabel="VENDOR ACCOUNT"
      title={profile?.business_name || user.full_name || user.email}
      subtitle={user.email}
      statusBadge={isApproved ? <Badge status="approved" /> : applications[0] ? <Badge status={applications[0].status} /> : null}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabHref={portal.hrefFor}
      onLogout={handleLogout}
      notificationsFor={portalMode ? user.id : null}
      preview={readOnly ? { label: `Viewing Vendor Portal — ${profile?.business_name || user.full_name || user.email}` } : undefined}
    >
      {(loadError || actionError) && (
        <div role="alert" data-dashboard-error className="mb-4 p-3 border border-[#ef4444]/60 bg-[#ef4444]/10 text-[#fca5a5] text-[11px] font-mono flex items-center gap-3">
          <span className="flex-1">{actionError || `Couldn't load your dashboard — ${loadError}`}</span>
          <button type="button" onClick={() => { setActionError(''); load(); }} className="px-3 py-1 border border-current uppercase text-[10px]">Retry</button>
        </div>
      )}
      {portalMode && <PartnerSection portal={portal} user={user} />}
      {!portalMode && activeTab === 'overview' && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {!isApproved && (
            <div className="sm:col-span-3"><Empty>YOUR VENDOR APPLICATION ISN'T APPROVED YET — CHECK THE APPLICATIONS TAB.</Empty></div>
          )}
          <StatTile label="Upcoming Events" value={upcoming.length} sub="sessions you're set up at" />
          <StatTile label="Total Assignments" value={assignments.length} sub="all time" />
          <StatTile label="Applications" value={applications.length} sub="submitted so far" />
        </div>
      )}

      {!portalMode && activeTab === 'assignments' && (
        <div className="flex flex-col gap-3">
          {assignments.length === 0 ? (
            <Empty>NO EVENT ASSIGNMENTS YET — YOU'LL SEE THEM HERE ONCE ADMIN SETS YOU UP AT A SESSION.</Empty>
          ) : assignments.map((a) => (
            <div key={a.id} className="bg-[#191410] border-2 border-[#C99A2E]/40 p-4">
              <div className="flex justify-between items-start gap-3">
                <div>
                  <h4 className="font-condensed font-bold uppercase">{a.events?.name}</h4>
                  <p className="font-mono text-[10px] text-[#E7D5A4]/70 mt-1">{fmtDate(a.events?.event_date)} · {a.events?.event_time} · {a.events?.venue}</p>
                  <p className="font-mono text-[10px] text-[#C99A2E] font-bold mt-1">{a.title}</p>
                </div>
                <Badge status={a.status} />
              </div>
              {a.status === 'assigned' && !readOnly && (
                <div className="flex gap-2 mt-3">
                  <button onClick={() => respond(a.id, 'confirmed')} className="flex-1 py-2 bg-[#10b981] text-[#11100C] text-[10px] font-bold uppercase">CONFIRM</button>
                  <button onClick={() => respond(a.id, 'declined')} className="flex-1 py-2 border border-[#ef4444]/60 text-[#ef4444] text-[10px] font-bold uppercase">DECLINE</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {activeTab === 'applications' && (
        <div className="flex flex-col gap-4">
          {applications.length === 0 ? (
            <Empty>NO VENDOR APPLICATION ON FILE YET. <Link to="/apply/vendors" className="text-[#C99A2E] underline">APPLY NOW →</Link></Empty>
          ) : applications.map((a) => (
            <div key={a.id} className="bg-[#191410] border-2 border-[#C99A2E]/40 p-5">
              <div className="flex justify-between items-start gap-3 mb-2">
                <div>
                  <h3 className="font-condensed text-lg font-bold uppercase">{a.business_name}</h3>
                  <p className="font-mono text-[10px] text-[#E7D5A4]/60 mt-1">Submitted {fmtDate(a.created_at)}</p>
                </div>
                <Badge status={a.status} />
              </div>
              {a.details && <p className="font-mono text-[11px] text-[#E7D5A4]/80 whitespace-pre-wrap border-t border-[#C99A2E]/20 pt-3">{a.details}</p>}
            </div>
          ))}
        </div>
      )}

      {activeTab === 'profile' && (
        !isApproved ? (
          <Empty>YOUR VENDOR PROFILE UNLOCKS ONCE YOUR APPLICATION IS APPROVED.</Empty>
        ) : (
          <form onSubmit={saveProfile} className="max-w-md bg-[#E7D5A4] text-[#11100C] border-2 border-[#11100C] p-6 shadow-[4px_4px_0px_#11100C] flex flex-col gap-4 text-xs">
            <div>
              <label className="block text-[10px] font-bold uppercase mb-1">Business name</label>
              <input disabled={readOnly} value={profileForm.business_name} onChange={(e) => { setProfileForm({ ...profileForm, business_name: e.target.value }); setProfileMsg(''); }} className="w-full p-3 bg-[#F5E9C9] border-2 border-[#11100C] outline-none disabled:opacity-60" />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase mb-1">Category</label>
              <input disabled={readOnly} value={profileForm.category} onChange={(e) => { setProfileForm({ ...profileForm, category: e.target.value }); setProfileMsg(''); }} className="w-full p-3 bg-[#F5E9C9] border-2 border-[#11100C] outline-none disabled:opacity-60" />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase mb-1">GSTIN</label>
              <input disabled={readOnly} value={profileForm.gstin} onChange={(e) => { setProfileForm({ ...profileForm, gstin: e.target.value }); setProfileMsg(''); }} className="w-full p-3 bg-[#F5E9C9] border-2 border-[#11100C] outline-none disabled:opacity-60" />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase mb-1">Phone</label>
              <input disabled={readOnly} value={profileForm.phone} onChange={(e) => { setProfileForm({ ...profileForm, phone: e.target.value }); setProfileMsg(''); }} className="w-full p-3 bg-[#F5E9C9] border-2 border-[#11100C] outline-none disabled:opacity-60" />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase mb-1">Description</label>
              <textarea disabled={readOnly} rows={3} value={profileForm.description} onChange={(e) => { setProfileForm({ ...profileForm, description: e.target.value }); setProfileMsg(''); }} className="w-full p-3 bg-[#F5E9C9] border-2 border-[#11100C] outline-none resize-none disabled:opacity-60" />
            </div>
            {profileMsg && <div role="status" className={profileMsg.startsWith('✓') ? 'p-2 bg-[#10b981]/20 border border-[#10b981]/40 text-[#0f5132] text-[10px] font-bold' : 'p-2 bg-[#ef4444]/15 border border-[#ef4444]/50 text-[#7f1d1d] text-[10px] font-bold'}>{profileMsg}</div>}
            {!readOnly && <button type="submit" className="py-3 bg-[#11100C] text-[#E7D5A4] hover:bg-[#B94717] font-bold uppercase tracking-widest border-2 border-[#11100C]">SAVE</button>}
          </form>
        )
      )}

      {!portalMode && activeTab === 'help' && (
        <div className="max-w-lg flex flex-col gap-4">
          {readOnly ? (
            <ReadOnlyNote>Messaging is disabled in admin preview.</ReadOnlyNote>
          ) : agentSent ? (
            <div className="p-4 bg-[#10b981]/20 border-2 border-[#10b981]/40 text-xs font-bold">✓ MESSAGE SENT — THE TANGY TEAM WILL REACH OUT.</div>
          ) : (
            <AgentRequestForm onCancel={() => {}} onSubmitted={() => setAgentSent(true)} />
          )}
        </div>
      )}
    </PortalShell>
  );
};
