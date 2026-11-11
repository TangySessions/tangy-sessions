import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { friendlyError } from '../api';
import { useAsync } from '../hooks';
import { Panel, Button, Input, Field, Badge, Modal, fmt, useToast } from '../ui';

// An event's ticket types (event_ticket_types, migration 0026). The price the
// customer pays is booking_quote() on the server: type price × quantity + tax.
// events.price follows the cheapest active type automatically. Types that
// have been sold are deactivated rather than deleted, so history stays intact.
const CODE_RE = /^[a-z][a-z0-9_]{0,31}$/;
// Online checkout can't take ₹0 (Razorpay), so a type costs at least ₹1 —
// also enforced by the database (0039). A legacy ₹0 type can still be edited
// without touching its price or putting it back on sale (e.g. taken off sale).
const MIN_PRICE = 1;
const priceError = (editing, price) => {
  if (!Number.isFinite(price) || !Number.isInteger(price) || price < 0 || price > 1000000) return 'Whole rupees, ₹1 – ₹10,00,000.';
  if (price >= MIN_PRICE) return null;
  const o = editing.original;
  const legacyUntouched = o && Number(o.price) === price && !(editing.active && !o.active);
  return legacyUntouched ? null : 'At least ₹1 — online checkout can’t take a ₹0 payment. Free tickets aren’t supported.';
};
const blank = { id: null, code: '', name: '', description: '', price: '', capacity: '', sort_order: 0, active: true };

export function TicketTypesEditor({ evt, counts, canManage }) {
  const toast = useToast();
  const [editing, setEditing] = useState(null);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);

  const types = useAsync(async () => {
    const { data, error } = await supabase.from('event_ticket_types').select('*').eq('event_id', evt.id).order('sort_order').order('price');
    if (error) throw friendlyError(error);
    const quotes = await Promise.all((data || []).filter((t) => t.active).map((t) =>
      supabase.rpc('booking_quote', { p_event_id: evt.id, p_ticket_type: t.code, p_quantity: 1 }).then(({ data: q }) => [t.code, q])));
    return { rows: data || [], quotes: Object.fromEntries(quotes) };
  }, [evt.id]);

  const save = async () => {
    const e = {};
    if (!editing.name.trim()) e.name = 'A name is required.';
    if (!editing.id && !CODE_RE.test(editing.code)) e.code = 'Lowercase letters, numbers and _ (starts with a letter).';
    const price = editing.price === '' ? NaN : Number(editing.price);
    const pe = priceError(editing, price);
    if (pe) e.price = pe;
    const capacity = editing.capacity === '' ? null : Number(editing.capacity);
    if (capacity != null && (!Number.isInteger(capacity) || capacity < 0)) e.capacity = 'Leave empty for no separate limit.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    const row = { name: editing.name.trim(), description: editing.description.trim() || null, price, capacity, sort_order: Number(editing.sort_order) || 0, active: editing.active };
    const { error } = editing.id
      ? await supabase.from('event_ticket_types').update(row).eq('id', editing.id)
      : await supabase.from('event_ticket_types').insert({ ...row, event_id: evt.id, code: editing.code });
    setSaving(false);
    if (error) { toast(/duplicate/i.test(error.message) ? 'That code is already used for this event.' : friendlyError(error).message, 'bad'); return; }
    toast('Ticket type saved — the public page and checkout use it immediately.');
    setEditing(null);
    types.reload();
  };

  const rows = types.data?.rows || [];
  return (
    <Panel
      title="Ticket types"
      subtitle="Prices are set here and charged by the server at checkout (price × people + tax). The session’s “from” price follows the cheapest active type."
      actions={canManage && <Button icon="Plus" onClick={() => { setErrors({}); setEditing({ ...blank, sort_order: rows.length + 1 }); }}>Add type</Button>}
      flush
    >
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]" data-ticket-types>
          <thead><tr className="border-b border-[#C99A2E]/20 font-mono text-[10px] uppercase tracking-wider text-[#E7D5A4]/60 text-left">
            <th className="px-4 py-2">Type</th><th className="px-4 py-2 text-right">Price</th><th className="px-4 py-2 text-right">With tax</th>
            <th className="px-4 py-2 text-right">Limit</th><th className="px-4 py-2 text-right">Issued</th><th className="px-4 py-2 text-right">Checked in</th><th className="px-4 py-2" />
          </tr></thead>
          <tbody>
            {types.loading && rows.length === 0 && <tr><td colSpan={7} className="px-4 py-3 text-[#E7D5A4]/60">Loading…</td></tr>}
            {types.error && <tr><td colSpan={7} className="px-4 py-3 text-[#ef6b5e]">{types.error.message}</td></tr>}
            {rows.map((t) => {
              const c = counts?.[t.code] || { issued: 0, checked_in: 0 };
              return (
                <tr key={t.id} className="border-b border-[#E7D5A4]/[0.06]">
                  <td className="px-4 py-2.5 text-[#EFE2C0]">
                    {t.name} <span className="font-mono text-[10px] text-[#E7D5A4]/60">{t.code}</span>
                    {!t.active && <span className="ml-2"><Badge status="archived">Not on sale</Badge></span>}
                    {t.active && t.price < MIN_PRICE && <span className="ml-2" data-zero-price><Badge tone="bad">₹0 — not sellable</Badge></span>}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{fmt.money(t.price)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-[#E7D5A4]/60">{types.data?.quotes[t.code] ? fmt.money(types.data.quotes[t.code].total) : '—'}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{t.capacity ?? '—'}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{fmt.num(c.issued)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{fmt.num(c.checked_in)}</td>
                  <td className="px-4 py-2.5 text-right">
                    {canManage && <Button size="sm" variant="ghost" icon="Pencil" aria-label={`Edit ${t.name}`} onClick={() => { setErrors({}); setEditing({ ...t, description: t.description || '', capacity: t.capacity ?? '', price: String(t.price), original: t }); }} />}
                  </td>
                </tr>
              );
            })}
            {!types.loading && rows.length === 0 && <tr><td colSpan={7} className="px-4 py-3 text-[#f5b544]">No ticket types — customers can’t book until one is added.</td></tr>}
          </tbody>
        </table>
      </div>
      {editing && (
        <Modal title={editing.id ? `Edit ${editing.name}` : 'New ticket type'} onClose={() => setEditing(null)} footer={(
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          </>
        )}>
          <Field label="Name *" error={errors.name}><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} maxLength={80} autoFocus /></Field>
          {!editing.id && <Field label="Code *" hint="Stored on bookings and tickets; can't be changed later." error={errors.code}><Input value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value.toLowerCase() })} maxLength={32} /></Field>}
          <Field label="Description"><Input value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} maxLength={300} /></Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Price (₹) *" hint="₹1 or more" error={errors.price}><Input inputMode="numeric" value={editing.price} onChange={(e) => setEditing({ ...editing, price: e.target.value })} /></Field>
            <Field label="Limit" hint="Optional" error={errors.capacity}><Input inputMode="numeric" value={editing.capacity} onChange={(e) => setEditing({ ...editing, capacity: e.target.value })} /></Field>
            <Field label="Order"><Input inputMode="numeric" value={editing.sort_order} onChange={(e) => setEditing({ ...editing, sort_order: e.target.value })} /></Field>
          </div>
          <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" className="w-4 h-4 accent-[#C99A2E]" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> On sale</label>
          {editing.id && <p className="text-[12px] text-[#E7D5A4]/55 m-0">Price changes apply to new checkouts only; existing bookings keep what they paid.</p>}
        </Modal>
      )}
    </Panel>
  );
}
