import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { StaffAuthGate } from './StaffAuthGate';
import { useAdminSession, useSetting } from './AdminSession';
import { checkinService, parseCheckinCode, partyState } from '../lib/checkinService';
import { useAudio } from '../audio/AudioContext';
import { useDebounced } from './hooks';
import { TICKET_TIERS } from './rbac';
import { Icon, Button, Badge, cx, fmt } from './ui';

const TIER_NAME = Object.fromEntries(TICKET_TIERS.map((t) => [t.id, t.name]));

// Every `result` is exactly what check_in_ticket() returns — this page only
// renders it; it never decides validity, counts or who is checked in.
const RESULTS = {
  valid: { tone: 'good', icon: 'CircleCheck', title: 'Checked in', sound: 'ticketClick' },
  already_checked_in: { tone: 'warn', icon: 'TriangleAlert', title: 'Already checked in' },
  attendee_already_checked_in: { tone: 'warn', icon: 'TriangleAlert', title: 'Already checked in by someone else' },
  invalid_selection: { tone: 'bad', icon: 'CircleX', title: 'Select who is here' },
  invalid_attendee: { tone: 'bad', icon: 'CircleX', title: 'Not on this booking' },
  wrong_event: { tone: 'bad', icon: 'CircleX', title: 'Wrong event' },
  cancelled: { tone: 'bad', icon: 'CircleX', title: 'Ticket cancelled' },
  payment_not_confirmed: { tone: 'bad', icon: 'CircleX', title: 'Payment not confirmed' },
  not_found: { tone: 'bad', icon: 'CircleX', title: 'Invalid ticket' },
  not_assigned: { tone: 'bad', icon: 'Lock', title: 'Not your event' },
  access_expired: { tone: 'bad', icon: 'Lock', title: 'Access expired' },
  manual_disabled: { tone: 'bad', icon: 'Lock', title: 'Manual check-in disabled' },
  error: { tone: 'bad', icon: 'TriangleAlert', title: 'Unable to verify' },
};
const TONE = {
  good: 'bg-[#123d2a] border-[#2fb877] text-[#b9f5d6]',
  warn: 'bg-[#3d2c0e] border-[#f5b544] text-[#ffe0a3]',
  bad: 'bg-[#40150f] border-[#ef6b5e] text-[#ffc4bd]',
};

// A read that failed (events, search, counts): a plain staff-safe message —
// CheckinError carries one — and a Retry that only repeats the read.
function LoadError({ error, onRetry, label, compact = false }) {
  return (
    <div role="alert" data-load-error={label}
      className={cx('rounded-md border border-[#ef6b5e] bg-[#40150f] text-[#ffc4bd] flex items-center gap-3', compact ? 'px-3 py-2 text-[13px]' : 'p-4 text-[14px]')}>
      <Icon name="TriangleAlert" size={compact ? 16 : 22} className="shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="font-medium">{label}</div>
        <div className="opacity-90">{error?.message || 'Something went wrong. Try again.'}</div>
      </div>
      <button type="button" onClick={onRetry} className="h-10 px-4 rounded border border-[#ffc4bd]/50 font-mono text-[11px] uppercase tracking-[0.1em] shrink-0 hover:bg-black/20">Retry</button>
    </div>
  );
}

// Unnamed attendees (tickets issued before names were collected) are never
// given invented names — they read "Guest N".
const attendeeLabel = (a, i) => a.name || `Guest ${i + 1}`;

// Booking results carry the attendee list; a one-person booking keeps the
// original wording ("Checked in" / "Already checked in").
function resultTitle(res, base) {
  if (!res.group || !(res.party_size > 1)) return base.title;
  if (res.result === 'valid') return res.remaining > 0 ? 'Check-in successful' : 'Check-in complete';
  if (res.result === 'already_checked_in') return 'All attendees already checked in';
  return base.title;
}

