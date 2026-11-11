import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useUserAuth } from '../../context/UserAuthContext';
import { supabase, isSupabaseConfigured } from '../../lib/supabaseClient';
import { changeRows, loadFailed } from '../../lib/mutation';
import { AgentRequestForm } from '../../components/ai/AgentRequestForm';
import { PortalShell, Badge, Empty, fmtDate, StatTile, ReadOnlyNote } from './portal/PortalUI';
import { usePartnerPortal, partnerTabs, PartnerSection } from '../../portal/PartnerPortal';

// Deliberately simpler than Crew — shifts (confirm/decline) + participation
// history, no task-priority breakdown. Same shared event_assignments table,
// filtered to assignee_role='volunteer' (see 0011_role_portals.sql).
const TABS = [
  { id: 'overview', label: '📊 OVERVIEW' },
  { id: 'shifts', label: '📌 MY SHIFTS' },
  { id: 'history', label: '🏅 PARTICIPATION HISTORY' },
  { id: 'applications', label: '📋 APPLICATIONS' },
  { id: 'profile', label: '🤝 PROFILE' },
  { id: 'help', label: '✦ HELP' },
];

const TODAY = new Date().toISOString().slice(0, 10);

// `overrideProfile` + `readOnly` are set only by the admin preview route
// (src/pages/admin/AdminPortalPreview.jsx) — see the identical note in
// CrewDashboard.jsx for the security reasoning (RLS-backed, no impersonation).
// `demoData` ({ applications, profile, assignments }) is set only by the
// demo-admin build (src/pages/demoAdmin/DemoRoleDashboard.jsx) — when
// present, this skips every real Supabase call below. See demoAdminData.js.
export const VolunteerDashboard = ({ overrideProfile, readOnly, demoData } = {}) => {
  const navigate = useNavigate();
  const { user: authUser, logout } = useUserAuth();
  const user = overrideProfile || authUser;
  // Approved accounts get the shared partner portal (events, messages, requirements…).
  const portal = usePartnerPortal('volunteer', ['overview', 'shifts', 'history', 'applications', 'profile', 'help'], { enabled: !readOnly && !demoData });
  const activeTab = portal.tab;
  const setActiveTab = portal.setTab;
  const [loading, setLoading] = useState(true);
  const [applications, setApplications] = useState([]);
  const [profileForm, setProfileForm] = useState({ availability: '', skills: '', emergency_contact: '' });
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
      if (demoData.profile) setProfileForm({ availability: demoData.profile.availability || '', skills: demoData.profile.skills || '', emergency_contact: demoData.profile.emergency_contact || '' });
      setAssignments(demoData.assignments || []);
      setLoading(false);
      return;
    }
    if (!isSupabaseConfigured) { setLoading(false); return; }

    const [{ data: apps, error: appsError }, { data: prof, error: profError }, { data: assigns, error: assignsError }] = await Promise.all([
      supabase.from('crew_applications').select('*').eq('user_id', user.id).eq('category', 'volunteer').order('created_at', { ascending: false }),
      supabase.from('volunteer_profiles').select('*').eq('id', user.id).maybeSingle(),
      supabase
        .from('event_assignments')
        .select('*, events(name, event_date, event_time, venue)')
        .eq('assignee_id', user.id)
        .eq('assignee_role', 'volunteer')
        .order('created_at', { ascending: false }),
    ]);

    setLoadError(loadFailed(appsError || profError || assignsError) || '');
    setApplications(apps || []);
    if (prof) setProfileForm({ availability: prof.availability || '', skills: prof.skills || '', emergency_contact: prof.emergency_contact || '' });
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
    const r = await changeRows(supabase.from('volunteer_profiles').update(profileForm).eq('id', user.id), 'profile save');
    setProfileMsg(r.ok ? '✓ SAVED' : r.message);
  };

  const upcomingShifts = assignments.filter((a) => a.events?.event_date >= TODAY && a.status !== 'declined');
  const history = assignments.filter((a) => a.status === 'completed' || (a.events?.event_date < TODAY && a.status === 'confirmed'));
  const isApproved = applications.some((a) => a.status === 'approved');
  const portalMode = isApproved && !readOnly && !demoData;
  const tabs = portalMode
    ? [...partnerTabs('volunteer'), ...TABS.filter((t) => ['shifts', 'history', 'applications', 'profile', 'help'].includes(t.id)).map((t) => ({ ...t, label: t.label.replace(/^[^A-Za-z]+/, '') }))]
    : TABS;

  if (loading || !user) {
    return <div className="min-h-screen ui-texture text-[#E7D5A4] flex items-center justify-center font-mono text-xs">LOADING VOLUNTEER DASHBOARD...</div>;
  }

  return (
    <PortalShell
      icon="🤝"
      roleLabel="VOLUNTEER ACCOUNT"
      title={user.full_name || user.email}
      subtitle={user.email}
      statusBadge={isApproved ? <Badge status="approved" /> : applications[0] ? <Badge status={applications[0].status} /> : null}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabHref={portal.hrefFor}
      onLogout={handleLogout}
      notificationsFor={portalMode ? user.id : null}
      preview={readOnly ? { label: `Viewing Volunteer Portal — ${user.full_name || user.email}` } : undefined}
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
            <div className="sm:col-span-3"><Empty>YOUR VOLUNTEER APPLICATION ISN'T APPROVED YET — CHECK THE APPLICATIONS TAB.</Empty></div>
          )}
          <StatTile label="Upcoming Shifts" value={upcomingShifts.length} sub="events you've signed up for" />
          <StatTile label="Sessions Volunteered" value={history.length} sub="participation on record" />
          <StatTile label="Applications" value={applications.length} sub="submitted so far" />
        </div>
      )}

      {activeTab === 'shifts' && (
        <div className="flex flex-col gap-3">
          {upcomingShifts.length === 0 ? (
            <Empty>NO UPCOMING SHIFTS — YOU'LL SEE THEM HERE ONCE ADMIN ASSIGNS YOU TO AN EVENT.</Empty>
          ) : upcomingShifts.map((a) => (
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
                  <button onClick={() => respond(a.id, 'confirmed')} className="flex-1 py-2 bg-[#10b981] text-[#11100C] text-[10px] font-bold uppercase">I'M IN</button>
                  <button onClick={() => respond(a.id, 'declined')} className="flex-1 py-2 border border-[#ef4444]/60 text-[#ef4444] text-[10px] font-bold uppercase">CAN'T MAKE IT</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {activeTab === 'history' && (
        history.length === 0 ? <Empty>NO PAST PARTICIPATION ON RECORD YET.</Empty> : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {history.map((a) => (
              <div key={a.id} className="bg-[#191410] border-2 border-[#C99A2E]/30 p-3">
                <h4 className="font-condensed font-bold uppercase">{a.events?.name}</h4>
                <p className="font-mono text-[10px] text-[#E7D5A4]/70 mt-1">{fmtDate(a.events?.event_date)} · {a.title}</p>
                <Badge status={a.status} />
              </div>
            ))}
          </div>
        )
      )}

      {activeTab === 'applications' && (
        <div className="flex flex-col gap-4">
          {applications.length === 0 ? (
            <Empty>NO VOLUNTEER APPLICATION ON FILE YET. <Link to="/volunteer/apply" className="text-[#C99A2E] underline">APPLY NOW →</Link></Empty>
          ) : applications.map((a) => (
            <div key={a.id} className="bg-[#191410] border-2 border-[#C99A2E]/40 p-5">
              <div className="flex justify-between items-start gap-3 mb-2">
                <div>
                  <h3 className="font-condensed text-lg font-bold uppercase">{a.role_interest}</h3>
                  <p className="font-mono text-[10px] text-[#E7D5A4]/60 mt-1">Submitted {fmtDate(a.created_at)}</p>
                </div>
                <Badge status={a.status} />
              </div>
              {a.message && <p className="font-mono text-[11px] text-[#E7D5A4]/80 whitespace-pre-wrap border-t border-[#C99A2E]/20 pt-3">{a.message}</p>}
            </div>
          ))}
        </div>
      )}

      {activeTab === 'profile' && (
        !isApproved ? (
          <Empty>YOUR VOLUNTEER PROFILE UNLOCKS ONCE YOUR APPLICATION IS APPROVED.</Empty>
        ) : (
          <form onSubmit={saveProfile} className="max-w-md bg-[#E7D5A4] text-[#11100C] border-2 border-[#11100C] p-6 shadow-[4px_4px_0px_#11100C] flex flex-col gap-4 text-xs">
            <div>
              <label className="block text-[10px] font-bold uppercase mb-1">Availability</label>
              <input disabled={readOnly} value={profileForm.availability} onChange={(e) => { setProfileForm({ ...profileForm, availability: e.target.value }); setProfileMsg(''); }} className="w-full p-3 bg-[#F5E9C9] border-2 border-[#11100C] outline-none disabled:opacity-60" />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase mb-1">Skills / interests</label>
              <input disabled={readOnly} value={profileForm.skills} onChange={(e) => { setProfileForm({ ...profileForm, skills: e.target.value }); setProfileMsg(''); }} className="w-full p-3 bg-[#F5E9C9] border-2 border-[#11100C] outline-none disabled:opacity-60" />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase mb-1">Emergency contact</label>
              <input disabled={readOnly} value={profileForm.emergency_contact} onChange={(e) => { setProfileForm({ ...profileForm, emergency_contact: e.target.value }); setProfileMsg(''); }} className="w-full p-3 bg-[#F5E9C9] border-2 border-[#11100C] outline-none disabled:opacity-60" />
            </div>
            {profileMsg && <div role="status" className={profileMsg.startsWith('✓') ? 'p-2 bg-[#10b981]/20 border border-[#10b981]/40 text-[#0f5132] text-[10px] font-bold' : 'p-2 bg-[#ef4444]/15 border border-[#ef4444]/50 text-[#7f1d1d] text-[10px] font-bold'}>{profileMsg}</div>}
            {!readOnly && <button type="submit" className="py-3 bg-[#11100C] text-[#E7D5A4] hover:bg-[#B94717] font-bold uppercase tracking-widest border-2 border-[#11100C]">SAVE</button>}
          </form>
        )
      )}

      {activeTab === 'help' && (
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
