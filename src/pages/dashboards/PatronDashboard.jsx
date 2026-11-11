import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Navbar } from '../../components/layout/Navbar';
import { Footer } from '../../components/layout/Footer';
import { ArchiveStamp } from '../../components/ui/ArchiveStamp';
import { useUserAuth } from '../../context/UserAuthContext';
import { bookingService } from '../../lib/bookingService';
import { generateQrDataUrl } from '../../lib/qr';
import { supabase, isSupabaseConfigured } from '../../lib/supabaseClient';
import { AgentRequestForm } from '../../components/ai/AgentRequestForm';
import { AdminPreviewBanner, ReadOnlyNote } from './portal/PortalUI';
import { usePortalTab } from '../../portal/PortalSections';

const STATUS_COLORS = {
  confirmed: 'bg-[#10b981]/20 text-[#10b981] border-[#10b981]/40',
  paid: 'bg-[#10b981]/20 text-[#10b981] border-[#10b981]/40',
  pending: 'bg-[#f59e0b]/20 text-[#f59e0b] border-[#f59e0b]/40',
  failed: 'bg-[#ef4444]/20 text-[#ef4444] border-[#ef4444]/40',
  cancelled: 'bg-[#ef4444]/20 text-[#ef4444] border-[#ef4444]/40',
  refunded: 'bg-[#ef4444]/20 text-[#ef4444] border-[#ef4444]/40',
};

const STATUS_LABELS = {
  confirmed: 'CONFIRMED',
  paid: 'CONFIRMED',
  pending: 'PAYMENT PENDING',
  failed: 'PAYMENT FAILED',
  cancelled: 'CANCELLED',
  refunded: 'REFUNDED',
};

const Badge = ({ status }) => (
  <span className={`px-2 py-0.5 text-[9px] font-bold uppercase border ${STATUS_COLORS[status] || 'bg-[#E7D5A4]/10 text-[#E7D5A4] border-[#E7D5A4]/30'}`}>
    {STATUS_LABELS[status] || status}
  </span>
);

// QR images are generated client-side from an opaque random token (the
// booking's group_token here — never the registration_code, a database id or
// a name). Tickets only exist once a booking is genuinely confirmed
// server-side, so a pending/failed booking has nothing to show at all.
const TicketQr = ({ token, kind = 'TICKET', size = 'w-20 h-20' }) => {
  const [qr, setQr] = useState('');
  useEffect(() => {
    let cancelled = false;
    generateQrDataUrl(`TANGY:${kind}:${token}`).then((url) => { if (!cancelled) setQr(url); });
    return () => { cancelled = true; };
  }, [token, kind]);
  if (!qr) return <div className={`${size} bg-[#11100C]/10 animate-pulse`} />;
  return <img src={qr} alt={kind === 'BOOKING' ? 'Group pass QR code' : 'Ticket QR code'} className={`${size} border-2 border-[#11100C]`} />;
};