function detailLine(r) {
  switch (r.result) {
    case 'attendee_already_checked_in': return `${(r.already || []).join(', ') || 'Someone you selected'} ${(r.already || []).length === 1 ? 'was' : 'were'} checked in a moment ago — nothing was changed. Review the list and try again.`;
    case 'invalid_selection': return 'Select at least one pending attendee.';
    case 'invalid_attendee': return 'That person is not a pending attendee on this booking — nothing was changed.';
    case 'wrong_event': return `This ${r.group ? 'booking' : 'ticket'} is for ${r.ticket_event_name || 'another event'}. Nobody was checked in.`;
    case 'already_checked_in':
      if (r.group) return r.party_size > 1 ? `${r.checked_in} / ${r.party_size} attendees checked in. No remaining check-ins.` : 'This attendee is already checked in.';
      return `First checked in at ${fmt.time(r.checked_in_at)}${r.checked_in_by_name ? ` by ${r.checked_in_by_name}` : ''}${r.method === 'manual' ? ' (manual)' : ''}.`;
    case 'not_found': return 'This code is not a Tangy ticket.';
    case 'cancelled': return 'This ticket was cancelled or refunded.';
    case 'payment_not_confirmed': return 'The booking has no confirmed payment. Send the guest to the help desk.';
    case 'not_assigned': return 'You are not assigned to this event.';
    case 'access_expired': return 'Your check-in access for this event has ended. Contact the event admin if you still need it.';
    case 'manual_disabled': return 'Only QR scans are accepted right now.';
    case 'error': return r.error || 'Check the connection and try again.';
    default: return null;
  }
}

// Every attendee on the booking with their own state: who's in (and who let
// them in), who's pending.
function AttendeeStatusList({ attendees }) {
  return (
    <ul className="flex flex-col gap-1 mt-2" aria-label="Attendees" data-attendee-status>
      {attendees.map((a, i) => (
        <li key={a.id} className="flex items-center justify-between gap-2 text-[14px]">
          <span className="truncate">{attendeeLabel(a, i)}</span>
          {a.status === 'checked_in'
            ? <span className="inline-flex items-center gap-1 shrink-0"><Icon name="CircleCheck" size={14} />Checked in</span>
            : <span className="inline-flex items-center gap-1 shrink-0 opacity-80"><Icon name="Hourglass" size={14} />Pending</span>}
        </li>
      ))}
    </ul>
  );
}

