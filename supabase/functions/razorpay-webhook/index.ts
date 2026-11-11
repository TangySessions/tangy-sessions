// Razorpay calls this directly (no user session, no CORS relevance) whenever
// a payment event happens — this is the source of truth for payment status,
// independent of whether the client's own razorpay-verify-payment call ever
// ran (browser closed mid-checkout, network drop after a successful charge,
// etc.). Configure this URL + a webhook secret in the Razorpay dashboard
// (Settings -> Webhooks), and set that same secret here as
// RAZORPAY_WEBHOOK_SECRET (this is a DIFFERENT secret from RAZORPAY_KEY_SECRET).
//
// Idempotency: Razorpay explicitly documents that the same webhook event can
// be delivered more than once, so every event is recorded in
// payment_webhook_events keyed by a unique id before being acted on. The id
// comes from the signed body: `<event>:<payment id>` for payment/order
// events (one capture / failure per payment), `<event>:<refund id>` for
// refund events — a payment can be refunded in several parts, and each part
// is its own event. (The X-Razorpay-Event-Id header is not covered by the
// signature, so it is not used to deduplicate.)
//
// Status codes: 200 only when the event is recorded and either processed or
// its permanent failure recorded (or it is a duplicate of a processed event).
// 400 for a bad signature or body, 503 without the secret, and 500 whenever
// the event could not be recorded or processing hit a transient error — so
// Razorpay delivers it again. A redelivery of an event that was recorded but
// not processed is processed then; every step below is idempotent.
//
// NOTE: verify `event_id` extraction and the exact event names below
// (`payment.captured` / `order.paid` / `payment.failed`) against the current
// Razorpay webhook payload reference before going live — confirm in the
// Razorpay dashboard under Settings -> Webhooks -> your webhook -> recent
// deliveries. In particular, confirm `payload.payment.entity.order_id` is
// actually present on a `payment.failed` event the same way it is on
// `payment.captured` — this was not verified against a live payload. The
// same applies to `payment.authorized` and `refund.processed` (amounts are in
// paise; `payment.entity.amount_refunded` is used when present).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { hmacSha256Hex, timingSafeEqual, requireSecret } from '../_shared/crypto.ts';
import { enqueueTicketEmail } from '../_shared/ticketEmail.ts';


