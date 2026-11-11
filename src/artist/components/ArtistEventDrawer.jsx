import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabaseClient';
import { Drawer, Panel, Badge, Button, Icon, Skeleton, fmt } from '../../admin/ui';
import { portalApi } from '../../portal/portalApi';
import { openPrivateFile } from '../../lib/storage';
import { downloadIcs, googleCalendarUrl } from '../../lib/ics';

import { tzTime, tzAbbr } from '../../lib/time';

export { tzTime };
const FEE = { pending: 'Fee pending', invoiced: 'Invoiced', paid: 'Paid' };
const mapsUrl = (e) => e.venue_map_url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([e.venue_name, e.venue_address, e.venue_city].filter(Boolean).join(', '))}`;

export function performanceIcsItem(e) {
  const where = [e.venue_name, e.venue_address, e.venue_city].filter(Boolean).join(', ');
  const notes = [e.call_time && `Call: ${tzTime(e.call_time, e.timezone)}`, e.soundcheck_at && `Soundcheck: ${tzTime(e.soundcheck_at, e.timezone)}`].filter(Boolean).join('\n');
  return e.starts_at
    ? { uid: `perf-${e.event_id}`, title: `Tangy: ${e.name}`, start: e.starts_at, end: e.ends_at, location: where, description: notes }
    : { uid: `perf-${e.event_id}`, title: `Tangy: ${e.name}`, date: e.event_date, location: where, description: notes };
}

const Row = ({ label, value }) => (value ? (
  <div className="flex justify-between gap-4 py-1.5 border-b border-[#E7D5A4]/[0.05] last:border-0">
    <dt className="font-mono text-[10.5px] uppercase tracking-wider text-[#E7D5A4]/60 pt-0.5">{label}</dt>
    <dd className="m-0 text-[13.5px] text-[#EFE2C0] text-right whitespace-pre-line">{value}</dd>
  </div>) : null);

export const ArtistEventDrawer = ({ event: e, onClose }) => {
  const [extra, setExtra] = useState(null);
  const [fileError, setFileError] = useState('');
  useEffect(() => {
    if (!e) return undefined;
    let cancelled = false;
    Promise.all([
      // A failed read is null (shown as "couldn't load"), never an empty list.
      portalApi.requirements().catch(() => null),
      portalApi.documents().catch(() => null),
      supabase.from('partner_invoices').select('invoice_number, amount, currency, status, due_date, paid_date').eq('event_id', e.event_id).then(({ data, error }) => (error ? null : data || [])),
    ]).then(([reqs, docs, invoices]) => {
      if (cancelled) return;
      setExtra({
        failed: reqs === null || docs === null || invoices === null,
        reqs: (reqs || []).filter((r) => r.event_id === e.event_id && ['requested', 'changes_requested', 'submitted'].includes(r.status)),
        docs: (docs || []).filter((d) => d.event_id === e.event_id),
        invoices: invoices || [],
      });
    });
    return () => { cancelled = true; };
  }, [e]);
  if (!e) return null;
  const tz = e.timezone || 'Asia/Kolkata';
  const ics = performanceIcsItem(e);
  const hospitality = [['Accommodation', e.accommodation], ['Meals', e.meals], ['Green room', e.green_room], ['Rider notes', e.rider_notes], ['Notes', e.hospitality]];
  const travel = [['Pickup', e.pickup], ['Drop', e.dropoff], ['Hotel', e.hotel], ['Transport', e.transport_notes], ['Notes', e.travel]];
  return (
    <Drawer title={e.name} subtitle={e.event_status === 'cancelled' ? 'This event has been cancelled' : `${fmt.date(e.event_date)} · times in ${tzAbbr(tz)}`} onClose={onClose}
      footer={<>
        <Button variant="ghost" icon="MessagesSquare" to="/artist/dashboard/messages">Message Tangy</Button>
        <Button icon="CalendarDays" onClick={() => downloadIcs([ics], `${e.name.replace(/\W+/g, '-').toLowerCase()}.ics`)}>Add to calendar</Button>
      </>}>
      <Panel title="Event">
        <dl>
          <Row label="Date" value={`${fmt.date(e.event_date)}${e.event_time ? ` · ${e.event_time}` : ''}`} />
          <Row label="Venue" value={[e.venue_name, e.venue_address, e.venue_city].filter(Boolean).join(', ') || 'To be confirmed'} />
          <Row label="Access" value={e.venue_access_info} />
          <Row label="Parking" value={e.venue_parking} />
        </dl>
        {e.venue_name && <a href={mapsUrl(e)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 mt-2 text-[13px] text-[#e4bd5c] underline underline-offset-2">Open map <Icon name="ArrowUpRight" size={13} /></a>}
      </Panel>
      <Panel title="Your schedule">
        {[e.call_time, e.soundcheck_at, e.doors_at, e.starts_at, e.wrap_at].some(Boolean) ? (
          <dl>
            <Row label="Call" value={tzTime(e.call_time, tz, true)} />
            <Row label="Soundcheck" value={tzTime(e.soundcheck_at, tz, true)} />
            <Row label="Doors" value={tzTime(e.doors_at, tz, true)} />
            <Row label="Performance" value={e.starts_at && `${tzTime(e.starts_at, tz, true)}${e.ends_at ? ` – ${tzTime(e.ends_at, tz)}` : ''}`} />
            <Row label="Wrap" value={tzTime(e.wrap_at, tz, true)} />
          </dl>
        ) : <p className="text-[13px] text-[#E7D5A4]/55">Tangy hasn't set your times yet — you'll be notified when they do.</p>}
        {e.starts_at && <a href={googleCalendarUrl({ title: ics.title, start: ics.start, end: ics.end, location: ics.location, description: ics.description })} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 mt-2 text-[12.5px] text-[#E7D5A4]/70 underline underline-offset-2">Add to Google Calendar <Icon name="ArrowUpRight" size={12} /></a>}
      </Panel>
      {e.instructions && <Panel title="Performance notes"><p className="text-[13.5px] text-[#E7D5A4]/80 whitespace-pre-line">{e.instructions}</p></Panel>}
      <Panel title="Hospitality">
        {hospitality.some(([, v]) => v) ? <dl>{hospitality.map(([k, v]) => <Row key={k} label={k} value={v} />)}</dl> : <p className="text-[13px] text-[#E7D5A4]/55">No hospitality details yet.</p>}
      </Panel>
      <Panel title="Travel">
        {travel.some(([, v]) => v) ? <dl>{travel.map(([k, v]) => <Row key={k} label={k} value={v} />)}</dl> : <p className="text-[13px] text-[#E7D5A4]/55">No travel details yet.</p>}
      </Panel>
      <Panel title="Payment">
        <dl>
          <Row label="Fee" value={e.fee_amount != null ? fmt.money(e.fee_amount) : 'Not shared'} />
          <Row label="Status" value={FEE[e.fee_status] || 'Not applicable'} />
          {(extra?.invoices || []).map((i) => <Row key={i.invoice_number} label={`Invoice ${i.invoice_number}`} value={`${i.currency} ${fmt.num(i.amount)} · ${i.status}${i.due_date ? ` · due ${fmt.date(i.due_date)}` : ''}`} />)}
        </dl>
      </Panel>
      <Panel title="Requirements">
        {extra?.failed && <p role="alert" data-drawer-error className="text-[13px] text-[#ef6b5e] m-0">Some details for this event couldn't be loaded. Close and reopen to try again.</p>}
        {extra === null ? <Skeleton rows={2} /> : extra.reqs.length === 0 ? <p className="text-[13px] text-[#E7D5A4]/55">{extra.failed ? '—' : 'Nothing needed from you for this event.'}</p> : (
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {extra.reqs.map((r) => <li key={r.id} className="flex items-center justify-between gap-2"><span>{r.title}</span><Badge tone={r.status === 'submitted' ? 'info' : 'warn'}>{r.status.replace('_', ' ')}</Badge></li>)}
            <li><Link to="/artist/dashboard/requirements" className="text-[#e4bd5c] underline underline-offset-2 text-[12.5px]">Respond to requirements</Link></li>
          </ul>
        )}
      </Panel>
      <Panel title="Documents">
        {extra === null ? <Skeleton rows={2} /> : extra.docs.length === 0 ? <p className="text-[13px] text-[#E7D5A4]/55">{extra.failed ? '—' : 'No documents for this event yet.'}</p> : (
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {extra.docs.map((d) => (
              <li key={d.id}>
                <button className="inline-flex items-center gap-1.5 text-[#e4bd5c] underline underline-offset-2"
                  onClick={() => (d.storage_path ? openPrivateFile('event-documents', d.storage_path).catch((err) => setFileError(err.message)) : window.open(d.url, '_blank', 'noopener,noreferrer'))}>
                  <Icon name="FileText" size={14} />{d.title}
                </button>
              </li>
            ))}
          </ul>
        )}
        {fileError && <p role="alert" className="text-[12.5px] text-[#ef6b5e] mt-2">{fileError}</p>}
      </Panel>
      <Panel title="Contact"><p className="text-[13.5px] text-[#E7D5A4]/80">{e.tangy_contact || 'Tangy team'} · message the Tangy team from your workspace.</p></Panel>
    </Drawer>
  );
};