// After scanning a booking (or opening it from manual search): the named
// attendees with their state; staff tick the pending people who are here.
// Checked-in people can't be selected. The server re-checks everything —
// this list is only what it told us a moment ago.
function AttendeePanel({ party, method, busy, onConfirm, onCancel, notice }) {
  const pending = party.attendees.filter((a) => a.status === 'valid');
  const single = party.party_size === 1;
  const [selected, setSelected] = useState(() => new Set(single ? pending.map((a) => a.id) : []));
  useEffect(() => { setSelected(new Set(single ? pending.map((a) => a.id) : [])); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [party]);
  const toggle = (id) => setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const n = selected.size;
  const state = partyState(party.checked_in, party.party_size);
  return (
    <section aria-label={`Booking ${party.registration_code}`} data-group-panel
      className="rounded-md border-2 border-[#C99A2E] bg-[#17130F] p-4 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[12px] tracking-[0.12em] text-[#C99A2E]">{party.registration_code}</div>
          <div className="text-[15px] text-[#E7D5A4]/80 truncate">{party.event_name}</div>
          <div className="text-[14px] text-[#E7D5A4]/70">{party.party_size} attendee{party.party_size === 1 ? '' : 's'}{method === 'manual' ? ' · manual' : ''}</div>
        </div>
        {state && <Badge tone={state.tone}><span className="inline-flex items-center gap-1"><Icon name={state.icon} size={12} />{state.label}</span></Badge>}
      </div>
      {!single && (
        <dl className="grid grid-cols-2 gap-2 m-0">
          <div className="rounded border border-[#C99A2E]/20 px-3 py-2">
            <dt className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#E7D5A4]/60">Checked in</dt>
            <dd className="m-0 font-condensed text-3xl tabular-nums text-[#5fd3a0]" data-party-progress>{party.checked_in} / {party.party_size}</dd>
          </div>
          <div className="rounded border border-[#C99A2E]/20 px-3 py-2">
            <dt className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#E7D5A4]/60">Remaining</dt>
            <dd className="m-0 font-condensed text-3xl tabular-nums text-[#f5b544]" data-party-remaining>{party.remaining}</dd>
          </div>
        </dl>
      )}
      {notice && <p role="alert" className="text-[13px] text-[#ffe0a3] m-0">{notice}</p>}
      <fieldset className="flex flex-col gap-1.5 m-0 p-0 border-0">
        <legend className="font-mono text-[10.5px] uppercase tracking-[0.15em] text-[#C99A2E] mb-1.5">{single ? 'Attendee' : 'Attendees — select who is here'}</legend>
        {party.attendees.map((a, i) => {
          const done = a.status === 'checked_in';
          return (
            <label key={a.id} data-attendee={attendeeLabel(a, i)}
              className={cx('min-h-[52px] rounded-md border px-3 flex items-center gap-3', done ? 'border-[#2fb877]/30 bg-[#123d2a]/40' : selected.has(a.id) ? 'border-[#C99A2E] bg-[#C99A2E]/10' : 'border-[#E7D5A4]/15')}>
              <input type="checkbox" checked={done || selected.has(a.id)} disabled={done || busy} onChange={() => toggle(a.id)}
                aria-label={`${attendeeLabel(a, i)} — ${done ? 'checked in' : 'pending'}`} className="h-6 w-6 accent-[#C99A2E] shrink-0" />
              <span className="flex-1 min-w-0">
                <span className="block text-[16px] text-[#EFE2C0] truncate">{attendeeLabel(a, i)}</span>
                {done && <span className="block text-[11.5px] text-[#E7D5A4]/55">{fmt.time(a.checked_in_at)}{a.checked_in_by_name ? ` · ${a.checked_in_by_name}` : ''}</span>}
              </span>
              <span className={cx('shrink-0 inline-flex items-center gap-1 font-mono text-[10.5px] uppercase', done ? 'text-[#5fd3a0]' : 'text-[#E7D5A4]/60')}>
                <Icon name={done ? 'CircleCheck' : 'Hourglass'} size={13} />{done ? 'Checked in' : 'Pending'}
              </span>
            </label>
          );
        })}
      </fieldset>
      <button type="button" onClick={() => onConfirm([...selected])} disabled={busy || n === 0}
        className="h-14 rounded-md bg-[#2fb877] text-[#0b1f15] font-condensed text-xl uppercase tracking-wide disabled:opacity-40">
        {busy ? 'Checking in…' : single ? 'Check in' : `Check in selected (${n})`}
      </button>
      <button type="button" onClick={onCancel} disabled={busy} className="h-11 rounded-md border border-[#C99A2E]/30 text-[13px] text-[#E7D5A4]/75">Cancel</button>
    </section>
  );
}

function QrScanner({ onDecoded, active }) {
  const containerId = 'tangy-qr-reader';
  const scannerRef = useRef(null);
  const [cameraError, setCameraError] = useState('');
  // The camera starts once; route each decode to the latest handler so it
  // always uses the currently selected event.
  const onDecodedRef = useRef(onDecoded);
  onDecodedRef.current = onDecoded;

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    import('html5-qrcode').then(({ Html5Qrcode }) => {
      if (cancelled) return;
      const scanner = new Html5Qrcode(containerId);
      scannerRef.current = scanner;
      scanner
        .start({ facingMode: 'environment' }, { fps: 10, qrbox: { width: 240, height: 240 } }, (text) => onDecodedRef.current(text), () => {})
        .catch(() => { if (!cancelled) setCameraError('Camera unavailable. Allow camera access, or use manual check-in.'); });
    });
    return () => {
      cancelled = true;
      const s = scannerRef.current;
      scannerRef.current = null;
      if (!s) return;
      const clear = () => { try { s.clear(); } catch { /* already cleared */ } };
      // stop() throws synchronously when the camera never started (e.g.
      // permission denied), which would crash the switch to manual mode.
      let stopped;
      try { stopped = s.stop(); } catch { stopped = null; }
      if (stopped) stopped.catch(() => {}).finally(clear);
      else clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return (
    <div>
      <div id={containerId} className="w-full max-w-sm mx-auto rounded overflow-hidden bg-black aspect-square" />
      {cameraError && <p className="mt-3 text-center text-[13px] text-[#f5b544]">{cameraError}</p>}
    </div>
  );
}

function CheckInWorkspace() {
  const { user } = useAdminSession();
  const { playSFX } = useAudio();
  const allowManual = useSetting('checkin.allow_manual', true);
  const [params, setParams] = useSearchParams();
  const [events, setEvents] = useState(null);
  const [eventsError, setEventsError] = useState(null);
  const eventId = params.get('event') || '';
  const [mode, setMode] = useState('scan');
  const [result, setResult] = useState(null);
  // A booking QR waiting for "who is here?": the server's attendee list + how it was opened.
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const q = useDebounced(search, 300);
  const [matches, setMatches] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [stats, setStats] = useState(null);
  const [recent, setRecent] = useState([]);
  // Counts / recent arrivals that could not be refreshed: the last values stay
  // on screen, flagged as possibly out of date.
  const [liveError, setLiveError] = useState(null);
  const lastScan = useRef({ code: '', at: 0 });
  const inFlight = useRef(false);

  // A failed load is an error with Retry — never "no events".
  const loadEvents = useCallback(() => {
    setEventsError(null);
    setEvents(null);
    checkinService.getEvents().then(setEvents, setEventsError);
  }, []);
  useEffect(() => { loadEvents(); }, [loadEvents]);
  // Default to today's / the nearest event (RPC orders by distance from today).
  useEffect(() => {
    if (!events || events.length === 0) return;
    if (!eventId || !events.some((e) => e.id === eventId)) setParams({ event: events[0].id }, { replace: true });
  }, [events, eventId, setParams]);

  const refresh = useCallback(() => {
    if (!eventId) return;
    Promise.all([checkinService.getStats(eventId), checkinService.getRecentCheckins(eventId, 8)]).then(
      ([s, rows]) => { setStats(s); setRecent(rows); setLiveError(null); },
      setLiveError,
    );
  }, [eventId]);
  useEffect(() => { refresh(); }, [refresh]);

  const offline = () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setResult({ result: 'error', error: 'You are offline. Reconnect and scan again.' });
      return true;
    }
    return false;
  };

  const run = async (token, method = 'qr', attendeeHint = null, attendeeIds = null) => {
    if (offline()) return;
    inFlight.current = true;
    setBusy(true);
    const res = await checkinService.checkInByToken(token, eventId, { method, attendeeIds });
    inFlight.current = false;
    setBusy(false);
    // Refused selection (e.g. another gate just admitted someone you ticked):
    // nothing changed — re-open the list with the server's current state.
    const retry = ['attendee_already_checked_in', 'invalid_attendee', 'invalid_selection'].includes(res.result) && res.remaining > 0 && res.attendees;
    if (retry) {
      setResult(null);
      setPending({ ...res, token, method, notice: detailLine(res) });
    } else {
      setPending(null);
      setResult({ ...res, attendee_name: res.guest_name || res.attendee_name || attendeeHint });
    }
    if (res.result === 'valid') playSFX('ticketClick');
    if (navigator.vibrate) navigator.vibrate(res.result === 'valid' ? 60 : [80, 60, 80]);
    refresh();
  };

  // Booking QR: ask the server for the attendee list first (no write), then
  // staff tick who is here. Anything but `ready` is final.
  const openGroup = async (token, method, attendeeHint = null) => {
    if (offline()) return;
    inFlight.current = true;
    setBusy(true);
    const res = await checkinService.checkInByToken(token, eventId, { method, preview: true });
    inFlight.current = false;
    setBusy(false);
    if (res.result === 'ready') {
      setResult(null);
      setPending({ ...res, token, method });
    } else {
      setPending(null);
      setResult({ ...res, attendee_name: res.attendee_name || attendeeHint });
      if (navigator.vibrate) navigator.vibrate(res.result === 'already_checked_in' ? [60] : [80, 60, 80]);
    }
  };

  const onDecoded = (text) => {
    const now = Date.now();
    // The camera decodes ~10×/s. While the same ticket stays in frame, keep
    // sliding the window so its result isn't replaced by "Already checked in"
    // (by this very scan); it re-triggers only after 10s out of view.
    if (text === lastScan.current.code && now - lastScan.current.at < 10000) {
      lastScan.current.at = now;
      return;
    }
    if (inFlight.current || pending) return;
    lastScan.current = { code: text, at: now };
    const code = parseCheckinCode(text);
    if (code.kind === 'group') openGroup(text, 'qr');
    else run(text, 'qr');
  };

  useEffect(() => {
    if (mode !== 'manual' || !q.trim() || !eventId) { setMatches([]); setSearchError(null); return; }
    let cancelled = false;
    setSearching(true);
    setSearchError(null);
    // A failed search is never shown as "No attendees found".
    checkinService.searchTickets(q, eventId).then(
      (rows) => { if (!cancelled) { setMatches(rows); setSearching(false); } },
      (error) => { if (!cancelled) { setMatches([]); setSearchError(error); setSearching(false); } },
    );
    return () => { cancelled = true; };
  }, [q, eventId, mode, result, searchAttempt]);

  const selected = (events || []).find((e) => e.id === eventId);
  // Volunteers: show their window and flip to "expired" on time. The server
  // refuses scans after expiry regardless of what this clock says.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setClock(Date.now()), 15000); return () => clearInterval(t); }, []);
  const accessEnds = selected?.access_expires_at ? new Date(selected.access_expires_at).getTime() : null;
  const accessOver = accessEnds != null && clock >= accessEnds;
  const homePath = user?.role === 'volunteer' ? '/volunteer/dashboard' : '/admin-portal';
  const r = result && (RESULTS[result.result] || RESULTS.error);
  // Manual search returns ticket rows; staff act on bookings.
  const bookings = Object.values(matches.reduce((acc, t) => { (acc[t.booking_id] ||= t); return acc; }, {}));
  // Recent check-ins, one line per arrival (rows of one action share a batch),
  // naming the attendees who came in.
  const arrivals = Object.values(recent.reduce((acc, c) => {
    const k = c.batch_id || c.id;
    acc[k] = acc[k] ? { ...acc[k], people: [...acc[k].people, c] } : { ...c, people: [c] };
    return acc;
  }, {})).map((a) => ({
    ...a,
    // Rows of one arrival share a timestamp: list them in booking order.
    names: [...a.people].sort((x, y) => (x.ticket_number || '').localeCompare(y.ticket_number || '')).map((c) => c.guest_name || c.ticket_number),
  }));
  const pct = stats?.tickets_issued ? Math.round((100 * stats.checked_in) / stats.tickets_issued) : 0;

  return (
    <div data-lenis-prevent className="min-h-[100dvh] bg-[#11100C] text-[#E7D5A4] font-sans">
      <header className="sticky top-0 z-50 bg-[#141009] border-b border-[#C99A2E]/20 px-3 sm:px-5 py-2.5 flex items-center gap-2">
        <Link to={homePath} className="h-10 w-10 inline-flex items-center justify-center rounded text-[#E7D5A4]/70 hover:bg-[#C99A2E]/10" aria-label={user?.role === 'volunteer' ? 'Back to volunteer portal' : 'Back to console'}><Icon name="ChevronLeft" size={20} /></Link>
        <div className="flex-1 min-w-0">
          <div className="font-mono text-[9.5px] uppercase tracking-[0.2em] text-[#C99A2E]">Check-in · {user?.full_name || user?.email}</div>
          <select
            aria-label="Event"
            value={eventId}
            onChange={(e) => { setParams({ event: e.target.value }, { replace: true }); setResult(null); }}
            className="w-full bg-transparent text-[15px] text-[#EFE2C0] font-condensed uppercase tracking-wide focus:outline-none truncate"
          >
            {events === null && <option>{eventsError ? 'Events unavailable' : 'Loading events…'}</option>}
            {(events || []).map((e) => <option key={e.id} value={e.id} className="bg-[#11100C]">{e.name} — {fmt.date(e.event_date)}</option>)}
          </select>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-3 sm:px-5 py-4 flex flex-col gap-4 pb-16">
        {eventsError ? (
          <LoadError label="Couldn't load your events" error={eventsError} onRetry={loadEvents} />
        ) : events && events.length === 0 ? (
          <div className="text-center py-16 px-4">
            <Icon name="CalendarDays" size={28} className="mx-auto text-[#C99A2E]/60" />
            <div className="font-condensed text-lg uppercase mt-3">No events to check in</div>
            <p className="text-[13px] text-[#E7D5A4]/55 mt-1">You're not assigned to any published event. Ask an admin to add you to the event team.</p>
          </div>
        ) : (
          <>
            {accessEnds != null && (
              <div role="status" data-access-window className={cx('rounded-md border px-3 py-2 text-[13px] flex items-center gap-2', accessOver ? 'border-[#ef6b5e] bg-[#40150f] text-[#ffc4bd]' : 'border-[#2fb877]/60 bg-[#123d2a] text-[#b9f5d6]')}>
                <Icon name="Timer" size={16} />
                {accessOver ? 'Your check-in access has expired. Contact the event admin if you still need it.' : `Check-in access until ${fmt.time(selected.access_expires_at)}`}
              </div>
            )}
            {liveError && <LoadError compact label="Counts may be out of date" error={liveError} onRetry={refresh} />}
            <div className="grid grid-cols-3 gap-2" aria-live="polite">
              {[['Checked in', stats?.checked_in, 'text-[#5fd3a0]'], ['To arrive', stats?.remaining, 'text-[#f5b544]'], ['Tickets', stats?.tickets_issued, 'text-[#EFE2C0]']].map(([label, n, cls]) => (
                <div key={label} className="bg-[#17130F] border border-[#C99A2E]/20 rounded-md py-2.5 text-center">
                  <div className={cx('font-condensed text-2xl tabular-nums leading-none', cls)}>{n ?? '—'}</div>
                  <div className="font-mono text-[9.5px] uppercase tracking-[0.15em] text-[#E7D5A4]/60 mt-1">{label}</div>
                </div>
              ))}
            </div>
            <div className="h-1.5 rounded-full bg-[#E7D5A4]/10 overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Check-in progress">
              <div className="h-full bg-[#2fb877] transition-all" style={{ width: `${pct}%` }} />
            </div>

            {r && (
              <div role="status" className={cx('rounded-md border-2 p-4 flex gap-3 items-start', TONE[r.tone])}>
                <Icon name={r.icon} size={30} className="shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="font-condensed text-2xl uppercase leading-tight">{resultTitle(result, r)}</div>
                  {result.group && result.party_size === 1 && result.attendees?.[0]
                    ? <div className="text-[17px] mt-1 font-medium">{attendeeLabel(result.attendees[0], 0)}</div>
                    : !result.group && result.attendee_name && <div className="text-[17px] mt-1 font-medium">{result.attendee_name}</div>}
                  <div className="font-mono text-[12px] opacity-80 mt-1">{[result.ticket_number, TIER_NAME[result.tier] || result.tier, result.registration_code, result.group && result.event_name].filter(Boolean).join(' · ')}</div>
                  {result.group && result.party_size > 1 && result.result === 'valid' && (
                    <div className="mt-2 text-[15px]" data-result-party>
                      <div className="font-medium">{result.quantity} attendee{result.quantity === 1 ? '' : 's'} checked in: {(result.admitted || []).join(', ')}</div>
                      <div>Progress <span className="font-condensed text-xl tabular-nums">{result.checked_in} / {result.party_size}</span></div>
                      <div>{result.remaining > 0 ? <>Remaining <span className="font-condensed text-xl tabular-nums">{result.remaining}</span> — the booking QR stays valid</> : 'All attendees have arrived.'}</div>
                    </div>
                  )}
                  {result.group && result.party_size > 1 && ['valid', 'already_checked_in'].includes(result.result) && result.attendees && <AttendeeStatusList attendees={result.attendees} />}
                  {result.result === 'valid' && <div className="text-[12.5px] opacity-80 mt-1">{fmt.time(result.checked_in_at)}{result.checked_in_by_name ? ` · by ${result.checked_in_by_name}` : ''}{result.method === 'manual' ? ' · manual' : ''}</div>}
                  {detailLine(result) && <div className="text-[13px] mt-1.5">{detailLine(result)}</div>}
                </div>
                {/* Dismiss = ready for the next scan, including the same booking QR
                    again (the rest of a party arriving later). */}
                <button onClick={() => { setResult(null); lastScan.current = { code: '', at: 0 }; }} className="h-11 w-11 inline-flex items-center justify-center rounded hover:bg-black/20" aria-label="Dismiss"><Icon name="X" size={20} /></button>
              </div>
            )}

            {pending && (
              <AttendeePanel party={pending} method={pending.method} busy={busy} notice={pending.notice}
                onConfirm={(ids) => run(pending.token, pending.method, null, ids)}
                onCancel={() => { setPending(null); lastScan.current = { code: '', at: 0 }; }} />
            )}

            <div className="grid grid-cols-2 gap-2">
              {[{ id: 'scan', label: 'Scan QR', icon: 'ScanLine' }, ...(allowManual ? [{ id: 'manual', label: 'Manual', icon: 'Search' }] : [])].map((m) => (
                <button key={m.id} onClick={() => { setMode(m.id); setResult(null); setPending(null); }}
                  className={cx('h-12 rounded-md border inline-flex items-center justify-center gap-2 font-mono text-[12px] uppercase tracking-[0.1em]', mode === m.id ? 'bg-[#C99A2E] text-[#11100C] border-[#C99A2E]' : 'border-[#C99A2E]/30 text-[#E7D5A4]/70')}>
                  <Icon name={m.icon} size={17} /> {m.label}
                </button>
              ))}
            </div>

            {mode === 'scan' && eventId ? (
              <div className="bg-[#17130F] border border-[#C99A2E]/20 rounded-md p-3">
                <QrScanner active onDecoded={onDecoded} />
                <p className="text-center text-[12px] text-[#E7D5A4]/60 mt-3">{busy ? 'Verifying…' : pending ? 'Select who is here above.' : 'Point the camera at the booking QR code.'}</p>
              </div>
            ) : mode === 'manual' && (
              <div className="flex flex-col gap-2">
                <div className="relative">
                  <Icon name="Search" size={17} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#E7D5A4]/60" />
                  <input type="search" autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, booking code or ticket number"
                    className="w-full h-12 pl-10 pr-3 bg-[#17130F] border border-[#C99A2E]/30 rounded-md text-[15px] text-[#EFE2C0] placeholder:text-[#E7D5A4]/30 focus:outline-none focus:border-[#C99A2E]" />
                </div>
                {searching && <div className="text-[12px] text-[#E7D5A4]/60 px-1">Searching…</div>}
                {!searching && searchError && <LoadError compact label="Search failed" error={searchError} onRetry={() => setSearchAttempt((n) => n + 1)} />}
                {!searching && !searchError && q && matches.length === 0 && <div className="text-[13px] text-[#E7D5A4]/60 px-1 py-3">No attendees found for "{q}".</div>}
                <ul className="flex flex-col gap-2">
                  {bookings.map((t) => {
                    const state = partyState(t.party_checked_in, t.party_size);
                    const open = t.booking_status === 'confirmed' && t.party_remaining > 0 && t.group_token;
                    return (
                      <li key={t.booking_id} data-manual-booking={t.registration_code} className="bg-[#17130F] border border-[#C99A2E]/20 rounded-md p-3 flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="text-[15px] text-[#EFE2C0] truncate">{t.party_size === 1 ? (t.guest_name || t.attendee_name) : t.attendee_name}</div>
                          <div className="font-mono text-[11.5px] text-[#E7D5A4]/60">{t.registration_code} · {t.party_size} attendee{t.party_size === 1 ? '' : 's'} · {TIER_NAME[t.tier] || 'General'}</div>
                          {t.party_size > 0 && (
                            <div className="text-[12.5px] text-[#E7D5A4]/75 mt-0.5 flex flex-wrap items-center gap-x-2">
                              <span><span className="tabular-nums">{t.party_checked_in} / {t.party_size}</span> checked in{t.party_remaining > 0 && t.party_checked_in > 0 ? ` · ${t.party_remaining} remaining` : ''}</span>
                              {state && <span className="inline-flex items-center gap-1 text-[11px]"><Icon name={state.icon} size={12} />{state.label}</span>}
                            </div>
                          )}
                        </div>
                        {t.booking_status !== 'confirmed' ? <Badge status={t.booking_status} />
                          : !t.party_size ? <Badge status="cancelled" />
                          : !open ? <Badge tone={state.tone}>{state.label}</Badge>
                          : t.party_size === 1
                            // One named person: one tap, same server function.
                            ? <Button variant="success" size="lg" disabled={busy} onClick={() => run(t.group_token, 'manual', t.guest_name || t.attendee_name, [t.ticket_id])}>Check in</Button>
                            : <Button variant="success" size="lg" disabled={busy} onClick={() => openGroup(t.group_token, 'manual', t.attendee_name)}
                                aria-label={`Select attendees for ${t.registration_code} (${t.party_remaining} pending)`}>Select…</Button>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {recent.length > 0 && (
              <section className="bg-[#17130F] border border-[#C99A2E]/20 rounded-md">
                <h2 className="px-4 py-2.5 border-b border-[#C99A2E]/15 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#C99A2E] m-0">Recent check-ins</h2>
                <ul className="divide-y divide-[#E7D5A4]/[0.06]">
                  {arrivals.map((c) => (
                    <li key={c.batch_id || c.id} className="px-4 py-2 flex items-center gap-2 text-[13px]">
                      <span className="flex-1 min-w-0 truncate">{c.names.join(', ')} <span className="text-[#E7D5A4]/60 font-mono text-[11px]">{c.registration_code}</span></span>
                      {c.method === 'manual' && <Badge status="manual" />}
                      <span className="font-mono text-[11px] text-[#E7D5A4]/60">{fmt.time(c.checked_in_at)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {selected && <p className="text-center font-mono text-[10.5px] text-[#E7D5A4]/60">{selected.name} · {selected.venue || 'Venue TBC'}</p>}
          </>
        )}
      </main>
    </div>
  );
}

export const TangyWorldCheckInPage = () => (
  <StaffAuthGate title="Check-in" subtitle="Event-day QR check-in for Tangy staff.">
    <CheckInWorkspace />
  </StaffAuthGate>
);
