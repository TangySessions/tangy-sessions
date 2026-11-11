import { useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { insert, update, friendlyError } from '../api';
import { useAsync } from '../hooks';
import { useSetting } from '../AdminSession';
import { EVENT_STATUSES, EVENT_STATUS_LABELS } from '../rbac';
import { Panel, Field, Input, Textarea, Select, Button, Modal, fmt } from '../ui';
import { useVenueOptions } from './EventForm';
import { ArtistAvailabilityList, ArtistCalendarDrawer } from './ArtistAvailability';
import { AvailabilityPill } from '../../components/calendar/availability';
import { zonedIso } from '../../lib/calendarDates';
import { BACKGROUND_PRESETS, isDarkEnough, isBackgroundImage, useSessionBackground } from '../../lib/sessionBackground';

const cx = (...a) => a.filter(Boolean).join(' ');
const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York'];
const CATEGORIES = [['', 'No category'], ['concert', 'Concert'], ['workshop', 'Workshop'], ['heritage_walk', 'Heritage walk'],
  ['festival', 'Festival'], ['talk', 'Talk'], ['private', 'Private session'], ['other', 'Other']];
const SECTIONS = [
  ['basics', 'Event basics'], ['schedule', 'Date & time'], ['venue', 'Venue'], ['artists', 'Artists'],
  ['capacity', 'Capacity & tickets'], ['content', 'Content'], ['publishing', 'Publishing'], ['notifications', 'Notifications'],
];

const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const minutes = (t) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
const overlaps = (a, b) => a.start && a.end && b.start && b.end && minutes(a.start) < minutes(b.end) && minutes(a.end) > minutes(b.start);

function validate(f, lineup, isEdit) {
  const e = {};
  if (!f.name.trim()) e.name = 'Required';
  if (!f.event_date) e.event_date = 'Required';
  if (f.slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.slug)) e.slug = 'Lowercase letters, numbers and dashes only';
  if (!(Number(f.capacity) >= 0) || !Number.isInteger(Number(f.capacity))) e.capacity = 'Whole number ≥ 0';
  if (!(Number(f.price) >= 0) || !Number.isInteger(Number(f.price))) e.price = 'Whole rupees ≥ 0';
  // A new event's price becomes its first ticket type, which must be ≥ ₹1
  // (online checkout can't take ₹0; 0039 enforces it in the database).
  else if (!isEdit && Number(f.price) < 1) e.price = 'At least ₹1 — online checkout can’t take a ₹0 payment';
  if (f.status === 'on-sale' && Number(f.capacity) === 0) e.capacity = 'An on-sale event needs capacity';
  const bg = f.page_background;
  if (bg && bg !== 'cover' && bg.startsWith('#') && !isDarkEnough(bg)) e.page_background = 'Pick a darker colour so the cream text stays readable.';
  if (bg && bg !== 'cover' && !bg.startsWith('#') && !isBackgroundImage(bg)) e.page_background = 'Use an https:// link or a /media/ path.';
  lineup.forEach((a, i) => {
    if (a.start && a.end && minutes(a.end) <= minutes(a.start)) e[`set-${i}`] = 'The set must end after it starts';
    else if (lineup.some((b, j) => j !== i && overlaps(a, b))) e[`set-${i}`] = 'Overlaps another set';
  });
  return e;
}

