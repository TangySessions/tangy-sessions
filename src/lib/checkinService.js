import { supabase, isSupabaseConfigured } from './supabaseClient';

// Every scanned/typed code is validated and checked in by check_in_ticket()
// (0016, extended in 0017 and 0023) — a single atomic, server-validated RPC
// that also checks the caller is allowed to work THIS event. The browser never
// decides validity or counts and never writes `checkins`; it only renders the
// returned `result`:
//   valid | ready (booking preview) | already_checked_in | attendee_already_checked_in
//   | invalid_selection | invalid_attendee | wrong_event | cancelled | payment_not_confirmed
//   | not_found | not_assigned | access_expired | manual_disabled
//
// Two opaque QR payloads exist (neither contains ids or personal data):
//   TANGY:BOOKING:<token>  the booking (0023) — staff then select which named
//                          attendees are present
//   TANGY:TICKET:<token>   one attendee (issued per ticket since 0016; still honoured)
export function parseCheckinCode(scanned) {
  const text = String(scanned || '').trim();
  for (const [prefix, kind] of [['TANGY:TICKET:', 'ticket'], ['TANGY:BOOKING:', 'group']]) {
    if (text.startsWith(prefix)) return { kind, token: text.slice(prefix.length).trim() };
  }
  // Typed/pasted bare tokens: the server resolves which kind it is.
  return { kind: 'unknown', token: text };
}
export const parseTicketToken = (scanned) => parseCheckinCode(scanned).token;

// A booking's check-in state from server-derived counts. Always rendered as
// text + icon, never colour alone.
export const partyState = (checked, size) => (
  !size ? null : checked >= size ? { label: 'Complete', icon: 'CircleCheck', tone: 'good' }
    : checked > 0 ? { label: 'Partial', icon: 'CircleDashed', tone: 'warn' } : { label: 'Not checked in', icon: 'Circle', tone: 'muted' }
);

// Read failures are thrown as a CheckinError — never turned into an empty
// list — so the page can tell "nothing there" from "couldn't ask". The
// message is written for staff; the raw Supabase/Postgres error (SQL,
// function and constraint names) only goes to the console.
const SAFE_MESSAGES = {
  not_configured: 'Not connected to the Tangy server.',
  network: 'Connection problem — check the network and try again.',
  auth: 'Your session has expired. Sign in again to continue.',
  permission: "You don't have permission to see this.",
  server: 'The server could not complete the request. Try again in a moment.',
};
export class CheckinError extends Error {
  constructor(kind) {
    super(SAFE_MESSAGES[kind] || SAFE_MESSAGES.server);
    this.name = 'CheckinError';
    this.kind = SAFE_MESSAGES[kind] ? kind : 'server';
  }
}

export function classifyError(error, status) {
  if (error?.kind && SAFE_MESSAGES[error.kind]) return error.kind;
  const message = String(error?.message || error || '');
  const code = error?.code || '';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'network';
  if (status === 401 || /^PGRST30[123]$/.test(code) || /JWT|refresh token|not authenticated/i.test(message)) return 'auth';
  if (status === 403 || code === '42501' || /permission denied|row-level security|do not have (permission|access)/i.test(message)) return 'permission';
  if (status === 0 || /Failed to fetch|NetworkError|Load failed|fetch failed|network|timed? ?out|aborted/i.test(message)) return 'network';
  return 'server';
}

function fail(operation, error, status) {
  const err = error instanceof CheckinError ? error : new CheckinError(classifyError(error, status));
  console.error(`[check-in] ${operation} failed (${err.kind})`, error);
  return err;
}

// Runs one Supabase read; a { error } response or a thrown exception becomes
// a CheckinError. Only a successful response is returned as data.
async function read(operation, request) {
  if (!isSupabaseConfigured) throw fail(operation, new CheckinError('not_configured'));
  let response;
  try {
    response = await request();
  } catch (error) {
    throw fail(operation, error);
  }
  if (response.error) throw fail(operation, response.error, response.status);
  return response.data;
}

export const checkinService = {
  // `attendeeIds` (booking QR): the ticket ids of the named attendees staff
  // selected — the server admits them all or none and derives the count.
  // `preview` validates and returns the attendee list without writing.
  checkInByToken: async (scanned, eventId, { method = 'qr', notes = null, attendeeIds = null, preview = false } = {}) => {
    const token = parseTicketToken(scanned);
    if (!token) return { result: 'not_found' };
    // A failure here is shown as the 'error' result with a staff-safe line.
    // Retrying is safe: the RPC admits each ticket once (unique checkins), so
    // a check-in whose response was lost comes back as already_checked_in.
    try {
      const data = await read('check_in_ticket', () => supabase.rpc('check_in_ticket', {
        p_token: token, p_event_id: eventId, p_method: method, p_notes: notes, p_attendee_ids: attendeeIds, p_preview: preview,
      }));
      if (!data || typeof data.result !== 'string') throw fail('check_in_ticket', new Error('Unexpected check-in response.'));
      return data;
    } catch (error) {
      const kind = error instanceof CheckinError ? error.kind : 'server';
      return { result: 'error', errorKind: kind,
        error: kind === 'permission' ? "You don't have permission to check in for this event." : `${new CheckinError(kind).message} Scanning again is safe — a ticket is never checked in twice.` };
    }
  },

  // Events this user may check in for (admins: all live events; staff: only
  // events they're assigned to) — decided server-side.
  // An empty list means the server answered "none"; failures throw.
  getEvents: async () => (await read('my_checkin_events', () => supabase.rpc('my_checkin_events'))) || [],

  // Manual mode: ticket-level search through the attendee_tickets view, which
  // already restricts rows to events the caller can work.
  searchTickets: async (query, eventId) => {
    if (!query || !eventId) return [];
    const q = `%${query.trim().replace(/[%_,()*\\]/g, (c) => `\\${c}`)}%`;
    const rows = await read('attendee search', () => supabase
      .from('attendee_tickets')
      .select('ticket_id, ticket_number, tier, ticket_status, booking_id, booking_status, registration_code, attendee_name, guest_name, checked_in_at, token, event_id, group_token, party_size, party_checked_in, party_remaining')
      .eq('event_id', eventId)
      .or(`attendee_name.ilike.${q},guest_name.ilike.${q},registration_code.ilike.${q},ticket_number.ilike.${q}`)
      .order('attendee_name')
      .limit(25));
    return rows || [];
  },

  getStats: async (eventId) => {
    if (!eventId) return null;
    return read('event_checkin_stats', () => supabase.rpc('event_checkin_stats', { p_event_id: eventId }));
  },

  // A booking's arrivals, newest first (one row per check-in action).
  bookingHistory: async (bookingId) => {
    if (!bookingId) return [];
    return (await read('booking_checkin_history', () => supabase.rpc('booking_checkin_history', { p_booking_id: bookingId }))) || [];
  },

  getRecentCheckins: async (eventId, limit = 10) => {
    if (!eventId) return [];
    return (await read('get_checkin_history', () => supabase.rpc('get_checkin_history', { p_event_id: eventId, p_mine: false, p_limit: limit, p_offset: 0 }))) || [];
  },
};