const TicketList = ({ booking, showQr = true }) => {
  if (booking.status !== 'confirmed' && booking.status !== 'paid') return null;
  const tickets = [...(booking.tickets || [])].sort((a, b) => a.ticket_number.localeCompare(b.ticket_number));
  if (tickets.length === 0) {
    return <p className="font-mono text-[9px] text-[#B94717] mt-2">Issuing tickets — check back in a moment.</p>;
  }
  const active = tickets.filter((t) => t.status !== 'cancelled');
  const arrived = active.filter((t) => t.status === 'checked_in').length;
  // ONE QR for the whole booking (0023): it identifies the booking only; staff
  // check each named attendee in after scanning, however the party arrives.
  return (
    <div className="flex flex-col sm:flex-row gap-3 bg-[#11100C]/5 border-2 border-[#11100C]/40 p-3 mt-3" data-booking-pass>
      {showQr && booking.group_token && <TicketQr token={booking.group_token} kind="BOOKING" size="w-32 h-32" />}
      <div className="flex flex-col gap-1 min-w-0 flex-1">
        <span className="font-mono text-[10px] font-bold uppercase">{active.length} attendee{active.length === 1 ? '' : 's'} · {arrived} / {active.length} checked in</span>
        {showQr && <span className="font-mono text-[9px] text-[#11100C]/70">Show this QR at the entrance — everyone on the booking uses it, and it works again for anyone arriving later.</span>}
        <ol className="flex flex-col gap-0.5 mt-1" aria-label="Attendees">
          {tickets.map((t, i) => (
            <li key={t.id} className={`flex items-center justify-between gap-2 font-mono text-[10px] ${t.status === 'cancelled' ? 'line-through opacity-50' : ''}`}>
              <span className="truncate">{t.attendee_name || `Guest ${i + 1}`}</span>
              <span className="uppercase text-[9px] text-[#B94717] shrink-0">{t.status === 'checked_in' ? '✓ Checked in' : t.status === 'cancelled' ? 'Cancelled' : 'Pending'}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
};

const fmtDate = (d) => {
  if (!d) return '—';
  try {
    return new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return d;
  }
};

const BOOKINGS_UNAVAILABLE = 'YOUR BOOKINGS COULD NOT BE LOADED — TRY AGAIN ABOVE.';

const Empty = ({ children }) => (
  <div className="p-8 text-center font-mono text-[11px] font-bold text-[#E7D5A4]/60 border-2 border-dashed border-[#C99A2E]/30">
    {children}
  </div>
);

const TABS = [
  { id: 'overview', label: '🎫 OVERVIEW' },
  { id: 'passport', label: '📖 PASSPORT' },
  { id: 'bookings', label: '🎟️ BOOKINGS' },
  { id: 'waitlist', label: '⏳ WAITLIST' },
  { id: 'settings', label: '⚙ SETTINGS' },
  { id: 'help', label: '✦ HELP' },
];

// `overrideProfile` + `readOnly` are set only by the admin preview route
// (src/pages/admin/AdminPortalPreview.jsx). Queries always run under the
// ACTUAL authenticated session; admin read access to another patron's
// bookings/waitlist is already granted by existing RLS
// ("bookings: staff/admin full access", "waitlist: staff/admin read" —
// see 0002_rls.sql) — no impersonation, no role change.
// `demoData` ({ bookings, waitlist }) is set only by the demo-admin build
// (src/pages/demoAdmin/DemoRoleDashboard.jsx) — when present, this skips
// every real Supabase call below entirely. See demoAdminData.js.
export const PatronDashboard = ({ overrideProfile, readOnly, demoData } = {}) => {
  const navigate = useNavigate();
  const { user: authUser, logout } = useUserAuth();
  const user = overrideProfile || authUser;
  const portal = usePortalTab('overview', TABS.map((t) => t.id));
  const activeTab = portal.tab;
  const [loading, setLoading] = useState(true);
  const [bookings, setBookings] = useState([]);
  const [bookingsError, setBookingsError] = useState('');
  const [waitlist, setWaitlist] = useState([]);
  // A failed waitlist read is shown as such — an offer is time-limited, so
  // "not on any waitlist" must only ever mean exactly that.
  const [waitlistError, setWaitlistError] = useState(false);
  const [settingsForm, setSettingsForm] = useState({ fullName: '', phone: '' });
  const [savedMsg, setSavedMsg] = useState('');
  const [pwForm, setPwForm] = useState({ next: '', confirm: '' });
  const [pwMsg, setPwMsg] = useState('');
  const [agentSent, setAgentSent] = useState(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    if (demoData) {
      setBookings(demoData.bookings || []);
      setWaitlist(demoData.waitlist || []);
      setLoading(false);
      return;
    }
    // A failed request is shown as such — never as "no bookings".
    setBookingsError('');
    try {
      setBookings(await bookingService.getMyBookings(user.id));
    } catch (err) {
      setBookings([]);
      setBookingsError(err.message);
    }
    if (isSupabaseConfigured) {
      // Own dashboard: my_waitlist() (position + offer, 0027). Admin preview
      // of someone else's dashboard reads their rows directly (staff RLS).
      if (readOnly) {
        const { data, error: wlError } = await supabase.from('waitlist').select('id, status, quantity, offer_expires_at, events(name, slug, event_date, venue)')
          .eq('user_id', user.id).in('status', ['waiting', 'offered']);
        setWaitlistError(!!wlError);
        setWaitlist((data || []).map((w) => ({ ...w, event_name: w.events?.name, event_slug: w.events?.slug, event_date: w.events?.event_date, venue: w.events?.venue })));
      } else {
        const { data, error: wlError } = await supabase.rpc('my_waitlist');
        if (wlError) console.error('[tangy] my_waitlist failed', wlError);
        setWaitlistError(!!wlError);
        setWaitlist((data || []).filter((w) => ['waiting', 'offered'].includes(w.status)));
      }
    }
    setLoading(false);
  }, [user, demoData, readOnly]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setSettingsForm({ fullName: user?.full_name || '', phone: user?.phone || '' });
  }, [user]);

  // Failed / expired checkout attempts were never bookings — don't list them.
  const upcomingBookings = bookings
    .filter((b) => b.events && !['cancelled', 'failed', 'expired'].includes(b.status))
    .filter((b) => !b.events.event_date || b.events.event_date >= new Date().toISOString().slice(0, 10))
    .sort((a, b) => (a.events?.event_date || '').localeCompare(b.events?.event_date || ''));

  const pastBookings = bookings.filter((b) => b.events?.event_date && b.events.event_date < new Date().toISOString().slice(0, 10) && !['failed', 'expired'].includes(b.status));

  const stampsCount = bookings.filter((b) => b.status === 'confirmed' || b.status === 'paid').length;
  const passportId = user?.passport_id || '—';
  const memberSince = user?.member_since;

  const handleLogout = async () => {
    await logout();
    navigate('/');
  };

  const handleSettingsSave = async (e) => {
    e.preventDefault();
    if (readOnly) return;
    setSavedMsg('');
    if (!isSupabaseConfigured) return;
    const { error } = await supabase.from('profiles').update({ full_name: settingsForm.fullName, phone: settingsForm.phone }).eq('id', user.id);
    setSavedMsg(error ? 'Could not save — please try again.' : '✓ SAVED');
  };

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    if (readOnly) return;
    setPwMsg('');
    if (pwForm.next !== pwForm.confirm) {
      setPwMsg('Passwords do not match.');
      return;
    }
    const { error } = await supabase.auth.updateUser({ password: pwForm.next });
    setPwMsg(error ? error.message : '✓ PASSWORD UPDATED');
    if (!error) setPwForm({ next: '', confirm: '' });
  };

  if (loading || !user) {
    return (
      <div className="min-h-screen ui-texture text-[#E7D5A4] flex items-center justify-center font-mono text-xs">
        LOADING PASSPORT...
      </div>
    );
  }

  return (
    <div className="min-h-screen ui-texture text-[#E7D5A4] font-mono selection:bg-[#C99A2E] selection:text-[#11100C] overflow-x-hidden">
      <Navbar />
      {readOnly && <AdminPreviewBanner label={`Viewing Patron Portal — ${user.full_name || user.email}`} />}

      <section className="pt-24 sm:pt-28 pb-4 px-4 sm:px-6 max-w-6xl mx-auto">
        <div className="bg-[#191410] border-2 border-[#C99A2E] p-4 sm:p-6 shadow-[4px_4px_0px_#11100C] flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 shrink-0 bg-[#E7D5A4] text-[#11100C] rounded-full border-2 border-[#B94717] flex flex-col items-center justify-center text-center">
              <span className="font-condensed text-base font-bold leading-none">TS</span>
              <span className="font-mono text-[6px] font-bold">PATRON</span>
            </div>
            <div>
              <span className="font-mono text-[9px] font-bold text-[#C99A2E] uppercase tracking-widest block">
                MEMBER PASSPORT NO. {passportId}
              </span>
              <h1 className="font-condensed text-xl sm:text-2xl font-bold uppercase">{user.full_name || user.email}</h1>
              <span className="font-mono text-[10px] text-[#E7D5A4]/60">{user.email} · Member since {fmtDate(memberSince?.slice ? memberSince.slice(0, 10) : memberSince)}</span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Link to="/ai" className="border border-[#C99A2E]/60 text-[#E7D5A4] hover:bg-[#C99A2E]/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider">
              ✦ ASK TANGY AI
            </Link>
            {!readOnly && (
              <button onClick={handleLogout} className="bg-[#B94717] text-[#E7D5A4] hover:bg-[#11100C] border border-[#B94717] px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider">
                LOG OUT ✕
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="px-4 sm:px-6 max-w-6xl mx-auto">
        <nav aria-label="Dashboard sections" className="flex flex-wrap gap-2 border-b-2 border-[#C99A2E]/40 pb-3 mb-6">
          {TABS.map((tab) => (
            <Link
              key={tab.id}
              to={portal.hrefFor(tab.id)}
              aria-current={activeTab === tab.id ? 'page' : undefined}
              className={`inline-flex items-center min-h-[36px] px-3 py-2 text-[10px] sm:text-xs font-bold tracking-wider uppercase border transition-colors ${
                activeTab === tab.id ? 'bg-[#C99A2E] text-[#11100C] border-[#C99A2E] shadow-[3px_3px_0px_#11100C]' : 'bg-[#191410] text-[#E7D5A4]/80 border-[#C99A2E]/30 hover:border-[#C99A2E]'
              }`}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </section>

      <section className="px-4 sm:px-6 max-w-6xl mx-auto pb-20">
        {bookingsError && (
          <div role="alert" className="mb-4 p-4 border-2 border-[#B94717] bg-[#191410] font-mono text-[11px] font-bold text-[#E7D5A4] flex flex-wrap items-center justify-between gap-3">
            <span>{bookingsError}</span>
            <button type="button" onClick={load} className="border-2 border-[#C99A2E] px-3 py-1 uppercase hover:bg-[#C99A2E] hover:text-[#11100C]">Try again</button>
          </div>
        )}
        {activeTab === 'overview' && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-[#E7D5A4] text-[#11100C] border-2 border-[#11100C] p-5 shadow-[4px_4px_0px_#11100C]">
              <span className="font-mono text-[9px] font-bold uppercase text-[#B94717]">Passport Stamps</span>
              <div className="font-condensed text-4xl font-bold mt-1">{bookingsError ? '—' : stampsCount}</div>
              <p className="font-mono text-[10px] text-[#11100C]/60 mt-1">confirmed bookings</p>
            </div>
            <div className="bg-[#E7D5A4] text-[#11100C] border-2 border-[#11100C] p-5 shadow-[4px_4px_0px_#11100C]">
              <span className="font-mono text-[9px] font-bold uppercase text-[#B94717]">Upcoming Bookings</span>
              <div className="font-condensed text-4xl font-bold mt-1">{bookingsError ? '—' : upcomingBookings.length}</div>
              <p className="font-mono text-[10px] text-[#11100C]/60 mt-1">tickets on file</p>
            </div>
            <div className="bg-[#E7D5A4] text-[#11100C] border-2 border-[#11100C] p-5 shadow-[4px_4px_0px_#11100C]">
              <span className="font-mono text-[9px] font-bold uppercase text-[#B94717]">Waitlist</span>
              <div className="font-condensed text-4xl font-bold mt-1">{waitlistError ? '—' : waitlist.length}</div>
              <p className="font-mono text-[10px] text-[#11100C]/60 mt-1">sessions you're waiting on</p>
            </div>
            <div className="sm:col-span-3 bg-[#191410] border-2 border-[#C99A2E]/40 p-5">
              <h3 className="font-condensed text-lg font-bold uppercase mb-3 text-[#C99A2E]">Next up</h3>
              {upcomingBookings.length === 0 ? (
                <Empty>{bookingsError ? BOOKINGS_UNAVAILABLE : 'NO UPCOMING BOOKINGS YET — BROWSE SESSIONS AND BOOK YOUR NEXT NIGHT AT THE STEPWELL.'}</Empty>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {upcomingBookings.slice(0, 2).map((b) => (
                    <div key={b.id} className="bg-[#E7D5A4] text-[#11100C] border-2 border-[#11100C] p-3">
                      <h4 className="font-condensed font-bold uppercase">{b.events?.name}</h4>
                      <p className="font-mono text-[10px] mt-1">{fmtDate(b.events?.event_date)} · {b.events?.venue}</p>
                      <Badge status={b.status} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'passport' && (
          <div className="bg-[#3c0f0e] border-2 border-[#C99A2E] p-5 sm:p-8 shadow-[4px_4px_0px_#11100C]">
            <span className="font-mono text-xs font-bold text-[#C99A2E] tracking-[0.3em]">PASSPORT // MEMBER STAMP BOOK</span>
            <p className="font-mono text-[10px] text-[#E7D5A4]/70 mt-1 mb-5">Each confirmed Tangy Session booking earns a stamp in your passport.</p>
            {stampsCount === 0 ? (
              <Empty>{bookingsError ? BOOKINGS_UNAVAILABLE : 'NO STAMPS YET — YOUR FIRST BOOKING WILL START YOUR COLLECTION.'}</Empty>
            ) : (
              <div className="flex flex-wrap gap-3">
                {bookings.filter((b) => b.status === 'confirmed' || b.status === 'paid').map((b, i) => (
                  <ArchiveStamp key={b.id} text={b.events?.name?.replace('Tangy Sessions ', '') || 'SESSION'} rotation={`${(i % 2 === 0 ? -1 : 1) * (4 + i)}deg`} color={i % 2 === 0 ? 'gold' : 'orange'} />
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'bookings' && (
          <div className="flex flex-col gap-6">
            <div>
              <h3 className="font-condensed text-lg font-bold uppercase mb-3">Upcoming</h3>
              {upcomingBookings.length === 0 ? (
                <Empty>{bookingsError ? BOOKINGS_UNAVAILABLE : 'NO UPCOMING TICKETS. BOOK A SESSION TO SEE IT HERE.'}</Empty>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {upcomingBookings.map((b) => (
                    <div key={b.id} className="bg-[#E7D5A4] text-[#11100C] border-2 border-[#11100C] p-3">
                      <div className="flex justify-between items-start gap-2">
                        <h4 className="font-condensed font-bold uppercase">{b.events?.name}</h4>
                        <Badge status={b.status} />
                      </div>
                      <p className="font-mono text-[10px] mt-1">{fmtDate(b.events?.event_date)} · {b.events?.event_time} · {b.events?.venue}</p>
                      <p className="font-mono text-[9px] mt-2 text-[#B94717] font-bold">
                        Booking {b.registration_code} · {b.quantity} attendee{b.quantity === 1 ? '' : 's'} · ₹{b.amount} · {b.status === 'confirmed' ? 'Paid' : b.status === 'pending' ? 'Payment pending' : b.status}
                      </p>
                      <TicketList booking={b} />
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <h3 className="font-condensed text-lg font-bold uppercase mb-3">Ticket History</h3>
              {pastBookings.length === 0 ? (
                <Empty>{bookingsError ? BOOKINGS_UNAVAILABLE : 'NO PAST TICKETS ON RECORD.'}</Empty>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {pastBookings.map((b) => (
                    <div key={b.id} className="bg-[#191410] border-2 border-[#C99A2E]/30 p-3">
                      <div className="flex justify-between items-start gap-2">
                        <h4 className="font-condensed font-bold uppercase">{b.events?.name}</h4>
                        <Badge status={b.status} />
                      </div>
                      <p className="font-mono text-[10px] mt-1 text-[#E7D5A4]/70">{fmtDate(b.events?.event_date)} · {b.events?.venue}</p>
                      <p className="font-mono text-[9px] mt-1 text-[#E7D5A4]/60">Booking {b.registration_code} · {b.quantity} attendee{b.quantity === 1 ? '' : 's'}</p>
                      <TicketList booking={b} showQr={false} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'waitlist' && (
          <div>
            <h3 className="font-condensed text-lg font-bold uppercase mb-3">Waitlist Status</h3>
            {waitlistError ? (
              <div role="alert" data-waitlist-error className="p-3 border-2 border-[#11100C] bg-[#B5532A] text-[#ecdcaf] font-mono text-[11px] flex items-center gap-3">
                <span className="flex-1">We couldn't load your waitlist right now. If you're expecting a seat offer, check again in a moment.</span>
                <button type="button" onClick={load} className="px-3 py-1 border-2 border-[#ecdcaf] uppercase text-[10px]">Retry</button>
              </div>
            ) : waitlist.length === 0 ? (
              <Empty>YOU'RE NOT ON ANY WAITLISTS RIGHT NOW. WHEN A SESSION SELLS OUT, YOU CAN JOIN ITS WAITLIST FROM THE SESSION PAGE.</Empty>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {waitlist.map((w) => (
                  <div key={w.id} className="bg-[#E7D5A4] text-[#11100C] border-2 border-[#11100C] p-3" data-my-waitlist-entry>
                    <h4 className="font-condensed font-bold uppercase">{w.event_name || w.events?.name || 'Session'}</h4>
                    <p className="font-mono text-[10px] mt-1">{fmtDate(w.event_date || w.events?.event_date)}{w.venue ? ` · ${w.venue}` : ''}</p>
                    <p className="font-mono text-[10px] mt-1 font-bold">
                      {w.status === 'offered'
                        ? `Seats held for you until ${new Date(w.offer_expires_at).toLocaleString('en-IN', { hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' })}`
                        : `Waiting${w.queue_position ? ` · position ${w.queue_position}` : ''} · ${w.quantity} ${w.quantity === 1 ? 'person' : 'people'}`}
                    </p>
                    {w.event_slug && !readOnly && (
                      <a href={`/sessions/${w.event_slug}`} className="inline-block mt-2 font-mono text-[10px] font-bold underline">
                        {w.status === 'offered' ? 'Book your held seats →' : 'View session →'}
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'settings' && (
          readOnly ? (
            <div className="max-w-md"><ReadOnlyNote>Account settings can't be edited in admin preview.</ReadOnlyNote></div>
          ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 max-w-3xl">
            <div className="bg-[#E7D5A4] text-[#11100C] border-2 border-[#11100C] p-6 shadow-[4px_4px_0px_#11100C]">
              <h3 className="font-condensed text-lg font-bold uppercase mb-4">Account Settings</h3>
              <form onSubmit={handleSettingsSave} className="flex flex-col gap-4 text-xs">
                <div>
                  <label className="block text-[10px] font-bold uppercase mb-1">Full Name</label>
                  <input value={settingsForm.fullName} onChange={(e) => { setSettingsForm({ ...settingsForm, fullName: e.target.value }); setSavedMsg(''); }} className="w-full p-3 bg-[#F5E9C9] border-2 border-[#11100C] outline-none" />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase mb-1">Phone</label>
                  <input value={settingsForm.phone} onChange={(e) => { setSettingsForm({ ...settingsForm, phone: e.target.value }); setSavedMsg(''); }} className="w-full p-3 bg-[#F5E9C9] border-2 border-[#11100C] outline-none" />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase mb-1">Email</label>
                  <input disabled value={user.email} className="w-full p-3 bg-[#F5E9C9]/50 border-2 border-[#11100C]/40 outline-none" />
                </div>
                {savedMsg && <div className="p-2 bg-[#10b981]/20 border border-[#10b981]/40 text-[#0f5132] text-[10px] font-bold">{savedMsg}</div>}
                <button type="submit" className="py-3 bg-[#11100C] text-[#E7D5A4] hover:bg-[#B94717] font-bold uppercase tracking-widest border-2 border-[#11100C]">SAVE CHANGES</button>
              </form>
            </div>

            <div className="bg-[#191410] border-2 border-[#C99A2E]/40 p-6">
              <h3 className="font-condensed text-lg font-bold uppercase mb-4 text-[#E7D5A4]">Change Password</h3>
              <form onSubmit={handlePasswordChange} className="flex flex-col gap-3 text-xs">
                <input type="password" required minLength={6} placeholder="New password" value={pwForm.next} onChange={(e) => setPwForm({ ...pwForm, next: e.target.value })} className="w-full p-2.5 bg-[#11100C] border border-[#C99A2E]/60 text-[#E7D5A4] outline-none" />
                <input type="password" required placeholder="Confirm new password" value={pwForm.confirm} onChange={(e) => setPwForm({ ...pwForm, confirm: e.target.value })} className="w-full p-2.5 bg-[#11100C] border border-[#C99A2E]/60 text-[#E7D5A4] outline-none" />
                <button type="submit" className="py-2.5 bg-[#C99A2E] text-[#11100C] hover:bg-[#E7D5A4] font-bold uppercase text-[10px] tracking-widest border-2 border-[#11100C]">UPDATE PASSWORD</button>
              </form>
              {pwMsg && <div className="mt-3 p-2 bg-[#10b981]/20 border border-[#10b981]/40 text-[#10b981] text-[10px] font-bold">{pwMsg}</div>}
            </div>
          </div>
          )
        )}

        {activeTab === 'help' && (
          <div className="max-w-lg flex flex-col gap-4">
            {readOnly ? (
              <ReadOnlyNote>Messaging is disabled in admin preview.</ReadOnlyNote>
            ) : (
              <>
                <div className="bg-[#191410] border-2 border-[#C99A2E]/40 p-5">
                  <h3 className="font-condensed text-lg font-bold uppercase mb-2">Need help?</h3>
                  <p className="font-mono text-[11px] text-[#E7D5A4]/70 mb-3">Tangy AI can answer questions about bookings, sessions and your passport instantly.</p>
                  <Link to="/ai" className="inline-block px-4 py-2 bg-[#C99A2E] text-[#11100C] font-bold uppercase text-[10px] tracking-widest">✦ ASK TANGY AI →</Link>
                </div>
                <div>
                  {agentSent ? (
                    <div className="p-4 bg-[#10b981]/20 border-2 border-[#10b981]/40 text-xs font-bold">✓ MESSAGE SENT — THE TANGY TEAM WILL REACH OUT.</div>
                  ) : (
                    <AgentRequestForm onCancel={() => {}} onSubmitted={() => setAgentSent(true)} />
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </section>

      <Footer />
    </div>
  );
};
