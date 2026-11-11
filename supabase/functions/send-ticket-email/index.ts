// Sends the ticket confirmation email for a confirmed booking (tickets are
// issued by settle_payment → confirm_booking_and_issue_tickets), via
// _shared/ticketEmail.ts + _shared/email.ts (email secrets never leave the
// server).
//
// The automatic ticket email is queued in email_outbox by razorpay-webhook /
// razorpay-verify-payment and sent by send-notification-emails, so it does not
// depend on the browser. This function is:
//   * the browser's call after a verified payment — a no-op when the email is
//     already queued or sent, a direct send only as a fallback;
//   * the admin "RESEND EMAIL" action (`force: true`) — always sends.
// Re-verifies everything server-side: the caller's session, that the caller
// owns the booking, is an active admin, or is active staff assigned to the
// booking's event, and that the booking is confirmed.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleOptions, jsonResponse } from '../_shared/cors.ts';
import { sendEmail } from '../_shared/email.ts';
import { buildTicketEmail, markTicketEmail, ticketDedupeKey } from '../_shared/ticketEmail.ts';
import { activeRole } from '../_shared/caller.ts';

Deno.serve(async (req) => {
  // Answers with this request's origin when it is allowed (_shared/cors.ts).
  const json = (body: unknown, status = 200) => jsonResponse(req, body, status);
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const authClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userError } = await authClient.auth.getUser();
    if (userError || !userData?.user) return json({ error: 'Sign in required.' }, 401);

    const admin = createClient(supabaseUrl, serviceRoleKey);

    const { booking_id, force } = await req.json();
    if (!booking_id) return json({ error: 'Missing booking_id.' }, 400);

    const { data: booking, error: bookingError } = await admin.from('bookings').select('*').eq('id', booking_id).single();
    if (bookingError || !booking) return json({ error: 'Booking not found.' }, 404);

    // Only the booking's own owner, an active admin, or active staff working
    // THIS booking's event (for the resend action) may trigger this. A
    // deactivated account keeps no team role. Staff are scoped by the
    // database's own is_assigned_to_event() (event_assignments, the rule RLS
    // and check-in use), run under the caller's session for the event of the
    // booking row read above — never an event id from the request.
    const callerRole = await activeRole(admin, userData.user.id);
    const isOwner = booking.user_id === userData.user.id;
    const isAdmin = callerRole !== null && ['admin', 'super_admin'].includes(callerRole);
    let isEventStaff = false;
    if (!isOwner && !isAdmin && callerRole === 'staff') {
      const { data: assigned, error: assignedError } = await authClient.rpc('is_assigned_to_event', { p_event_id: booking.event_id });
      isEventStaff = !assignedError && assigned === true;
    }
    if (!isOwner && !isAdmin && !isEventStaff) return json({ error: 'Not authorized for this booking.' }, 403);

    if (booking.status !== 'confirmed') {
      return json({ error: 'Booking is not confirmed yet — no ticket email to send.' }, 409);
    }

    if (booking.ticket_email_status === 'sent' && !force) {
      return json({ success: true, already_sent: true });
    }

    // Already queued by the payment functions: the queue sends it (no second copy).
    if (!force) {
      const { data: queued } = await admin.from('email_outbox').select('status').eq('dedupe_key', ticketDedupeKey(booking.id)).maybeSingle();
      if (queued && ['queued', 'sending', 'sent'].includes(queued.status)) return json({ success: true, queued: true });
    }

    const { email, problem } = await buildTicketEmail(admin, booking);
    if (!email) {
      if (problem === 'No linked account email on file.') {
        await markTicketEmail(admin, booking.id, false, problem);
        return json({ success: false, error: problem });
      }
      return json({ error: problem }, 409);
    }

    // The booking's payment/ticket confirmation is NOT touched here — only the
    // email delivery state reflects the outcome, so an admin can retry.
    const result = await sendEmail(email);
    await markTicketEmail(admin, booking.id, result.ok, result.error);
    return json(result.ok ? { success: true } : { success: false, error: result.error || 'Email delivery failed.' });
  } catch (err) {
    console.error('send-ticket-email error', err instanceof Error ? err.message : err);
    return json({ error: 'Unexpected server error.' }, 500);
  }
});
