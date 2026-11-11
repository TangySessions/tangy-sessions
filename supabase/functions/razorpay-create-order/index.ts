// Creates a Razorpay order server-side and a matching `bookings` row in
// status 'pending'. The amount is ALWAYS computed by the database from the
// event's ticket types (create_pending_booking → booking_quote, 0026) —
// never accepted from the client — so a tampered request can pick a ticket
// type and quantity but never a price.
//
// Required Edge Function secrets (set via `supabase secrets set`):
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are injected
// automatically by the Supabase runtime — do not set them yourself.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleOptions, jsonResponse } from '../_shared/cors.ts';

function generateRegistrationCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return `TS-${code}`;
}

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

    // Verify the caller's real Supabase session — this function requires a
    // real authenticated account regardless of the app's global AUTH_MODE.
    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await authClient.auth.getUser();
    if (userError || !userData?.user) {
      return json({ error: 'Sign in required.' }, 401);
    }
    const user = userData.user;

    const body = await req.json();
    const { eventId, quantity, tierId, attendeeName, attendeeEmail, attendeePhone, attendeeNames, details } = body ?? {};

    // The event's own range (0024) is checked below once the event is loaded.
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) {
      return json({ error: 'Choose a valid number of tickets.' }, 400);
    }
    if (!eventId || !attendeeName || !attendeeEmail) {
      return json({ error: 'Missing required booking details.' }, 400);
    }
    if (typeof attendeeName !== 'string' || attendeeName.trim().length === 0 || attendeeName.trim().length > 120) {
      return json({ error: 'Enter your full name.' }, 400);
    }
    if (typeof attendeeEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(attendeeEmail.trim())) {
      return json({ error: 'Enter a valid email address.' }, 400);
    }
    // Indian mobile / WhatsApp number: 10 digits starting 6–9, optional +91 / 0.
    const phoneDigits = typeof attendeePhone === 'string' ? attendeePhone.replace(/[\s-]/g, '').replace(/^(\+?91|0)(?=\d{10}$)/, '') : '';
    if (!/^[6-9]\d{9}$/.test(phoneDigits)) {
      return json({ error: 'Enter a valid 10-digit mobile / WhatsApp number.' }, 400);
    }
    if (details != null && (typeof details !== 'object' || Array.isArray(details))) {
      return json({ error: 'Booking details are malformed.' }, 400);
    }
    // One name per ticket, collected before payment (0023). Re-validated by
    // create_pending_booking(); names become the tickets' attendees only once
    // payment is confirmed.
    const names = Array.isArray(attendeeNames) ? attendeeNames.map((n) => (typeof n === 'string' ? n.trim() : '')) : [];
    if (names.length !== qty || names.some((n) => n.length === 0 || n.length > 120)) {
      return json({ error: 'Enter a name (up to 120 characters) for every attendee.' }, 400);
    }
    // Ticket type: an identifier only. Whether it exists, is on sale and
    // what it costs is decided by the database.
    if (typeof tierId !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(tierId)) {
      return json({ error: 'Choose a ticket type.' }, 400);
    }

    // Service-role client: bypasses RLS deliberately, only after we've
    // verified the caller's identity above. Used to read the authoritative
    // price and to insert the pending booking on the user's behalf.
    const admin = createClient(supabaseUrl, serviceRoleKey);

    const { data: event, error: eventError } = await admin
      .from('events')
      .select('id, price, status, booking_min_quantity, booking_max_quantity')
      .eq('id', eventId)
      .single();

    if (eventError || !event) {
      return json({ error: 'Event not found.' }, 404);
    }
    if (event.status !== 'on-sale') {
      // A sold-out session still sells to someone holding a live waitlist offer.
      const { data: offer } = event.status === 'sold-out'
        ? await admin.from('waitlist').select('id')
            .eq('event_id', eventId).eq('user_id', user.id).eq('status', 'offered')
            .gt('offer_expires_at', new Date().toISOString()).maybeSingle()
        : { data: null };
      if (!offer) {
        return json({ error: 'This session is not currently on sale.' }, 409);
      }
    }
    if (qty < event.booking_min_quantity || qty > event.booking_max_quantity) {
      return json({ error: `This session takes ${event.booking_min_quantity}–${event.booking_max_quantity} tickets per booking.` }, 400);
    }

    const registrationCode = generateRegistrationCode();

    // create_pending_booking() takes a row lock on the event and checks
    // capacity (confirmed + already-pending quantity) BEFORE inserting —
    // this is the actual overselling protection, not the event.status check
    // above. A concurrent buyer racing for the last seats serializes here
    // instead of both succeeding. Deliberately called before ever hitting
    // Razorpay's API, so a sold-out event never wastes a real order.
    // .rpc() on a function returning a single row (not setof) returns that
    // row directly in `data`, not an array.
    const { data: booking, error: bookingError } = await admin.rpc('create_pending_booking', {
      p_user_id: user.id,
      p_event_id: eventId,
      p_registration_code: registrationCode,
      p_attendee_name: attendeeName,
      p_attendee_email: attendeeEmail,
      p_attendee_phone: phoneDigits,
      p_quantity: qty,
      p_amount: null, // priced by the database for checkouts
      p_tier: tierId,
      p_razorpay_order_id: null,
      p_attendee_names: names,
      // Optional details + event questions; create_pending_booking validates
      // every field against the event's configuration (0024).
      p_details: {
        answers: details?.answers ?? {},
        instagram: details?.instagram ?? null,
        note: details?.note ?? null,
        collab_interests: Array.isArray(details?.collabInterests) ? details.collabInterests : [],
        collab_note: details?.collabNote ?? null,
      },
    });

    if (bookingError) {
      // One checkout at a time per account (0037): a payment already in
      // flight for this session, or too many new checkouts in a short time.
      // The session has already taken place (0038 — decided by the database
      // on the event's local date, whatever its status says).
      const closed = bookingError.message?.match(/EVENT_CLOSED: (.+)$/);
      if (closed) return json({ error: closed[1] }, 409);
      const holdError = bookingError.message?.match(/(HOLD_IN_PROGRESS|RATE_LIMITED): (.+)$/);
      if (holdError) {
        return json({ error: holdError[2] }, holdError[1] === 'RATE_LIMITED' ? 429 : 409);
      }
      if (bookingError.code === '23505' && bookingError.message?.includes('bookings_one_active_hold')) {
        return json({ error: 'A checkout for this session is already in progress on your account. Please try again in a moment.' }, 409);
      }
      const invalid = bookingError.message?.match(/INVALID_(?:DETAILS|QUANTITY|TICKET_TYPE): (.+)$/);
      if (invalid) {
        return json({ error: invalid[1] }, 400);
      }
      if (bookingError.message?.includes('INVALID_ATTENDEE_NAMES')) {
        return json({ error: 'Enter a name (up to 120 characters) for every attendee.' }, 400);
      }
      if (bookingError.message?.includes('SOLD_OUT')) {
        const detail = bookingError.message.match(/SOLD_OUT: (.+)$/);
        return json({ error: detail ? detail[1] : 'Not enough tickets remain for this session.' }, 409);
      }
      console.error('Booking insert failed', bookingError);
      return json({ error: 'Could not record booking.' }, 500);
    }

    const totalAmountPaise = Number(booking.amount) * 100;
    // The same checkout again (refresh / retry with the same details): the
    // database returned this account's existing hold, which already has its
    // Razorpay order — reuse it rather than creating another.
    if (booking.razorpay_order_id) {
      const keyId = Deno.env.get('RAZORPAY_KEY_ID');
      if (!keyId) return json({ error: 'Online payment is not available yet — please try again later.' }, 503);
      return json({ order_id: booking.razorpay_order_id, amount: totalAmountPaise, currency: 'INR', key_id: keyId, booking_id: booking.id, resumed: true });
    }
    const razorpayKeyId = Deno.env.get('RAZORPAY_KEY_ID');
    const razorpayKeySecret = Deno.env.get('RAZORPAY_KEY_SECRET');
    if (!razorpayKeyId || !razorpayKeySecret) {
      // Payments not configured on this deployment: release the hold at once
      // rather than keeping seats for a checkout that cannot be paid.
      await admin.from('bookings').update({ status: 'failed' }).eq('id', booking.id);
      return json({ error: 'Online payment is not available yet — please try again later.' }, 503);
    }
    const basicAuth = btoa(`${razorpayKeyId}:${razorpayKeySecret}`);

    const orderRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: totalAmountPaise,
        currency: 'INR',
        receipt: registrationCode,
        notes: { event_id: eventId, user_id: user.id },
      }),
    });

    if (!orderRes.ok) {
      const errBody = await orderRes.text();
      console.error('Razorpay order creation failed', errBody);
      // Release the capacity this booking was holding — a 'failed' booking
      // no longer counts against create_pending_booking's capacity check.
      await admin.from('bookings').update({ status: 'failed' }).eq('id', booking.id);
      return json({ error: 'Could not create payment order.' }, 502);
    }
    const order = await orderRes.json();

    const { error: attachError } = await admin
      .from('bookings')
      .update({ razorpay_order_id: order.id })
      .eq('id', booking.id);
    if (attachError) {
      console.error('Could not attach order id to booking', attachError);
      return json({ error: 'Could not record booking.' }, 500);
    }

    return json({
      order_id: order.id,
      amount: totalAmountPaise,
      currency: 'INR',
      key_id: razorpayKeyId,
      booking_id: booking.id,
    });
  } catch (err) {
    console.error('razorpay-create-order error', err);
    return json({ error: 'Unexpected server error.' }, 500);
  }
});
