import { useState } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { supabase } from '../../lib/supabaseClient';
import { insert, update, orIlike } from '../api';
import { useServerTable, useDebounced, useAsync } from '../hooks';
import { FindAvailableArtists } from '../components/ArtistAvailability';
import {
  Page, Panel, Tabs, Toolbar, SearchInput, FilterSelect, DataTable, Pagination, Badge, Button, Drawer, KeyValue, Field,
  Input, Textarea, Skeleton, EmptyState, ErrorState, fmt, useToast,
} from '../ui';

// One reusable CRUD surface for every people/partner entity. Each config
// names its table, columns, editable fields and related-records query;
// authorization is RLS (entities.manage / is_admin) on each table.
const profileCols = (label) => [
  { key: 'contact', header: 'Account', render: (r) => (<div className="min-w-0"><div className="text-[#EFE2C0]">{r.profiles?.full_name || '—'}</div><div className="text-[12px] text-[#E7D5A4]/60 truncate max-w-[220px]">{r.profiles?.email}</div></div>) },
  { key: 'active', header: 'Account status', mobileHidden: true, render: (r) => <Badge status={r.profiles?.is_active === false ? 'deactivated' : 'active'} /> },
  { key: 'updated', header: 'Updated', mobileHidden: true, render: (r) => <span className="font-mono text-[11.5px] text-[#E7D5A4]/60">{fmt.relative(r.updated_at)}</span> },
].map((c, i) => (i === 0 ? { ...c, header: label } : c));

