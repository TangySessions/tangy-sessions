import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useUserAuth } from '../../context/UserAuthContext';
import { supabase, isSupabaseConfigured } from '../../lib/supabaseClient';
import { changeRows, loadFailed } from '../../lib/mutation';
import { AgentRequestForm } from '../../components/ai/AgentRequestForm';
import { PortalShell, Badge, Empty, fmtDate, StatTile, ReadOnlyNote } from './portal/PortalUI';
import { usePortalTab } from '../../portal/PortalSections';

const TABS = [
  { id: 'overview', label: '📊 OVERVIEW' },
  { id: 'assignments', label: '📌 MY ASSIGNMENTS' },
  { id: 'tasks', label: '✅ TASKS' },
  { id: 'schedule', label: '🕓 SCHEDULE' },
  { id: 'applications', label: '📋 APPLICATIONS' },
  { id: 'profile', label: '🎬 PROFILE' },
  { id: 'help', label: '✦ MESSAGES' },
];

const TODAY = new Date().toISOString().slice(0, 10);

// `overrideProfile` ({ id, full_name, email }) + `readOnly` are set only by
// the admin preview route (src/pages/admin/AdminPortalPreview.jsx) — this
// component otherwise behaves exactly as before, reading the real signed-in
// user. Queries always run under the ACTUAL authenticated session; when an
// admin is previewing, RLS already grants them read access to every table
// here via existing is_admin()/is_staff_or_admin() policies, so no
// impersonation or role change is involved — see 0011_role_portals.sql.
// `demoData` ({ applications, profile, assignments }) is set only by the
// demo-admin build (src/pages/demoAdmin/DemoRoleDashboard.jsx) — when
// present, this skips every real Supabase call below. See demoAdminData.js.
export const CrewDashboard = ({ overrideProfile, readOnly, demoData } = {}) => {
  const navigate = useNavigate();
  const { user: authUser, logout } = useUserAuth();
  const user = overrideProfile || authUser;
  const portal = usePortalTab('overview', TABS.map((t) => t.id));
  const activeTab = portal.tab;
  const setActiveTab = portal.setTab;
  const [loading, setLoading] = useState(true);
  const [applications, setApplications] = useState([]);
  const [profileForm, setProfileForm] = useState({ department: '', shift_preference: '', certifications: '' });
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
      if (demoData.profile) setProfileForm({ department: demoData.profile.department || '', shift_preference: demoData.profile.shift_preference || '', certifications: demoData.profile.certifications || '' });
      setAssignments(demoData.assignments || []);
      setLoading(false);
      return;
    }
    if (!isSupabaseConfigured) { setLoading(false); return; }

    const [{ data: apps, error: appsError }, { data: prof, error: profError }, { data: assigns, error: assignsError }] = await Promise.all([
      supabase.from('crew_applications').select('*').eq('user_id', user.id).eq('category', 'crew').order('created_at', { ascending: false }),
      supabase.from('crew_profiles').select('*').eq('id', user.id).maybeSingle(),
      supabase
        .from('event_assignments')
        .select('*, events(name, event_date, event_time, venue), event_tasks(*)')
        .eq('assignee_id', user.id)
        .eq('assignee_role', 'crew')
        .order('created_at', { ascending: false }),
    ]);

    setLoadError(loadFailed(appsError || profError || assignsError) || '');
    setApplications(apps || []);
    if (prof) setProfileForm({ department: prof.department || '', shift_preference: prof.shift_preference || '', certifications: prof.certifications || '' });
    setAssignments(assigns || []);
    setLoading(false);
  }, [user, demoData]);

  useEffect(() => { load(); }, [load]);

  const handleLogout = async () => { await logout(); navigate('/'); };

  const respondToAssignment = async (id, status) => {
    if (readOnly) return;
    const r = await changeRows(supabase.from('event_assignments').update({ status }).eq('id', id), 'assignment response');
    setActionError(r.ok ? '' : r.message);
    load();
  };

  const setTaskStatus = async (id, status) => {
    if (readOnly) return;
    const r = await changeRows(supabase.from('event_tasks').update({ status }).eq('id', id), 'task status');
    setActionError(r.ok ? '' : r.message);
    load();
  };

  const saveProfile = async (e) => {
    e.preventDefault();
    if (readOnly) return;
    const r = await changeRows(supabase.from('crew_profiles').update(profileForm).eq('id', user.id), 'profile save');
    setProfileMsg(r.ok ? '✓ SAVED' : r.message);
  };

  const upcoming = assignments.filter((a) => a.events?.event_date >= TODAY && a.status !== 'declined');
  const past = assignments.filter((a) => a.events?.event_date < TODAY || a.status === 'completed');
  const allTasks = assignments.flatMap((a) => (a.event_tasks || []).map((t) => ({ ...t, eventName: a.events?.name })));
  const pendingTasks = allTasks.filter((t) => t.status !== 'done');
  const doneTasks = allTasks.filter((t) => t.status === 'done');
  const isApproved = applications.some((a) => a.status === 'approved');

  if (loading || !user) {
    return (
      <div className="min-h-screen ui-texture text-[#E7D5A4] flex items-center justify-center font-mono text-xs">LOADING CREW DASHBOARD...</div>
    );
  }

  return (
    <PortalShell
      icon="🎬"
      roleLabel="CREW ACCOUNT"
      title={user.full_name || user.email}
      subtitle={user.email}
      statusBadge={isApproved ? <Badge status="approved" /> : applications[0] ? <Badge status={applications[0].status} /> : null}
      tabs={TABS}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabHref={portal.hrefFor}
      onLogout={handleLogout}
      preview={readOnly ? { label: `Viewing Crew Portal — ${user.full_name || user.email}` } : undefined}
    >
      {(loadError || actionError) && (
        <div role="alert" data-dashboard-error className="mb-4 p-3 border border-[#ef4444]/60 bg-[#ef4444]/10 text-[#fca5a5] text-[11px] font-mono flex items-center gap-3">
          <span className="flex-1">{actionError || `Couldn't load your dashboard — ${loadError}`}</span>
          <button type="button" onClick={() => { setActionError(''); load(); }} className="px-3 py-1 border border-current uppercase text-[10px]">Retry</button>
        </div>
      )}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {!isApproved && (
            <div className="sm:col-span-3">
              <Empty>YOUR CREW APPLICATION ISN'T APPROVED YET — CHECK THE APPLICATIONS TAB FOR STATUS.</Empty>
            </div>
          )}
          <StatTile label="Upcoming Assignments" value={upcoming.length} sub="events you're staffing" />
          <StatTile label="Pending Tasks" value={pendingTasks.length} sub="across all assignments" />
          <StatTile label="Completed Tasks" value={doneTasks.length} sub="done so far" />
          <div className="sm:col-span-3 bg-[#191410] border-2 border-[#C99A2E]/40 p-5">
            <h3 className="font-condensed text-lg font-bold uppercase mb-3 text-[#C99A2E]">Next up</h3>
            {upcoming.length === 0 ? (
              <Empty>NO UPCOMING ASSIGNMENTS.</Empty>
            ) : (
              <div className="bg-[#E7D5A4] text-[#11100C] border-2 border-[#11100C] p-3">
                <h4 className="font-condensed font-bold uppercase">{upcoming[0].events?.name} — {upcoming[0].title}</h4>
                <p className="font-mono text-[10px] mt-1">{fmtDate(upcoming[0].events?.event_date)} · {upcoming[0].events?.event_time} · {upcoming[0].events?.venue}</p>
                <Badge status={upcoming[0].status} />
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'assignments' && (
        <div className="flex flex-col gap-3">
          {assignments.length === 0 ? (
            <Empty>NO ASSIGNMENTS YET — YOU'LL SEE EVENTS HERE ONCE ADMIN STAFFS YOU FOR ONE.</Empty>
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
                  <button onClick={() => respondToAssignment(a.id, 'confirmed')} className="flex-1 py-2 bg-[#10b981] text-[#11100C] text-[10px] font-bold uppercase">CONFIRM</button>
                  <button onClick={() => respondToAssignment(a.id, 'declined')} className="flex-1 py-2 border border-[#ef4444]/60 text-[#ef4444] text-[10px] font-bold uppercase">DECLINE</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {activeTab === 'tasks' && (
        <div className="flex flex-col gap-3">
          {allTasks.length === 0 ? (
            <Empty>NO TASKS ON FILE.</Empty>
          ) : allTasks.map((t) => (
            <div key={t.id} className="bg-[#191410] border-2 border-[#C99A2E]/40 p-4 flex justify-between items-center gap-3">
              <div>
                <div className="font-mono text-xs font-bold">{t.title}</div>
                <div className="font-mono text-[10px] text-[#E7D5A4]/60 mt-1">{t.eventName} {t.due_at ? `· due ${fmtDate(t.due_at)}` : ''} · priority: {t.priority}</div>
              </div>
              {readOnly ? <Badge status={t.status} /> : (
                <select value={t.status} onChange={(e) => setTaskStatus(t.id, e.target.value)} className="bg-[#11100C] border border-[#C99A2E]/40 text-[10px] px-2 py-1.5">
                  <option value="pending">Pending</option>
                  <option value="in_progress">In progress</option>
                  <option value="done">Done</option>
                </select>
              )}
            </div>
          ))}
        </div>
      )}

      {activeTab === 'schedule' && (
        <div className="flex flex-col gap-6">
          <div>
            <h3 className="font-condensed text-lg font-bold uppercase mb-3">Upcoming</h3>
            {upcoming.length === 0 ? <Empty>NOTHING SCHEDULED.</Empty> : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {upcoming.map((a) => (
                  <div key={a.id} className="bg-[#E7D5A4] text-[#11100C] border-2 border-[#11100C] p-3">
                    <h4 className="font-condensed font-bold uppercase">{a.events?.name}</h4>
                    <p className="font-mono text-[10px] mt-1">{fmtDate(a.events?.event_date)} · {a.title}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <h3 className="font-condensed text-lg font-bold uppercase mb-3">Past</h3>
            {past.length === 0 ? <Empty>NO PAST ASSIGNMENTS ON RECORD.</Empty> : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {past.map((a) => (
                  <div key={a.id} className="bg-[#191410] border-2 border-[#C99A2E]/30 p-3">
                    <h4 className="font-condensed font-bold uppercase">{a.events?.name}</h4>
                    <p className="font-mono text-[10px] text-[#E7D5A4]/70 mt-1">{fmtDate(a.events?.event_date)} · {a.title}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'applications' && (
        <div className="flex flex-col gap-4">
          {applications.length === 0 ? (
            <Empty>NO CREW APPLICATION ON FILE YET. <Link to="/crew/apply" className="text-[#C99A2E] underline">APPLY NOW →</Link></Empty>
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
          <Empty>YOUR CREW PROFILE UNLOCKS ONCE YOUR APPLICATION IS APPROVED.</Empty>
        ) : (
          <form onSubmit={saveProfile} className="max-w-md bg-[#E7D5A4] text-[#11100C] border-2 border-[#11100C] p-6 shadow-[4px_4px_0px_#11100C] flex flex-col gap-4 text-xs">
            <div>
              <label className="block text-[10px] font-bold uppercase mb-1">Department</label>
              <input disabled={readOnly} value={profileForm.department} onChange={(e) => { setProfileForm({ ...profileForm, department: e.target.value }); setProfileMsg(''); }} className="w-full p-3 bg-[#F5E9C9] border-2 border-[#11100C] outline-none disabled:opacity-60" />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase mb-1">Shift preference</label>
              <input disabled={readOnly} value={profileForm.shift_preference} onChange={(e) => { setProfileForm({ ...profileForm, shift_preference: e.target.value }); setProfileMsg(''); }} className="w-full p-3 bg-[#F5E9C9] border-2 border-[#11100C] outline-none disabled:opacity-60" />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase mb-1">Certifications</label>
              <textarea disabled={readOnly} rows={3} value={profileForm.certifications} onChange={(e) => { setProfileForm({ ...profileForm, certifications: e.target.value }); setProfileMsg(''); }} className="w-full p-3 bg-[#F5E9C9] border-2 border-[#11100C] outline-none resize-none disabled:opacity-60" />
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