// Not accepted: Razorpay retries non-2xx deliveries. Details go to the
// function log only, never into the response.
function retryLater(what: string, detail?: unknown): Response {
  console.error(`razorpay-webhook: ${what}`, detail instanceof Error ? detail.message : detail ?? '');
  return new Response('Webhook not processed', { status: 500 });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const rawBody = await req.text();
    const signatureHeader = req.headers.get('X-Razorpay-Signature') ?? '';
    const webhookSecret = requireSecret('RAZORPAY_WEBHOOK_SECRET');
    if (!webhookSecret) {
      // Without the secret nothing can be verified — refuse rather than accept.
      console.error('razorpay-webhook: RAZORPAY_WEBHOOK_SECRET is not configured');
      return new Response('Webhook not configured', { status: 503 });
    }

    const expectedSignature = await hmacSha256Hex(webhookSecret, rawBody);
    if (!timingSafeEqual(expectedSignature, signatureHeader)) {
      console.error('razorpay-webhook: signature mismatch');
      return new Response('Invalid signature', { status: 400 });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      console.error('razorpay-webhook: signed body is not JSON');
      return new Response('Invalid payload', { status: 400 });
    }
    const eventType: string = payload.event;
    const paymentEntity = payload.payload?.payment?.entity;
    const orderEntity = payload.payload?.order?.entity;
    const refundEntity = payload.payload?.refund?.entity;
    const isRefundEvent = typeof eventType === 'string' && eventType.startsWith('refund.');
    const eventId: string | undefined = isRefundEvent
      ? (refundEntity?.id ? `${eventType}:${refundEntity.id}` : undefined)
      : (paymentEntity?.id ? `${eventType}:${paymentEntity.id}` : undefined);

    if (!eventId) {
      // Nothing stable to dedupe on — log and accept so Razorpay doesn't retry forever.
      console.warn('razorpay-webhook: no stable event id, skipping', eventType);
      return new Response('ok', { status: 200 });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(supabaseUrl, serviceRoleKey);

    const { error: insertError } = await admin.from('payment_webhook_events').insert({
      event_id: eventId,
      event_type: eventType,
      payload,
      processed: false,
    });

    if (insertError) {
      // Anything but a unique violation means the event was NOT recorded.
      if (insertError.code !== '23505') return retryLater('could not record event', insertError.message);
      // Already recorded. Processed → acknowledge as a duplicate. Recorded by a
      // delivery that did not finish (it answered 500) → process it now.
      const { data: existing, error: readError } = await admin.from('payment_webhook_events')
        .select('processed').eq('event_id', eventId).maybeSingle();
      if (readError || !existing) return retryLater('could not read the recorded event', readError?.message);
      if (existing.processed) return new Response('ok (duplicate)', { status: 200 });
    }

    const orderId = paymentEntity?.order_id ?? orderEntity?.id;
    const now = new Date().toISOString();
    // retryable: a database call failed — worth another delivery.
    // permanent: the event is understood but cannot apply — another delivery would not help.
    const retryable: string[] = [];
    const permanent: string[] = [];

    if ((eventType === 'payment.captured' || eventType === 'order.paid') && orderId) {
      // settle_payment (0026) is the only place a paid booking is confirmed:
      // it locks the event + booking, confirms pending holds, accepts late
      // payments only if the seats are still free, never re-confirms a
      // cancelled booking, checks the amount, and holds anything else for
      // finance review. Idempotent, so Razorpay retries are safe.
      const amountPaise = typeof paymentEntity?.amount === 'number' ? paymentEntity.amount : null;
      const { data: settled, error: settleError } = await admin.rpc('settle_payment', {
        p_order_id: orderId, p_payment_id: paymentEntity?.id ?? `${eventType}:${orderId}`, p_amount_paise: amountPaise, p_source: 'webhook',
      });
      if (settleError) retryable.push(`settlement failed: ${settleError.message}`);
      else if (settled?.result === 'not_found') permanent.push(`no booking for order ${orderId}`);
      else if ((settled?.result === 'confirmed' || settled?.result === 'already_confirmed') && settled.booking_id) {
        // Queue the ticket email (once per booking — unique dedupe key), so it
        // goes out even if the customer closed the browser. The booking is
        // already confirmed; a queueing failure only asks for a redelivery.
        const queued = await enqueueTicketEmail(admin, settled.booking_id);
        if (!queued.ok) retryable.push(`ticket email not queued: ${queued.reason}`);
      }
    } else if (eventType === 'payment.authorized' && orderId) {
      // A new attempt after a failed one is authorized too.
      const { error } = await admin.from('bookings')
        .update({ payment_status: 'authorized', payment_updated_at: now })
        .eq('razorpay_order_id', orderId).eq('status', 'pending').in('payment_status', ['created', 'failed']);
      if (error) retryable.push(`authorize update failed: ${error.message}`);
    } else if (eventType === 'payment.failed' && orderId) {
      // One failed ATTEMPT, not a failed checkout: Razorpay lets the customer
      // retry on the same order (same window, or "Try again", which resumes
      // this hold). So the hold keeps its seats — it is released by the normal
      // expiry (expire_stale_bookings, bookings.pending_timeout_minutes) or
      // replaced by the account's next checkout (0037). Releasing it here let
      // someone else take the seats before the retry was paid, which put a
      // successful payment into needs_review for a refund.
      const { error: failError } = await admin
        .from('bookings')
        .update({ payment_status: 'failed', payment_updated_at: now })
        .eq('razorpay_order_id', orderId)
        .eq('status', 'pending'); // never touch a confirmed / expired / cancelled booking

      if (failError) retryable.push(`booking fail-update failed: ${failError.message}`);
    } else if (eventType === 'refund.processed' && refundEntity?.payment_id) {
      // Refunds are issued manually in the Razorpay dashboard. This only
      // mirrors the refunded amount onto the booking for reporting; the
      // booking's status changes when an admin records the refund. Only
      // `processed` moves money (a `created` refund can still fail), so only it
      // is mirrored. The amount refunded so far is the larger of Razorpay's
      // own running total (payment.amount_refunded, when the payment entity is
      // included) and the sum of every distinct processed refund recorded for
      // this payment — and it only ever goes up, so out-of-order or concurrent
      // deliveries cannot lower it, and a redelivery changes nothing.
      const paymentId: string = refundEntity.payment_id;
      const { data: booking, error: bookingError } = await admin.from('bookings')
        .select('id, amount, refunded_amount').eq('razorpay_payment_id', paymentId).maybeSingle();
      const { data: recorded, error: recordedError } = await admin.from('payment_webhook_events')
        .select('event_id, payload').eq('event_type', 'refund.processed').eq('payload->payload->refund->entity->>payment_id', paymentId);
      if (bookingError || recordedError) {
        retryable.push(`refund mirror read failed: ${(bookingError ?? recordedError)?.message}`);
      } else if (!booking) {
        console.warn('razorpay-webhook: refund for a payment with no booking', paymentId);
      } else {
        const byRefund = new Map<string, number>();
        for (const row of recorded ?? []) {
          const r = row.payload?.payload?.refund?.entity;
          if (r?.id) byRefund.set(r.id, Number(r.amount ?? 0));
        }
        byRefund.set(refundEntity.id, Number(refundEntity.amount ?? 0));
        const summed = [...byRefund.values()].reduce((a, b) => a + b, 0);
        const refundedPaise = Math.max(summed, Number(paymentEntity?.amount_refunded ?? 0));
        const totalPaise = Number(booking.amount) * 100;
        const refundedRupees = Math.round(refundedPaise / 100);
        if (refundedRupees > Number(booking.refunded_amount ?? 0)) {
          const { error } = await admin.from('bookings')
            .update({
              refunded_amount: refundedRupees,
              payment_status: totalPaise > 0 && refundedPaise < totalPaise ? 'partially_refunded' : 'refunded',
              payment_updated_at: now,
            })
            .eq('id', booking.id)
            .lt('refunded_amount', refundedRupees); // a concurrent, larger total wins
          if (error) retryable.push(`refund mirror failed: ${error.message}`);
        }
      }
    }

    const failures = [...retryable, ...permanent];
    if (failures.length) {
      console.error('razorpay-webhook: processing failed', eventId, failures);
      // Stored on the event + alerts payments.view holders. A permanent failure
      // is acknowledged; a retryable one (or one we could not even record) is
      // not, so Razorpay delivers it again.
      const { error: recordError } = await admin.rpc('record_webhook_failure', { p_event_id: eventId, p_error: failures.join('; ') });
      if (recordError) return retryLater('could not record the processing failure', recordError.message);
      if (retryable.length) return retryLater('processing failed, retry requested', eventId);
      return new Response('ok', { status: 200 });
    }

    const { error: markError } = await admin.from('payment_webhook_events')
      .update({ processed: true, processed_at: now }).eq('event_id', eventId);
    // Processed but not marked: a redelivery re-runs the idempotent steps and marks it.
    if (markError) return retryLater('could not mark the event processed', markError.message);

    return new Response('ok', { status: 200 });
  } catch (err) {
    return retryLater('unexpected error', err);
  }
});