export const ENTITIES = {
  artists: {
    label: 'Artists', singular: 'artist', table: 'artists', order: 'name', search: ['name', 'email', 'genre', 'city'],
    title: (r) => r.name, canCreate: true,
    createDefaults: { status: 'approved' },
    filters: [{ key: 'status', label: 'Status', options: [{ value: '', label: 'Any status' }, { value: 'approved', label: 'Approved' }, { value: 'pending', label: 'Pending' }, { value: 'rejected', label: 'Rejected' }], initial: 'approved' }],
    columns: [
      { key: 'name', header: 'Artist', render: (r) => (<div className="min-w-0"><div className="text-[#EFE2C0]">{r.name}</div><div className="text-[12px] text-[#E7D5A4]/60 truncate max-w-[220px]">{r.email}</div></div>) },
      { key: 'genre', header: 'Genre', render: (r) => r.genre || '—' },
      { key: 'city', header: 'City', mobileHidden: true, render: (r) => r.city || '—' },
      { key: 'account', header: 'Portal', mobileHidden: true, render: (r) => (r.user_id ? <Badge tone="good">Linked</Badge> : <Badge tone="muted">Roster only</Badge>) },
      { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
    ],
    // The public URL is Tangy's to set (artists can't change it, 0040); blank = generated from the stage name.
    fields: [['name', 'Name', true], ['email', 'Email', true], ['slug', 'Public page URL (/artists/…) — blank to generate'], ['genre', 'Genre'], ['city', 'City'], ['experience_level', 'Experience'], ['instagram', 'Instagram'], ['soundcloud', 'SoundCloud'], ['spotify', 'Spotify'], ['avatar_url', 'Avatar URL'], ['bio', 'Bio', false, true]],
    related: async (r) => {
      const { data } = await supabase.from('event_artists').select('events(id, name, event_date, status)').eq('artist_id', r.id);
      return (data || []).map((x) => x.events).filter(Boolean);
    },
  },
  venues: {
    label: 'Venues', singular: 'venue', table: 'venues', order: 'name', search: ['name', 'address', 'city', 'contact_name'],
    title: (r) => r.name, canCreate: true,
    filters: [{ key: 'is_active', label: 'Active', options: [{ value: 'true', label: 'Active venues' }, { value: 'false', label: 'Inactive' }, { value: '', label: 'All' }], initial: 'true' }],
    columns: [
      { key: 'name', header: 'Venue', render: (r) => (<div><div className="text-[#EFE2C0]">{r.name}</div><div className="text-[12px] text-[#E7D5A4]/60">{[r.address, r.city].filter(Boolean).join(', ')}</div></div>) },
      { key: 'capacity', header: 'Capacity', align: 'right', render: (r) => fmt.num(r.capacity) },
      { key: 'contact', header: 'Contact', mobileHidden: true, render: (r) => [r.contact_name, r.contact_phone].filter(Boolean).join(' · ') || '—' },
      { key: 'active', header: 'Status', render: (r) => <Badge status={r.is_active ? 'active' : 'archived'}>{r.is_active ? 'Active' : 'Inactive'}</Badge> },
    ],
    fields: [['name', 'Name', true], ['address', 'Address'], ['city', 'City'], ['capacity', 'Capacity', false, false, 'number'], ['contact_name', 'Contact name'], ['contact_phone', 'Contact phone'], ['contact_email', 'Contact email'], ['notes', 'Notes', false, true]],
    toggle: { field: 'is_active', on: 'Reactivate venue', off: 'Deactivate venue' },
    related: async (r) => (await supabase.from('events').select('id, name, event_date, status').eq('venue_id', r.id).order('event_date', { ascending: false })).data || [],
  },
  sponsors: {
    label: 'Sponsors', singular: 'sponsor', table: 'sponsor_profiles', select: '*, profiles(full_name, email, phone, is_active)', order: 'organization_name',
    search: ['organization_name', 'sponsorship_tier', 'website'], title: (r) => r.organization_name || r.profiles?.full_name || 'Sponsor',
    columns: [{ key: 'org', header: 'Organization', render: (r) => <span className="text-[#EFE2C0]">{r.organization_name || '—'}</span> }, { key: 'tier', header: 'Tier', render: (r) => r.sponsorship_tier || '—' }, ...profileCols('Contact')],
    fields: [['organization_name', 'Organization'], ['sponsorship_tier', 'Sponsorship tier'], ['website', 'Website'], ['contact_designation', 'Contact designation']],
    related: async (r) => ((await supabase.from('sponsor_deliverables').select('id, title, status, events(id, name, event_date, status)').eq('sponsor_profile_id', r.id)).data || []).map((d) => ({ ...(d.events || { id: d.id, name: 'No event' }), sub: `${d.title} · ${d.status}` })),
  },
  'venue-hosts': {
    label: 'Venue hosts', singular: 'venue host', table: 'venue_profiles', select: '*, profiles(full_name, email, phone, is_active)', order: 'property_name',
    search: ['property_name', 'location'], title: (r) => r.property_name || r.profiles?.full_name || 'Venue host',
    columns: [{ key: 'prop', header: 'Property', render: (r) => <span className="text-[#EFE2C0]">{r.property_name || '—'}</span> }, { key: 'loc', header: 'Location', render: (r) => r.location || '—' }, ...profileCols('Host')],
    fields: [['property_name', 'Property name'], ['location', 'Location'], ['capacity', 'Capacity'], ['description', 'Description', false, true]],
    related: async (r) => ((await supabase.from('events').select('id, name, event_date, status').eq('venue_partner_id', r.id).order('event_date', { ascending: false })).data || []),
  },
  vendors: {
    label: 'Vendors', singular: 'vendor', table: 'vendor_profiles', select: '*, profiles(full_name, email, phone, is_active)', order: 'business_name',
    search: ['business_name', 'category', 'gstin'], title: (r) => r.business_name || r.profiles?.full_name || 'Vendor',
    columns: [{ key: 'biz', header: 'Business', render: (r) => <span className="text-[#EFE2C0]">{r.business_name || '—'}</span> }, { key: 'category', header: 'Category', render: (r) => r.category || '—' }, ...profileCols('Contact')],
    fields: [['business_name', 'Business name'], ['category', 'Category'], ['gstin', 'GSTIN'], ['phone', 'Phone'], ['description', 'Description', false, true]],
    related: 'assignments',
  },
  crew: {
    label: 'Crew', singular: 'crew member', table: 'crew_profiles', select: '*, profiles(full_name, email, phone, is_active)', order: 'updated_at',
    search: ['department', 'shift_preference', 'certifications'], title: (r) => r.profiles?.full_name || r.profiles?.email || 'Crew member',
    columns: [...profileCols('Crew member').slice(0, 1), { key: 'dept', header: 'Department', render: (r) => r.department || '—' }, { key: 'shift', header: 'Shift', mobileHidden: true, render: (r) => r.shift_preference || '—' }, ...profileCols('').slice(1)],
    fields: [['department', 'Department'], ['shift_preference', 'Shift preference'], ['certifications', 'Certifications', false, true]],
    related: 'assignments',
  },
  volunteers: {
    label: 'Volunteers', singular: 'volunteer', table: 'volunteer_profiles', select: '*, profiles(full_name, email, phone, is_active)', order: 'updated_at',
    search: ['skills', 'availability'], title: (r) => r.profiles?.full_name || r.profiles?.email || 'Volunteer',
    columns: [...profileCols('Volunteer').slice(0, 1), { key: 'skills', header: 'Skills', render: (r) => <span className="truncate block max-w-[240px]">{r.skills || '—'}</span> }, { key: 'avail', header: 'Availability', mobileHidden: true, render: (r) => r.availability || '—' }, ...profileCols('').slice(1)],
    fields: [['skills', 'Skills', false, true], ['availability', 'Availability'], ['emergency_contact', 'Emergency contact']],
    related: 'assignments',
  },
};

const loadAssignments = async (r) => ((await supabase.from('event_assignments').select('title, status, events(id, name, event_date, status)').eq('assignee_id', r.id)).data || [])
  .map((a) => ({ ...a.events, sub: `${a.title} · ${a.status}` })).filter((e) => e.id);

export const EntityDrawer = ({ config, row, onClose, onSaved, inline = false }) => {
  const toast = useToast();
  const isNew = !row.id;
  const [form, setForm] = useState(() => Object.fromEntries(config.fields.map(([k]) => [k, row[k] ?? ''])));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const related = useAsync(() => (isNew ? [] : config.related === 'assignments' ? loadAssignments(row) : config.related?.(row) || []), [row.id]);
  const missing = config.fields.some(([k, , required]) => required && !String(form[k] || '').trim());

  const save = async (e) => {
    e.preventDefault();
    if (missing) return;
    setSaving(true);
    setError('');
    const payload = Object.fromEntries(config.fields.map(([k, , , , type]) => [k, form[k] === '' ? null : type === 'number' ? Number(form[k]) : form[k]]));
    try {
      if (isNew) await insert(config.table, { ...(config.createDefaults || {}), ...payload });
      else await update(config.table, row.id, payload);
      toast(`${config.label.replace(/s$/, '')} saved`);
      onSaved();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };
  const toggle = async () => {
    try {
      await update(config.table, row.id, { [config.toggle.field]: !row[config.toggle.field] });
      toast('Updated');
      onSaved();
    } catch (err) { toast(err.message, 'bad'); }
  };

  return (
    <Drawer inline={inline} title={isNew ? `New ${config.singular}` : config.title(row)} subtitle={row.profiles?.email} onClose={onClose}
      footer={<>
        {config.toggle && !isNew && <Button variant="ghost" onClick={toggle}>{row[config.toggle.field] ? config.toggle.off : config.toggle.on}</Button>}
        <Button variant="primary" onClick={save} disabled={saving || missing}>{saving ? 'Saving…' : 'Save'}</Button>
      </>}>
      {row.profiles && (
        <Panel title="Linked account">
          <KeyValue items={[['Name', row.profiles.full_name], ['Email', row.profiles.email], ['Phone', row.profiles.phone], ['Status', <Badge status={row.profiles.is_active === false ? 'deactivated' : 'active'} />]]} />
          <p className="text-[12px] text-[#E7D5A4]/60 mt-3">Role and account status are managed by a Super Admin under Users & Roles.</p>
        </Panel>
      )}
      <form onSubmit={save} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {config.fields.map(([k, label, required, multiline, type]) => (
          <Field key={k} label={`${label}${required ? ' *' : ''}`} className={multiline ? 'sm:col-span-2' : ''}>
            {multiline
              ? <Textarea rows={3} value={form[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
              : <Input type={type || 'text'} value={form[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />}
          </Field>
        ))}
      </form>
      {error && <div role="alert" className="text-[12.5px] text-[#ef6b5e] bg-[#a8322a]/10 border border-[#a8322a]/40 rounded px-3 py-2">{error}</div>}
      {!isNew && (
        <Panel title="Events" flush>
          {(related.data || []).length === 0 ? <div className="p-4 text-[12.5px] text-[#E7D5A4]/60">{related.loading ? 'Loading…' : 'Not linked to any events yet.'}</div> : (
            <ul className="divide-y divide-[#E7D5A4]/[0.06]">
              {related.data.map((e, i) => (
                <li key={`${e.id}-${i}`}>
                  <Link to={`/admin-portal/events/${e.id}`} className="flex items-center gap-3 px-4 py-2.5 text-[12.5px] hover:bg-[#C99A2E]/[0.05]">
                    <span className="font-mono text-[#C99A2E] w-24 shrink-0">{fmt.date(e.event_date)}</span>
                    <span className="flex-1 min-w-0 truncate">{e.name}{e.sub && <span className="text-[#E7D5A4]/60"> · {e.sub}</span>}</span>
                    {e.status && <Badge status={e.status} />}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </Drawer>
  );
};

const EntityManager = ({ kind }) => {
  const config = ENTITIES[kind];
  const [filters, setFilters] = useState(() => Object.fromEntries((config.filters || []).map((f) => [f.key, f.initial ?? ''])));
  const [params] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') || '');
  const q = useDebounced(search);
  const navigate = useNavigate();
  const [finding, setFinding] = useState(false);

  const table = useServerTable({
    table: config.table,
    select: config.select || '*',
    deps: [kind, filters, q],
    build: (query) => {
      let x = query.order(config.order, { ascending: config.order !== 'updated_at', nullsFirst: false });
      Object.entries(filters).forEach(([k, v]) => { if (v !== '') x = x.eq(k, v); });
      return orIlike(x, config.search, q);
    },
  });

  return (
    <Panel flush>
      <div className="p-3 border-b border-[#C99A2E]/15">
        <Toolbar right={
          <>
            <span className="font-mono text-[11px] text-[#E7D5A4]/60">{fmt.num(table.count)} {config.label.toLowerCase()}</span>
            {kind === 'artists' && <Button size="sm" icon="CalendarDays" onClick={() => setFinding(true)}>Find available artists</Button>}
            {config.canCreate && <Button size="sm" variant="primary" icon="Plus" to={`/admin-portal/people/${kind}/new`}>Add {config.singular}</Button>}
          </>
        }>
          <SearchInput value={search} onChange={setSearch} placeholder={`Search ${config.label.toLowerCase()}…`} />
          {(config.filters || []).map((f) => <FilterSelect key={f.key} label={f.label} value={filters[f.key]} onChange={(v) => setFilters((s) => ({ ...s, [f.key]: v }))} options={f.options} />)}
        </Toolbar>
      </div>
      <DataTable columns={config.columns} rows={table.rows} loading={table.loading} error={table.error} onRetry={table.reload} onRowClick={(r) => navigate(`/admin-portal/people/${kind}/${r.id}`)}
        empty={{
          title: `No ${config.label.toLowerCase()} found`,
          hint: config.canCreate ? undefined : `${config.label} are added when their application is approved.`,
          icon: 'Contact',
          action: !config.canCreate && <Button size="sm" to={`/admin-portal/applications?type=${{ sponsors: 'sponsor', vendors: 'vendor', crew: 'crew', volunteers: 'volunteer' }[kind]}`}>View applications</Button>,
        }} />
      <Pagination {...table} />
      {finding && <Drawer title="Find available artists" subtitle="Who can play on a date — from each artist's own calendar." width="sm:max-w-3xl" onClose={() => setFinding(false)}><FindAvailableArtists /></Drawer>}
    </Panel>
  );
};

// /admin-portal/people/:kind/:id — one record as its own page.
const EntityDetail = ({ kind, id }) => {
  const config = ENTITIES[kind];
  const navigate = useNavigate();
  const q = useAsync(async () => {
    if (id === 'new') return {};
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const { data, error } = await supabase.from(config.table).select(config.select || '*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  }, [kind, id]);
  const back = `/admin-portal/people/${kind}`;
  const name = q.data && id !== 'new' ? config.title(q.data) : id === 'new' ? `New ${config.singular}` : 'Not found';
  return (
    <Page title={name} back={{ to: back, label: config.label }} crumbs={[{ label: name }]}>
      {q.loading ? <Skeleton rows={6} /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : !q.data ? (
        <Panel><EmptyState icon="Contact" title={`${config.singular[0].toUpperCase()}${config.singular.slice(1)} not found`} hint="It may have been removed, or the link is wrong." action={<Button to={back} icon="ChevronLeft">Back to {config.label.toLowerCase()}</Button>} /></Panel>
      ) : (
        <EntityDrawer inline key={id} config={config} row={q.data} onClose={() => navigate(back)} onSaved={() => navigate(back)} />
      )}
    </Page>
  );
};

export default function PeoplePage() {
  const { kind = 'artists', id } = useParams();
  const active = ENTITIES[kind] ? kind : null;
  if (!active) return <Page title="Not found"><Panel><EmptyState title="No such section" action={<Button to="/admin-portal/people/artists">Artists & partners</Button>} /></Panel></Page>;
  if (id) return <EntityDetail kind={active} id={id} />;
  return (
    <Page title="Artists & partners" subtitle="The people and organizations behind every session. Partner records are created when their application is approved.">
      <Tabs tabs={Object.entries(ENTITIES).map(([k, c]) => ({ id: k, label: c.label, to: `/admin-portal/people/${k}` }))} value={active} />
      <EntityManager key={active} kind={active} />
    </Page>
  );
}

