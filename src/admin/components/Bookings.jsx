import { useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { bookingService } from '../../lib/bookingService';
import { generateQrDataUrl } from '../../lib/qr';
import { checkinService, partyState } from '../../lib/checkinService';
import { collabLabel } from '../../lib/bookingForm';
import { useAdminSession } from '../AdminSession';
import { adminApi, orIlike, friendlyError } from '../api';
import { useServerTable, useDebounced, useAsync } from '../hooks';
import { P, TICKET_TIERS } from '../rbac';
import { auditLabel, auditSummary } from '../auditLabels';
import {
  Panel, Toolbar, SearchInput, FilterSelect, DataTable, Pagination, Badge, Drawer, KeyValue, Button, ConfirmDialog,
  Modal, Field, Input, Select, Textarea, Icon, fmt, useToast,
} from '../ui';

const TIER_NAME = Object.fromEntries(TICKET_TIERS.map((t) => [t.id, t.name]));
export const BOOKING_STATUSES = [
  { value: '', label: 'Any status' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'pending', label: 'Pending payment' },
  { value: 'failed', label: 'Payment failed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'expired', label: 'Expired (unpaid)' },
];
const PAYMENT_STATUS = {
  created: 'Checkout started', authorized: 'Authorized', captured: 'Captured', failed: 'Failed',
  refunded: 'Refunded in Razorpay', partially_refunded: 'Partially refunded in Razorpay', not_required: 'Not required',
};
const PAYMENT_FILTERS = [
  { value: '', label: 'Any payment' },
  { value: 'verified', label: 'Razorpay verified' },
  { value: 'unverified', label: 'Not verified' },
  { value: 'complimentary', label: 'Complimentary' },
];
const EMAIL_FILTERS = [
  { value: '', label: 'Any ticket email' },
  { value: 'sent', label: 'Email sent' },
  { value: 'failed', label: 'Email failed' },
  { value: 'pending', label: 'Email pending' },
];

export function useEventOptions() {
  return useAsync(async () => {
    const { data, error } = await supabase.from('events').select('id, name, event_date, status').order('event_date', { ascending: false }).limit(300);
    if (error) throw friendlyError(error);
    return data || [];
  }, []).data || [];
}

export const EventFilter = ({ value, onChange, events, allLabel = 'All events' }) => (
  <FilterSelect label="Event" value={value} onChange={onChange} className="max-w-[240px]"
    options={[{ value: '', label: allLabel }, ...events.map((e) => ({ value: e.id, label: `${e.name} · ${fmt.date(e.event_date)}` }))]} />
);

const TicketQr = ({ token, kind = 'TICKET' }) => {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let cancelled = false;
    generateQrDataUrl(`TANGY:${kind}:${token}`).then((u) => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [token, kind]);
  const alt = kind === 'BOOKING' ? 'Group check-in QR code' : 'Ticket QR code';
  return url ? <img src={url} alt={alt} className="w-40 h-40 rounded" /> : <div className="w-40 h-40 bg-[#E7D5A4]/5 rounded" />;
};

export const BookingDrawer = ({ bookingId, onClose, onChanged, inline = false }) => {
  const { can } = useAdminSession();
  const toast = useToast();
  const [dialog, setDialog] = useState(null);
  const [qrFor, setQrFor] = useState(null);
  const { data: b, loading, error, reload } = useAsync(async () => {
    const { data, error: err } = await supabase
      .from('bookings')
      .select('*, events(id, name, event_date, booking_questions), tickets(id, ticket_number, tier, status, token, created_at, attendee_name), checkins(id, ticket_id, checked_in_at, method)')
      .eq('id', bookingId)
      .maybeSingle();
    if (err) throw friendlyError(err);
    return data;
  }, [bookingId]);
  const arrivals = useAsync(() => checkinService.bookingHistory(bookingId), [bookingId]);
  // Previous Tangy attendance is derived from booking history, never asked.
  const returning = useAsync(async () => {
    if (!b?.user_id) return null;
    const { count } = await supabase.from('bookings').select('id', { count: 'exact', head: true })
      .eq('user_id', b.user_id).eq('status', 'confirmed').neq('id', b.id);
    return count ?? 0;
  }, [b?.id, b?.user_id]);
  const history = useAsync(async () => {
    if (!can(P.AUDIT)) return [];
    const { data } = await supabase.from('audit_logs').select('id, created_at, actor_email, action, metadata, resource_id')
      .eq('resource_id', bookingId).order('created_at', { ascending: false }).limit(20);
    return data || [];
  }, [bookingId]);

  const changed = () => { reload(); history.reload(); arrivals.reload(); onChanged?.(); };
  const party = (b?.tickets || []).filter((t) => t.status !== 'cancelled').length;
  const inCount = (b?.tickets || []).filter((t) => t.status === 'checked_in').length;
  const partyStatus = partyState(inCount, party);
  const checkinByTicket = Object.fromEntries((b?.checkins || []).map((c) => [c.ticket_id, c]));
  const paid = b && b.source === 'online' && b.razorpay_payment_id;
  const canManage = can(P.BOOKINGS_MANAGE);

  const resendEmail = async () => {
    const res = await bookingService.sendTicketEmail(b.id, { force: true });
    toast(res.success ? 'Ticket email sent' : res.error || 'Could not send email', res.success ? 'good' : 'bad');
    reload();
  };

  return (
    <Drawer
      inline={inline}
      title={b ? b.registration_code : 'Booking'}
      subtitle={b ? `${b.attendee_name} · ${b.events?.name || ''}` : null}
      onClose={onClose}
      footer={b && canManage ? (
        <>
          {can(P.PAYMENTS) && paid && ['confirmed', 'cancelled'].includes(b.status) && (
            <Button variant="secondary" onClick={() => setDialog('refund')}>Record refund</Button>
          )}
          {['pending', 'confirmed'].includes(b.status) && <Button variant="danger" icon="Ban" onClick={() => setDialog('cancel')}>Cancel booking</Button>}
        </>
      ) : null}
    >
      {loading && !b ? <div className="text-[13px] text-[#E7D5A4]/60">Loading…</div> : error ? <div className="text-[#ef6b5e] text-[13px]">{error.message}</div> : !b ? (
        <div className="text-[13px] text-[#E7D5A4]/60">Booking not found.</div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2"><Badge status={b.status} />{b.source === 'complimentary' && <Badge status="complimentary" />}</div>
          <Panel title="Primary booker">
            <KeyValue items={[
              ['Name', b.attendee_name],
              ['Mobile / WhatsApp', b.attendee_phone],
              ['Email', b.attendee_email],
              b.contact_instagram && ['Instagram', `@${b.contact_instagram}`],
              ['Previous bookings', b.user_id ? (returning.data == null ? '…' : returning.data === 0 ? 'First Tangy booking' : `${returning.data} other confirmed booking${returning.data === 1 ? '' : 's'}`) : 'Guest (no account)'],
              ['Event', b.events ? `${b.events.name} · ${fmt.date(b.events.event_date)}` : '—'],
              ['Tickets', `${b.quantity} × ${TIER_NAME[b.tier] || b.tier || 'General'}`],
              ['Booked', fmt.dateTime(b.created_at)],
            ]} />
          </Panel>
          {(() => {
            // Answers to this event's questions (0024), in the event's order.
            const qs = b.events?.booking_questions || [];
            const fmtAnswer = (q, v) => (Array.isArray(v) ? v.join(', ') : q?.type === 'boolean' ? (v ? 'Yes' : 'No') : q?.type === 'date' ? fmt.date(v) : String(v));
            const answered = Object.entries(b.booking_answers || {});
            const rows = [
              ...answered.map(([k, v]) => { const q = qs.find((x) => x.id === k); return [q?.label || k, fmtAnswer(q, v)]; }),
              b.collab_interests?.length && ['Interested in collaborating', b.collab_interests.map(collabLabel).join(', ')],
              b.collab_note && ['About that', b.collab_note],
              b.customer_note && ['Note from booker', b.customer_note],
            ].filter(Boolean);
            return rows.length > 0 && <Panel title="Booking details" subtitle="From the booking form — visible to the Tangy team only"><div data-booking-details><KeyValue items={rows} /></div></Panel>;
          })()}
          {can(P.PAYMENTS) && (
            <Panel title="Payment" subtitle="Payment state is written only by the Razorpay functions">
              <KeyValue items={[
                ['Amount', b.source === 'complimentary' ? 'Complimentary (₹0)' : fmt.money(b.amount)],
                ['Razorpay order', b.razorpay_order_id],
                ['Razorpay payment', b.razorpay_payment_id],
                ['Signature', b.razorpay_signature_verified ? <Badge tone="good">Verified</Badge> : <Badge tone="muted">Not verified</Badge>],
                b.payment_status && ['Payment status', `${PAYMENT_STATUS[b.payment_status] || b.payment_status}${b.payment_updated_at ? ` · ${fmt.dateTime(b.payment_updated_at)}` : ''}`],
                b.refunded_amount > 0 && ['Refunded amount', fmt.money(b.refunded_amount)],
                b.expired_at && ['Expired', `${fmt.dateTime(b.expired_at)} — checkout not completed in time`],
                b.refund_reference && ['Refund', `Refund recorded manually in Razorpay · ${b.refund_reference}`],
                b.cancel_reason && ['Cancel reason', b.cancel_reason],
                b.cancelled_at && ['Cancelled', fmt.dateTime(b.cancelled_at)],
              ]} />
            </Panel>
          )}
          <Panel title={`Tickets (${(b.tickets || []).length})`} flush
            actions={b.status === 'confirmed' && (
              <span className="flex items-center gap-2">
                <Badge status={b.ticket_email_status === 'sent' ? 'confirmed' : b.ticket_email_status}>{`Email ${b.ticket_email_status}`}</Badge>
                {canManage && <Button size="sm" onClick={resendEmail}>Resend</Button>}
              </span>
            )}>
            {(b.tickets || []).length === 0 ? (
              <div className="p-4 text-[12.5px] text-[#E7D5A4]/60">No tickets issued — tickets are created only when payment is confirmed.</div>
            ) : (
              <ul className="divide-y divide-[#E7D5A4]/[0.06]">
                {[...b.tickets].sort((x, y) => x.ticket_number.localeCompare(y.ticket_number)).map((t) => {
                  const c = checkinByTicket[t.id];
                  return (
                    <li key={t.id} className="px-4 py-2.5">
                      <div className="flex items-center gap-3 text-[12.5px]">
                        <span className="font-mono text-[#C99A2E]">{t.ticket_number}</span>
                        <span className="text-[#EFE2C0] flex-1 min-w-0 truncate">{t.attendee_name || <span className="text-[#E7D5A4]/60">Name not recorded</span>} <span className="text-[#E7D5A4]/60">· {TIER_NAME[t.tier] || t.tier}</span></span>
                        <Badge status={t.status} />
                        {t.status === 'valid' && <Button size="sm" variant="ghost" icon="QrCode" aria-label="Show QR" onClick={() => setQrFor(qrFor === t.id ? null : t.id)} />}
                        {canManage && t.status === 'valid' && <Button size="sm" variant="ghost" icon="Ban" aria-label="Cancel ticket" onClick={() => setDialog({ ticket: t })} />}
                      </div>
                      {c && <div className="text-[11.5px] text-[#E7D5A4]/60 mt-1">Checked in {fmt.dateTime(c.checked_in_at)} · {c.method}</div>}
                      {qrFor === t.id && <div className="mt-2"><TicketQr token={t.token} /></div>}
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
          {party > 0 && (
            <Panel title="Check-in history" subtitle={`${inCount} / ${party} checked in`} flush
              actions={partyStatus && <Badge tone={partyStatus.tone}><span className="inline-flex items-center gap-1"><Icon name={partyStatus.icon} size={11} />{partyStatus.label}</span></Badge>}>
              {b.status === 'confirmed' && inCount < party && (
                <div className="px-4 py-3 border-b border-[#E7D5A4]/[0.06] flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex-1 text-[12.5px] text-[#E7D5A4]/65">One booking QR — staff pick which of the {party - inCount} pending attendees are present.</div>
                  <Button size="sm" variant="ghost" icon="QrCode" onClick={() => setQrFor(qrFor === 'group' ? null : 'group')}>{qrFor === 'group' ? 'Hide booking QR' : 'Booking QR'}</Button>
                </div>
              )}
              {qrFor === 'group' && b.group_token && <div className="px-4 py-3"><TicketQr token={b.group_token} kind="BOOKING" /></div>}
              {arrivals.error ? (
                <div role="alert" className="px-4 py-3 text-[12.5px] text-[#ffc4bd] flex items-center gap-3">
                  <span className="flex-1">Couldn't load arrivals. {arrivals.error.message}</span>
                  <Button size="sm" variant="ghost" onClick={arrivals.reload}>Retry</Button>
                </div>
              ) : arrivals.loading && !arrivals.data ? <div className="px-4 py-3 text-[12.5px] text-[#E7D5A4]/60">Loading arrivals…</div>
              : (arrivals.data || []).length === 0 ? <div className="px-4 py-3 text-[12.5px] text-[#E7D5A4]/60">No one has checked in yet.</div> : (
                <ul className="divide-y divide-[#E7D5A4]/[0.06]" data-arrivals>
                  {arrivals.data.map((a) => (
                    <li key={a.ticket_number} className="px-4 py-2.5 text-[12.5px] flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      <span className="font-mono text-[#E7D5A4]/60">{fmt.time(a.checked_in_at)}</span>
                      <span className="text-[#EFE2C0]">{a.attendee_name || `Guest ${Number(a.ticket_number.slice(-2))}`}</span>
                      <span className="text-[#E7D5A4]/60">checked in by {a.checked_in_by_name || 'unknown'}{a.method === 'manual' ? ' · manual' : ''}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          )}
          {can(P.AUDIT) && (history.data || []).length > 0 && (
            <Panel title="History" flush>
              <ul className="divide-y divide-[#E7D5A4]/[0.06]">
                {history.data.map((h) => (
                  <li key={h.id} className="px-4 py-2 text-[12px]">
                    <span className="text-[#EFE2C0]">{auditLabel(h.action)}</span>
                    <span className="text-[#E7D5A4]/60"> · {h.actor_email || 'System'} · {fmt.dateTime(h.created_at)}</span>
                    {auditSummary(h) && <div className="text-[#E7D5A4]/60">{auditSummary(h)}</div>}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}

      {dialog === 'cancel' && (
        <ConfirmDialog
          title={`Cancel ${b.registration_code}?`}
          message={paid ? 'Valid tickets are voided. This does NOT refund the payment — issue the refund in Razorpay, then record it here.' : 'Valid tickets are voided and the capacity is released.'}
          confirmLabel="Cancel booking" tone="danger"
          fields={[{ name: 'reason', label: 'Reason', required: true, multiline: true, autoFocus: true }]}
          onConfirm={async ({ reason }) => { await adminApi.cancelBooking(b.id, reason); toast('Booking cancelled'); changed(); }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'refund' && (
        <ConfirmDialog
          title={`Record refund for ${b.registration_code}`}
          message={`Records a refund of ${fmt.money(b.amount)} that was already issued in the Razorpay dashboard. No money moves from here.`}
          confirmLabel="Record refund" tone="danger"
          fields={[
            { name: 'reference', label: 'Razorpay refund ID', required: true, placeholder: 'rfnd_…', autoFocus: true },
            { name: 'reason', label: 'Reason', required: true, multiline: true },
          ]}
          onConfirm={async ({ reason, reference }) => { await adminApi.recordRefund(b.id, reason, reference); toast('Refund recorded'); changed(); }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.ticket && (
        <ConfirmDialog
          title={`Cancel ticket ${dialog.ticket.ticket_number}?`}
          message="The QR code stops working immediately."
          confirmLabel="Cancel ticket" tone="danger"
          fields={[{ name: 'reason', label: 'Reason', required: true, autoFocus: true }]}
          onConfirm={async ({ reason }) => { await adminApi.cancelTicket(dialog.ticket.id, reason); toast('Ticket cancelled'); changed(); }}
          onClose={() => setDialog(null)}
        />
      )}
    </Drawer>
  );
};

export const CompBookingModal = ({ eventId: fixedEventId, onClose, onCreated }) => {
  const events = useEventOptions().filter((e) => !['cancelled', 'past'].includes(e.status));
  const toast = useToast();
  const [f, setF] = useState({ eventId: fixedEventId || '', name: '', email: '', phone: '', quantity: 1, tier: 'gen', note: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const valid = f.eventId && f.name.trim() && /\S+@\S+\.\S+/.test(f.email) && f.note.trim() && f.quantity >= 1 && f.quantity <= 10;
  // The event's own ticket types (0026) — any type, including ones not on sale.
  const types = useAsync(async () => {
    if (!f.eventId) return [];
    const { data, error: err } = await supabase.from('event_ticket_types').select('code, name, active').eq('event_id', f.eventId).order('sort_order');
    if (err) throw friendlyError(err);
    return data || [];
  }, [f.eventId]);
  const typeOptions = types.data?.length ? types.data.map((t) => ({ id: t.code, name: t.active ? t.name : `${t.name} (not on sale)` })) : TICKET_TIERS.slice(0, 1);

  const submit = async (e) => {
    e?.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError('');
    try {
      const booking = await adminApi.createCompBooking(f);
      toast(`Complimentary booking ${booking.registration_code} created`);
      onCreated?.(booking);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Complimentary booking" onClose={onClose} wide
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid || busy} onClick={submit}>{busy ? 'Creating…' : 'Create & issue tickets'}</Button></>}>
      <p className="text-[12.5px] text-[#E7D5A4]/55">For guest lists and artist +1s. Amount is ₹0, marked complimentary, counts against capacity, and is logged with your note. Use the ticket email "Resend" action to send the QR codes.</p>
      <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {!fixedEventId && (
          <Field label="Event *" className="sm:col-span-2">
            <Select value={f.eventId} onChange={set('eventId')}>
              <option value="">Select event…</option>
              {events.map((e) => <option key={e.id} value={e.id}>{e.name} · {fmt.date(e.event_date)}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Attendee name *"><Input value={f.name} onChange={set('name')} /></Field>
        <Field label="Email *"><Input type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={set('phone')} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity *"><Input type="number" min="1" max="10" value={f.quantity} onChange={set('quantity')} /></Field>
          <Field label="Ticket type"><Select value={f.tier} onChange={set('tier')}>{typeOptions.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
        </div>
        <Field label="Note *" hint="Why this is complimentary (logged)" className="sm:col-span-2"><Textarea rows={2} value={f.note} onChange={set('note')} /></Field>
      </form>
      {error && <div role="alert" className="text-[12.5px] text-[#ef6b5e] bg-[#a8322a]/10 border border-[#a8322a]/40 rounded px-3 py-2">{error}</div>}
    </Modal>
  );
};

// Server-filtered bookings list. `eventId` pins it to one event (event tab).
export const BookingsTable = ({ eventId, initialStatus = '', initialEmail = '', initialSearch = '', compOpen = false, onCompClose }) => {
  const { can } = useAdminSession();
  const events = useEventOptions();
  const [event, setEvent] = useState('');
  const [status, setStatus] = useState(initialStatus);
  const [payment, setPayment] = useState('');
  const [email, setEmail] = useState(initialEmail);
  const [search, setSearch] = useState(initialSearch);
  const q = useDebounced(search);
  const navigate = useNavigate();
  const [comp, setComp] = useState(compOpen);
  const scopedEvent = eventId || event;

  const table = useServerTable({
    table: 'bookings',
    select: 'id, registration_code, attendee_name, attendee_email, quantity, tier, amount, status, source, razorpay_signature_verified, ticket_email_status, created_at, events(name, event_date)',
    deps: [scopedEvent, status, payment, email, q],
    build: (query) => {
      let x = query.order('created_at', { ascending: false });
      if (scopedEvent) x = x.eq('event_id', scopedEvent);
      if (status) x = x.eq('status', status);
      if (payment === 'verified') x = x.eq('razorpay_signature_verified', true);
      if (payment === 'unverified') x = x.eq('razorpay_signature_verified', false).eq('source', 'online');
      if (payment === 'complimentary') x = x.eq('source', 'complimentary');
      if (email) x = x.eq('ticket_email_status', email).eq('status', 'confirmed');
      return orIlike(x, ['registration_code', 'attendee_name', 'attendee_email', 'razorpay_order_id', 'razorpay_payment_id'], q);
    },
  });

  const columns = [
    { key: 'code', header: 'Booking', render: (b) => <span className="font-mono text-[12px] text-[#C99A2E]">{b.registration_code}</span> },
    { key: 'attendee', header: 'Attendee', render: (b) => (<div className="min-w-0"><div className="text-[#EFE2C0]">{b.attendee_name}</div><div className="text-[12px] text-[#E7D5A4]/60 truncate max-w-[220px]">{b.attendee_email}</div></div>) },
    { key: 'event', header: 'Event', hidden: !!eventId, render: (b) => <span className="text-[12.5px]">{b.events?.name || '—'}</span> },
    { key: 'qty', header: 'Tickets', render: (b) => <span className="text-[12.5px]">{b.quantity} × {TIER_NAME[b.tier]?.split(' ')[0] || b.tier || 'Gen'}</span> },
    { key: 'amount', header: 'Amount', align: 'right', hidden: !can(P.PAYMENTS), render: (b) => (b.source === 'complimentary' ? <Badge status="complimentary">Comp</Badge> : fmt.money(b.amount)) },
    { key: 'payment', header: 'Payment', mobileHidden: true, hidden: !can(P.PAYMENTS), render: (b) => (b.source === 'complimentary' ? <span className="text-[#E7D5A4]/60">—</span> : b.razorpay_signature_verified ? <Badge tone="good">Verified</Badge> : <Badge tone="muted">Unverified</Badge>) },
    { key: 'status', header: 'Status', render: (b) => <Badge status={b.status} /> },
    { key: 'created', header: 'Booked', mobileHidden: true, render: (b) => <span className="font-mono text-[11.5px] text-[#E7D5A4]/55">{fmt.dateTime(b.created_at)}</span> },
  ];

  return (
    <Panel flush>
      <div className="p-3 border-b border-[#C99A2E]/15">
        <Toolbar right={
          <>
            <span className="font-mono text-[11px] text-[#E7D5A4]/60">{fmt.num(table.count)} booking{table.count === 1 ? '' : 's'}</span>
            {can(P.BOOKINGS_MANAGE) && <Button size="sm" icon="Plus" onClick={() => setComp(true)}>Complimentary</Button>}
          </>
        }>
          <SearchInput value={search} onChange={setSearch} placeholder="Code, name, email, Razorpay ID…" />
          {!eventId && <EventFilter value={event} onChange={setEvent} events={events} />}
          <FilterSelect label="Booking status" value={status} onChange={setStatus} options={BOOKING_STATUSES} />
          {can(P.PAYMENTS) && <FilterSelect label="Payment" value={payment} onChange={setPayment} options={PAYMENT_FILTERS} />}
          <FilterSelect label="Ticket email" value={email} onChange={setEmail} options={EMAIL_FILTERS} />
        </Toolbar>
      </div>
      <DataTable columns={columns} rows={table.rows} loading={table.loading} error={table.error} onRetry={table.reload}
        onRowClick={(b) => navigate(`/admin-portal/bookings/${b.id}`)} empty={{ title: 'No bookings found', hint: 'Adjust the filters, or wait for the first sale.', icon: 'Ticket' }} />
      <Pagination {...table} />
      {comp && <CompBookingModal eventId={eventId} onClose={() => { setComp(false); onCompClose?.(); }} onCreated={(bk) => navigate(`/admin-portal/bookings/${bk.id}`)} />}
    </Panel>
  );
};