// This session's own page background (its page and booking page).
const BackgroundField = ({ value, onChange, cover, error }) => {
  const [mode, setMode] = useState(() => (!value ? 'default' : value === 'cover' ? 'cover' : value.startsWith('#') ? 'color' : 'image'));
  const preview = useSessionBackground(value, cover);
  const opt = (m, label, next) => (
    <button key={m} type="button" aria-pressed={mode === m} onClick={() => { setMode(m); onChange(next); }}
      className={cx('min-h-[36px] max-sm:min-h-[44px] px-3 rounded-[4px] border font-mono text-[11px] uppercase tracking-[0.06em]',
        mode === m ? 'bg-[#C99A2E] border-[#C99A2E] text-[#11100C]' : 'border-[#C99A2E]/35 text-[#E7D5A4]')}>{label}</button>
  );
  return (
    <fieldset className="border-0 p-0 m-0 flex flex-col gap-2" data-background-field>
      <legend className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-[#C99A2E]/85 mb-1.5">Page background</legend>
      <div role="group" aria-label="Page background" className="flex flex-wrap gap-1.5">
        {opt('default', 'Site texture', null)}{opt('cover', 'Cover photo', 'cover')}{opt('color', 'Colour', mode === 'color' ? value : '#1E2440')}{opt('image', 'Image link', mode === 'image' ? value : null)}
      </div>
      {mode === 'color' && (
        <div className="flex flex-wrap items-center gap-2">
          {BACKGROUND_PRESETS.map(([hex, label]) => (
            <button key={hex} type="button" onClick={() => onChange(hex)} aria-label={label} aria-pressed={value?.toLowerCase() === hex.toLowerCase()} title={label}
              className={cx('w-9 h-9 max-sm:w-11 max-sm:h-11 rounded border-2', value?.toLowerCase() === hex.toLowerCase() ? 'border-[#C99A2E]' : 'border-[#E7D5A4]/20')} style={{ backgroundColor: hex }} />
          ))}
          <label className="flex items-center gap-2 text-[12px] text-[#E7D5A4]/75">Custom <input type="color" value={value || '#1E2440'} onChange={(e) => onChange(e.target.value)} className="w-10 h-9 bg-transparent border border-[#C99A2E]/30 rounded" /></label>
        </div>
      )}
      {mode === 'image' && <Input value={value || ''} onChange={(e) => onChange(e.target.value || null)} placeholder="https://… or /media/gallery/tangy3.jpg" aria-label="Background image link" />}
      {mode === 'default' && <span className="text-[11.5px] text-[#E7D5A4]/65">The same textured background as the rest of the site.</span>}
      {mode === 'cover' && <span className="text-[11.5px] text-[#E7D5A4]/65">The session's cover photo, blurred and darkened behind the page.{cover ? '' : ' Add a cover image to see it.'}</span>}
      {error && <span role="alert" className="text-[11.5px] text-[#ef6b5e]">{error}</span>}
      <div className="theme-sessions relative isolate overflow-hidden rounded border border-[#C99A2E]/20 p-4 text-[#ecdcaf]" data-background-preview>
        <div aria-hidden="true" className="absolute inset-0 -z-10" style={preview} data-background-preview-layer />
        <span className="relative block font-condensed uppercase text-lg leading-tight">Preview — session page</span>
        <span className="relative block text-[12px] opacity-80">Cream text sits on this background on the session's page and its booking page.</span>
      </div>
    </fieldset>
  );
};

// One artist on the line-up being built (removable card with performance details).
const LineupCard = ({ item, error, onChange, onRemove, onCalendar }) => {
  const name = item.artist.stage_name || item.artist.name;
  const set = (k) => (e) => onChange({ ...item, [k]: e.target.value });
  return (
    <li className="border border-[#C99A2E]/25 rounded-md bg-[#11100C] p-3 flex flex-col gap-3" data-lineup-card={name}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="flex-1 min-w-[160px]">
          <div className="text-[14px] text-[#EFE2C0] flex flex-wrap items-center gap-2">{name} <AvailabilityPill status={item.artist.status} detail={item.artist.detail} /></div>
          <div className="text-[12px] text-[#E7D5A4]/60">{[item.artist.genre, item.artist.city].filter(Boolean).join(' · ')}{item.artist.detail ? ` · ${item.artist.detail}` : ''}</div>
          {item.override && <div className="text-[12px] text-[#f5b544] mt-1">Marked unavailable — you chose to override. This is recorded.</div>}
        </div>
        <Button size="sm" variant="ghost" icon="CalendarDays" className="max-sm:h-11" onClick={onCalendar}>Calendar</Button>
        <Button size="sm" variant="ghost" icon="X" className="max-sm:h-11" onClick={onRemove} aria-label={`Remove ${name}`}>Remove</Button>
      </div>
      <div role="group" aria-label={`How to add ${name}`} className="flex flex-wrap gap-1.5">
        {[['assign', 'Add to line-up'], ['request', 'Send session request']].map(([m, label]) => (
          <button key={m} type="button" aria-pressed={item.mode === m} disabled={m === 'request' && !item.artist.has_account}
            onClick={() => onChange({ ...item, mode: m })}
            className={cx('min-h-[36px] max-sm:min-h-[44px] px-3 rounded-[4px] border font-mono text-[11px] uppercase tracking-[0.06em] disabled:opacity-40',
              item.mode === m ? 'bg-[#C99A2E] border-[#C99A2E] text-[#11100C]' : 'border-[#C99A2E]/35 text-[#E7D5A4]')}>{label}</button>
        ))}
        {!item.artist.has_account && <span className="text-[11.5px] text-[#E7D5A4]/60 self-center">No portal account — add directly.</span>}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
        <Field label="Order" className="sm:col-span-1"><Input type="number" min="1" max="50" value={item.performance_order} onChange={set('performance_order')} aria-label={`Performance order for ${name}`} /></Field>
        <Field label="Performance" className="sm:col-span-2"><Input value={item.performance_type} onChange={set('performance_type')} placeholder="Live set" aria-label={`Performance type for ${name}`} /></Field>
        <Field label="Set (min)"><Input type="number" min="5" max="600" value={item.set_minutes} onChange={set('set_minutes')} aria-label={`Set length for ${name}`} /></Field>
        <Field label="Start" error={error}><Input type="time" value={item.start} onChange={set('start')} aria-label={`Set start for ${name}`} /></Field>
        <Field label="End"><Input type="time" value={item.end} onChange={set('end')} aria-label={`Set end for ${name}`} /></Field>
        <Field label="Notes" className="col-span-2 sm:col-span-4"><Input value={item.notes} onChange={set('notes')} placeholder="Optional" aria-label={`Notes for ${name}`} /></Field>
        <Field label="Fee (₹)" className="sm:col-span-2"><Input type="number" min="0" value={item.fee} onChange={set('fee')} placeholder="Optional" aria-label={`Fee for ${name}`} /></Field>
      </div>
    </li>
  );
};

// Create / edit an event as one structured page. All writes go through RLS
// (events.manage) and the line-up through save_event_lineup (0034), which
// re-checks every artist's availability on the server.
export const EventEditor = ({ initial, onSaved, onCancel }) => {
  const defaultCapacity = useSetting('events.default_capacity', 200);
  const defaultPrice = useSetting('events.default_price', 799);
  const { venues, partners } = useVenueOptions();
  const isEdit = Boolean(initial?.id);
  const [form, setForm] = useState(() => ({
    name: '', slug: '', description: '', story: '', event_date: '', event_time: '', end_time: '',
    venue: '', venue_id: '', venue_partner_id: '', image_url: '', capacity: defaultCapacity, price: defaultPrice,
    status: 'draft', featured: false, timezone: 'Asia/Kolkata',
    ...(initial || {}),
    category: initial?.category || '',
    doors_at: toLocalInput(initial?.doors_at),
    tags: (initial?.tags || []).join(', '),
    page_background: initial?.page_background || null,
  }));
  const [lineup, setLineup] = useState([]);
  const [picking, setPicking] = useState(false);
  const [confirmOverride, setConfirmOverride] = useState(null);
  const [calendarOf, setCalendarOf] = useState(null);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const existing = useAsync(async () => {
    if (!isEdit) return [];
    const { data, error: e } = await supabase.from('event_artists').select('artist_id, artists(name, stage_name)').eq('event_id', initial.id);
    if (e) throw friendlyError(e);
    return data || [];
  }, [initial?.id]);
  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => {
      const next = { ...f, [k]: v };
      if (k === 'venue_id') { const venue = venues.find((x) => x.id === v); next.venue = venue ? venue.name : f.venue; }
      return next;
    });
  };
  const venue = venues.find((v) => v.id === form.venue_id);
  const exclude = useMemo(() => new Set([...lineup.map((l) => l.artist.artist_id), ...(existing.data || []).map((x) => x.artist_id)]), [lineup, existing.data]);
  const addArtists = (rows) => {
    const unavailable = rows.filter((r) => r.status === 'unavailable');
    const add = (list, override) => setLineup((cur) => [...cur, ...list.map((artist, i) => ({
      artist, override: override && artist.status === 'unavailable', mode: artist.has_account && artist.status !== 'available' ? 'request' : 'assign',
      performance_order: String(cur.length + (existing.data || []).length + i + 1), performance_type: '', set_minutes: '', start: '', end: '', notes: '', fee: '',
    }))]);
    setPicking(false);
    if (unavailable.length) {
      add(rows.filter((r) => r.status !== 'unavailable'), false);
      setConfirmOverride(unavailable);
    } else add(rows, false);
  };
  const artistsToNotify = lineup.filter((l) => l.mode === 'assign').length + (existing.data || []).length;
  const requestsToSend = lineup.filter((l) => l.mode === 'request').length;

  const save = async (e) => {
    e.preventDefault();
    const errs = validate(form, lineup, isEdit);
    setErrors(errs);
    if (Object.keys(errs).length) { setError('Check the highlighted fields.'); return; }
    setSaving(true);
    setError('');
    const payload = {
      name: form.name, slug: form.slug || slugify(form.name), description: form.description || null, story: form.story || null,
      category: form.category || null, event_date: form.event_date, event_time: form.event_time || null, end_time: form.end_time || null,
      timezone: form.timezone, doors_at: form.doors_at ? new Date(form.doors_at).toISOString() : null,
      venue: form.venue || null, venue_id: form.venue_id || null, venue_partner_id: form.venue_partner_id || null,
      image_url: form.image_url || null, capacity: Number(form.capacity), price: Number(form.price), featured: !!form.featured,
      tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
      page_background: form.page_background || null,
    };
    let saved;
    try {
      // A new event starts as a draft; the line-up is added, then it is
      // published — so "You're on the lineup" goes out once, with set times.
      saved = isEdit ? await update('events', initial.id, { ...payload, status: form.status }) : await insert('events', { ...payload, status: 'draft' });
    } catch (err) {
      setError(err.code === '23505' ? 'That slug is already used by another event.' : friendlyError(err).message);
      setSaving(false);
      return;
    }
    try {
      if (lineup.length) {
        const items = lineup.map((l) => ({
          artist_id: l.artist.artist_id, mode: l.mode, override: !!l.override, performance_type: l.performance_type || null,
          performance_order: l.performance_order || null, set_minutes: l.set_minutes || null, notes: l.notes || null, fee: l.fee || null,
          start: zonedIso(form.event_date, l.start, form.timezone), end: zonedIso(form.event_date, l.end, form.timezone),
        }));
        const { error: le } = await supabase.rpc('save_event_lineup', { p_event_id: saved.id, p_items: items });
        if (le) throw le;
      }
      if (!isEdit && form.status !== 'draft') saved = await update('events', saved.id, { status: form.status });
      onSaved(saved, { lineup: lineup.length });
    } catch (err) {
      setSaving(false);
      onSaved(saved, { lineupError: friendlyError(err).message });
    }
  };

  const section = (id, title, subtitle, body) => (
    <Panel key={id} title={title} subtitle={subtitle} className="scroll-mt-24"><div id={`event-${id}`} className="flex flex-col gap-3">{body}</div></Panel>
  );

  return (
    <form onSubmit={save} noValidate className="grid grid-cols-1 lg:grid-cols-[190px_1fr] gap-4" data-event-editor>
      <nav aria-label="Event form sections" className="hidden lg:block">
        <ol className="sticky top-20 list-none m-0 p-0 flex flex-col gap-0.5">
          {SECTIONS.map(([id, label], i) => (
            <li key={id}><a href={`#event-${id}`} className="flex items-center gap-2 px-2 py-1.5 rounded text-[12.5px] text-[#E7D5A4]/75 hover:text-[#EFE2C0] hover:bg-[#C99A2E]/10">
              <span className="font-mono text-[10px] text-[#C99A2E]/80 w-4">{i + 1}</span>{label}</a></li>
          ))}
        </ol>
      </nav>
      <div className="flex flex-col gap-4 min-w-0">
        {section('basics', 'Event basics', 'What the session is called and how it reads in listings.', <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Event name *" error={errors.name} className="sm:col-span-2"><Input value={form.name} onChange={set('name')} autoFocus={!isEdit} /></Field>
            <Field label="URL slug" error={errors.slug} hint={!form.slug && form.name ? slugify(form.name) : undefined}><Input value={form.slug} onChange={set('slug')} placeholder="auto" /></Field>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Category"><Select value={form.category} onChange={set('category')}>{CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
            <Field label="Short description" className="sm:col-span-2"><Input value={form.description || ''} onChange={set('description')} placeholder="One line for cards and listings" /></Field>
          </div>
        </>)}
        {section('schedule', 'Date & time', 'Artist availability is checked against this date.', <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Field label="Date *" error={errors.event_date}><Input type="date" value={form.event_date} onChange={set('event_date')} /></Field>
            <Field label="Start time"><Input value={form.event_time || ''} onChange={set('event_time')} placeholder="7:00 PM" /></Field>
            <Field label="End time"><Input value={form.end_time || ''} onChange={set('end_time')} placeholder="10:30 PM" /></Field>
            <Field label="Doors open"><Input type="datetime-local" value={form.doors_at || ''} onChange={set('doors_at')} /></Field>
            <Field label="Timezone" hint="Event and set times are in this zone">
              <Select value={form.timezone || 'Asia/Kolkata'} onChange={set('timezone')}>
                {[...new Set([form.timezone || 'Asia/Kolkata', ...TIMEZONES])].map((z) => <option key={z} value={z}>{z}</option>)}
              </Select>
            </Field>
          </div>
        </>)}
        {section('venue', 'Venue', null, <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Venue" hint={venues.length === 0 ? 'Add venues under Artists & Partners → Venues' : undefined}>
              <Select value={form.venue_id || ''} onChange={set('venue_id')}>
                <option value="">{form.venue && !form.venue_id ? `${form.venue} (not in directory)` : 'Select a venue…'}</option>
                {venues.map((v) => <option key={v.id} value={v.id}>{v.name}{v.capacity ? ` · cap ${v.capacity}` : ''}</option>)}
              </Select>
            </Field>
            <Field label="Venue partner account">
              <Select value={form.venue_partner_id || ''} onChange={set('venue_partner_id')}>
                <option value="">None</option>
                {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
            <Field label="Location (as shown to guests)"><Input value={form.venue || ''} onChange={set('venue')} placeholder="e.g. Bansilalpet Stepwell" /></Field>
            <Field label="Address" hint={venue ? 'From the venue directory' : 'Choose a venue to show its address'}><Input value={venue ? [venue.address, venue.city].filter(Boolean).join(', ') : ''} readOnly disabled /></Field>
          </div>
        </>)}
        {section('artists', 'Artists', 'Any number of artists. Availability comes from each artist\'s own calendar.', <>
          {isEdit && (existing.data || []).length > 0 && (
            <p className="text-[12.5px] text-[#E7D5A4]/75 m-0">Already on the line-up: {(existing.data || []).map((x) => x.artists?.stage_name || x.artists?.name).join(', ')}. Change their details on the Artists tab.</p>
          )}
          {lineup.length > 0 && (
            <ol className="list-none m-0 p-0 flex flex-col gap-2" data-lineup>
              {lineup.map((item, i) => (
                <LineupCard key={item.artist.artist_id} item={item} error={errors[`set-${i}`]}
                  onChange={(next) => setLineup((cur) => cur.map((x, j) => (j === i ? next : x)))}
                  onRemove={() => setLineup((cur) => cur.filter((_, j) => j !== i))}
                  onCalendar={() => setCalendarOf(item.artist)} />
              ))}
            </ol>
          )}
          <div><Button icon="Plus" onClick={() => setPicking(true)} disabled={!form.event_date} className="max-sm:h-11">Add artist</Button>
            {!form.event_date && <span className="ml-2 text-[12px] text-[#E7D5A4]/60">Choose the date first.</span>}</div>
        </>)}
        {section('capacity', 'Capacity & tickets', null, <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Field label="Capacity *" error={errors.capacity}><Input type="number" min="0" value={form.capacity} onChange={set('capacity')} /></Field>
            <Field label="Base price (₹) *" error={errors.price} hint="Tier markups + tax added at checkout"><Input type="number" min="0" value={form.price} onChange={set('price')} /></Field>
          </div>
          <p className="text-[12px] text-[#E7D5A4]/60 m-0">Ticket types (floor, chair, patron …) are set on the event's Tickets tab{isEdit ? '' : ' once it is created'}.</p>
        </>)}
        {section('content', 'Content', 'The public page.', <>
          <Field label="Story (long-form)"><Textarea rows={4} value={form.story || ''} onChange={set('story')} /></Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Cover image URL" hint="e.g. /media/gallery/tangy1.jpg"><Input value={form.image_url || ''} onChange={set('image_url')} /></Field>
            <Field label="Tags" hint="Comma separated"><Input value={form.tags} onChange={set('tags')} placeholder="Sufi, Acoustic" /></Field>
          </div>
          <BackgroundField value={form.page_background} cover={form.image_url} error={errors.page_background}
            onChange={(v) => setForm((f) => ({ ...f, page_background: v }))} />
        </>)}
        {section('publishing', 'Publishing', null, <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Status" hint="Draft events are visible to the team only.">
              <Select value={form.status} onChange={set('status')}>
                {EVENT_STATUSES.map((s) => <option key={s} value={s}>{EVENT_STATUS_LABELS[s]}</option>)}
              </Select>
            </Field>
            <label className="flex items-center gap-2 text-[13px] sm:pt-6 min-h-[44px]">
              <input type="checkbox" checked={!!form.featured} onChange={set('featured')} className="accent-[#C99A2E] w-5 h-5" /> Featured on site
            </label>
          </div>
        </>)}
        {section('notifications', 'Notifications', 'What saving will send.', (
          <ul className="list-disc pl-5 m-0 text-[13px] text-[#E7D5A4]/85 flex flex-col gap-1" data-notification-summary>
            {form.status === 'draft' ? (
              <li>{artistsToNotify ? `${artistsToNotify} artist${artistsToNotify === 1 ? '' : 's'} on the line-up will be told “You're on the lineup” when you publish.` : 'Nothing is sent while the event is a draft.'}</li>
            ) : (
              <li>{artistsToNotify ? `${artistsToNotify} artist${artistsToNotify === 1 ? '' : 's'} on the line-up ${isEdit ? 'are' : 'will be'} told “You're on the lineup”, with their set time.` : 'No artists on the line-up yet.'}</li>
            )}
            {requestsToSend > 0 && <li>{requestsToSend} session request{requestsToSend === 1 ? '' : 's'} will be sent now; artists accept or decline from their portal.</li>}
            {isEdit && <li>Changing the date, time or venue notifies the artists on the line-up and anyone holding a request. Cancelling notifies them too.</li>}
            <li className="text-[#E7D5A4]/60">Emails follow each person's notification settings.</li>
          </ul>
        ))}
        {error && <div role="alert" className="text-[12.5px] text-[#ef6b5e] bg-[#a8322a]/10 border border-[#a8322a]/40 rounded px-3 py-2">{error}</div>}
        <div className="sticky bottom-0 z-10 flex flex-wrap justify-end gap-2 py-3 bg-[#11100C]/95 border-t border-[#C99A2E]/15">
          {onCancel && <Button variant="ghost" onClick={onCancel} disabled={saving} className="max-sm:h-11">Cancel</Button>}
          <Button type="submit" variant="primary" disabled={saving} className="max-sm:h-11">{saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create event'}</Button>
        </div>
      </div>

      {picking && (
        <Modal title={`Add artists · ${fmt.date(form.event_date)}`} wide onClose={() => setPicking(false)}>
          <ArtistAvailabilityList date={form.event_date} eventId={initial?.id} selectable exclude={exclude} onAdd={addArtists} />
        </Modal>
      )}
      {confirmOverride && (
        <Modal title="Override availability?" onClose={() => setConfirmOverride(null)}
          footer={<><Button variant="ghost" onClick={() => setConfirmOverride(null)}>Leave them out</Button>
            <Button variant="danger" onClick={() => { const list = confirmOverride; setConfirmOverride(null); setLineup((cur) => [...cur, ...list.map((artist, i) => ({ artist, override: true, mode: artist.has_account ? 'request' : 'assign', performance_order: String(cur.length + i + 1), performance_type: '', set_minutes: '', start: '', end: '', notes: '', fee: '' }))]); }}>Add anyway</Button></>}>
          <p className="text-[13px] m-0">{confirmOverride.map((a) => a.stage_name || a.name).join(', ')} marked {fmt.date(form.event_date)} as unavailable. Sending a request lets them decide; adding them directly overrides their calendar and is recorded.</p>
          <ul className="m-0 pl-5 text-[12.5px] text-[#E7D5A4]/75">{confirmOverride.map((a) => <li key={a.artist_id}>{a.stage_name || a.name}: {a.detail}</li>)}</ul>
        </Modal>
      )}
      {calendarOf && <ArtistCalendarDrawer artist={calendarOf} date={form.event_date} onClose={() => setCalendarOf(null)} />}
    </form>
  );
};
