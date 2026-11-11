import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MediaImg } from '../../components/ui/Media';
import { supabase } from '../../lib/supabaseClient';
import { content, slugify, contentErrorMessage, TV_FIELDS, DIARY_FIELDS, ALBUM_FIELDS } from '../../lib/contentService';
import { useAsync } from '../hooks';
import { useAdminSession } from '../AdminSession';
import { P } from '../rbac';
import { Panel, Button, Input, Textarea, Select, Field, Badge, DataTable, Drawer, ConfirmDialog, SearchInput, Toolbar, FilterSelect, Skeleton, EmptyState, ErrorState, useToast, fmt } from '../ui';

// Admin → Content: Tangy TV, Diary, Gallery. The database is the authority
// (RLS + content_guard_publish, migration 0028); these screens only hide
// actions the editor can't take and explain the ones that fail.

const STATUS_OPTIONS = [['draft', 'Draft'], ['published', 'Published'], ['archived', 'Archived']];
const statusTone = (row) => (row.status === 'published' && row.published_at && new Date(row.published_at) > new Date() ? 'warn' : undefined);
const statusLabel = (row) => (row.status === 'published' && row.published_at && new Date(row.published_at) > new Date() ? `Scheduled ${fmt.date(row.published_at)}` : row.status);
const toLocalInput = (iso) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
const URL_RE = /^(\/|https:\/\/)\S+$/;

export function useContentRights(area) {
  const { can } = useAdminSession();
  const areaPerm = { tv: P.CONTENT_TV, diary: P.CONTENT_DIARY, media: P.CONTENT_MEDIA, sessions: P.CONTENT_SESSIONS }[area];
  return {
    view: can([P.CONTENT_VIEW, areaPerm]),
    create: can([P.CONTENT_CREATE, areaPerm]),
    edit: can([P.CONTENT_EDIT, areaPerm]),
    publish: can(P.CONTENT_PUBLISH),
    remove: can([P.CONTENT_DELETE, areaPerm]),
  };
}

// Warn before leaving the page with unsaved edits.
function useBeforeUnload(active) {
  useEffect(() => {
    if (!active) return undefined;
    const h = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [active]);
}

function MediaField({ label, value, onChange, area, accept, hint, error, canUpload }) {
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const inputRef = useRef(null);
  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    setUploadError('');
    const res = await content.upload(area, file);
    setBusy(false);
    if (res.error) setUploadError(contentErrorMessage(res.error) || res.error.message);
    else onChange(res.url);
  };
  return (
    <Field label={label} hint={hint} error={error || uploadError}>
      <div className="flex gap-2">
        <Input value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder="https://… or /media/…" />
        {canUpload && (
          <>
            <input ref={inputRef} type="file" accept={accept} className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
            <Button size="md" icon="Upload" onClick={() => inputRef.current?.click()} disabled={busy}>{busy ? 'Uploading…' : 'Upload'}</Button>
          </>
        )}
      </div>
      {value && accept?.startsWith('image') && URL_RE.test(value) && <MediaImg src={value} alt="" className="mt-2 max-h-32 w-auto border border-[#C99A2E]/30" />}
    </Field>
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Generic list + editor for one content table. Each item has its own URL:
// mode "list" is <base>, mode "detail" is <base>/<slug|id> (or <base>/new),
// rendered as a full page — refresh, back/forward and deep links all work.
// `afterSave(row, form)` (optional) runs after the row is saved — e.g. linked
// records — and may return { form } fields to keep or { error } to report.
function CollectionManager({ area, table, fields, noun, columns, validate, blank, toRow, fromRow, previewPath, mode = 'list', base, itemRef, onLoaded, afterSave }) {
  const rights = useContentRights(area);
  const toast = useToast();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState(null);   // form state
  const [original, setOriginal] = useState(null);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const slugTouched = useRef(false);

  const list = useAsync(async () => {
    if (mode !== 'list') return [];
    const { data, error } = await supabase.from(table).select(fields).order('updated_at', { ascending: false });
    if (error) throw new Error(contentErrorMessage(error));
    return data || [];
  }, [table, mode]);

  // Detail page: load the item named in the URL.
  const item = useAsync(async () => {
    if (mode !== 'detail' || itemRef === 'new') return null;
    const { data, error } = await supabase.from(table).select(fields).eq(UUID_RE.test(itemRef) ? 'id' : 'slug', itemRef).maybeSingle();
    if (error) throw new Error(contentErrorMessage(error));
    return data;
  }, [table, mode, itemRef]);
  useEffect(() => {
    if (mode !== 'detail') return;
    if (itemRef === 'new') { slugTouched.current = false; const f = blank(); setEditing(f); setOriginal(f); setErrors({}); onLoaded?.(null); return; }
    if (item.data) { slugTouched.current = true; const f = fromRow(item.data); setEditing(f); setOriginal(f); setErrors({}); onLoaded?.(item.data); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, itemRef, item.data]);

  const rows = useMemo(() => (list.data || []).filter((r) => (!status || r.status === status)
    && (!search || `${r.title} ${r.slug}`.toLowerCase().includes(search.toLowerCase()))), [list.data, status, search]);

  const dirty = editing && JSON.stringify(editing) !== JSON.stringify(original);
  useBeforeUnload(dirty);

  const open = (row) => navigate(`${base}/${row ? (row.slug || row.id) : 'new'}`);
  const close = () => {
    if (dirty && !window.confirm('Discard your unsaved changes?')) return;
    navigate(base);
  };
  const set = (patch) => setEditing((f) => {
    const next = { ...f, ...patch };
    if ('title' in patch && !slugTouched.current) next.slug = slugify(patch.title);
    return next;
  });

  const save = async () => {
    const errs = validate(editing);
    if (!editing.slug || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(editing.slug)) errs.slug = 'Use lowercase letters, numbers and hyphens.';
    if (!editing.title?.trim()) errs.title = 'A title is required.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    const { data, error } = await content.save(table, toRow(editing));
    setSaving(false);
    if (error) { toast(contentErrorMessage(error), 'bad'); return; }
    const extra = afterSave ? await afterSave(data, editing) : null;
    if (extra?.error) toast(extra.error, 'bad');
    else toast(`${noun} saved${data.status === 'published' ? ' and live' : ''}.`);
    const form = { ...fromRow(data), ...(extra?.form || {}) };
    setEditing(form);
    setOriginal(form);
    slugTouched.current = true;
    onLoaded?.(data);
    // The URL follows the item (new → its slug; a renamed slug).
    if (itemRef !== data.slug) navigate(`${base}/${data.slug}`, { replace: true });
  };

  const remove = (row) => setConfirm({
    title: `Delete ${noun.toLowerCase()}?`,
    message: `“${row.title}” will be removed permanently${row.status === 'published' ? ' and disappear from the public site' : ''}. This can’t be undone.`,
    confirmLabel: 'Delete', tone: 'danger',
    onConfirm: async () => {
      const { error } = await content.remove(table, row.id);
      if (error) throw new Error(contentErrorMessage(error));
      toast(`${noun} deleted.`);
      navigate(base);
    },
  });

  if (!rights.view) return <Panel><p className="text-[13px] text-[#E7D5A4]/70">You don’t have access to this area.</p></Panel>;

  if (mode === 'detail') {
    if (item.loading && !editing) return <Skeleton rows={6} />;
    if (item.error) return <ErrorState error={item.error} onRetry={item.reload} />;
    if (itemRef !== 'new' && !item.loading && !item.data) {
      return <Panel><EmptyState icon="FileText" title={`${noun} not found`} hint="It may have been deleted, or the link is wrong." action={<Button to={base} icon="ChevronLeft">Back to {noun.toLowerCase()}s</Button>} /></Panel>;
    }
    if (!editing) return <Skeleton rows={6} />;
  }

  if (mode === 'detail') {
    return (
      <>
        <Drawer
          inline
          title={editing.id ? editing.title || `Edit ${noun.toLowerCase()}` : `New ${noun.toLowerCase()}`}
          subtitle={dirty ? 'Unsaved changes' : editing.id ? 'All changes saved' : undefined}
          onClose={close}
          footer={(
            <>
              {editing.id && rights.remove && <Button variant="danger" icon="Trash2" onClick={() => remove(editing)} className="mr-auto">Delete</Button>}
              {editing.id && editing.status === 'published' && previewPath && <Button icon="ExternalLink" to={previewPath(editing)} target="_blank">View live</Button>}
              <Button variant="ghost" onClick={close}>{dirty ? 'Cancel' : `Back to ${noun.toLowerCase()}s`}</Button>
              <Button variant="primary" onClick={save} disabled={saving || !dirty || !(editing.id ? rights.edit : rights.create)}>{saving ? 'Saving…' : 'Save'}</Button>
            </>
          )}
        >
          <Field label="Title *" error={errors.title}><Input value={editing.title} onChange={(e) => set({ title: e.target.value })} maxLength={160} autoFocus={!editing.id} /></Field>
          <Field label="URL slug *" hint={previewPath ? `Public address: ${previewPath(editing)}` : undefined} error={errors.slug}>
            <Input value={editing.slug} onChange={(e) => { slugTouched.current = true; set({ slug: e.target.value.toLowerCase() }); }} maxLength={80} />
          </Field>
          {editing.__fields(editing, set, errors, rights)}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-[#C99A2E]/15 pt-4">
            <Field label="Publish status" hint={rights.publish ? undefined : 'Publishing needs the content.publish permission — you can save drafts.'}>
              <Select value={editing.status} onChange={(e) => set({ status: e.target.value })}
                disabled={!rights.publish && editing.status === 'published'}>
                {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v} disabled={!rights.publish && (v === 'published' || original?.status === 'published')}>{l}</option>)}
              </Select>
            </Field>
            <Field label="Publish at" hint="Leave empty to publish immediately. A future time schedules it.">
              <Input type="datetime-local" value={editing.publishedAtLocal} disabled={!rights.publish} onChange={(e) => set({ publishedAtLocal: e.target.value })} />
            </Field>
          </div>
        </Drawer>
        {confirm && <ConfirmDialog {...confirm} onClose={() => setConfirm(null)} />}
      </>
    );
  }

  return (
    <Panel flush>
      <div className="p-4 flex flex-col gap-3">
        <Toolbar right={rights.create && <Button variant="primary" icon="Plus" onClick={() => open(null)}>New {noun.toLowerCase()}</Button>}>
          <SearchInput value={search} onChange={setSearch} placeholder={`Search ${noun.toLowerCase()}s…`} />
          <FilterSelect label="Status" value={status} onChange={setStatus} options={[{ value: '', label: 'All statuses' }, ...STATUS_OPTIONS.map(([value, label]) => ({ value, label }))]} />
        </Toolbar>
      </div>
      <DataTable
        rows={rows}
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        onRowClick={(r) => open(r)}
        empty={{ title: `No ${noun.toLowerCase()}s yet`, icon: 'FileText', hint: rights.create ? `Create the first one with “New ${noun.toLowerCase()}”.` : undefined }}
        columns={[
          { key: 'title', header: 'Title', render: (r) => <span className="font-medium">{r.title}</span> },
          ...columns,
          { key: 'status', header: 'Status', render: (r) => <Badge status={r.status === 'published' && !statusTone(r) ? 'published' : r.status} tone={statusTone(r)}>{statusLabel(r)}</Badge> },
          { key: 'updated_at', header: 'Updated', render: (r) => fmt.date(r.updated_at), mobileHidden: true },
        ]}
      />

      {confirm && <ConfirmDialog {...confirm} onClose={() => setConfirm(null)} />}
    </Panel>
  );
}

const common = (row) => ({ id: row?.id, title: row?.title || '', slug: row?.slug || '', status: row?.status || 'draft', publishedAtLocal: toLocalInput(row?.published_at) });
const commonRow = (f) => ({ id: f.id, title: f.title.trim(), slug: f.slug, status: f.status, published_at: f.publishedAtLocal ? new Date(f.publishedAtLocal).toISOString() : (f.status === 'published' ? undefined : null) });

export function TvManager(routeProps) {
  const rights = useContentRights('tv');
  const fieldsUi = (f, set, errors) => (
    <>
      <MediaField label="Video *" area="tv" accept="video/mp4,video/webm" value={f.video_url} onChange={(v) => set({ video_url: v })} error={errors.video_url}
        hint="MP4 or WebM, up to 50 MB — or a link to a hosted video file." canUpload={rights.create || rights.edit} />
      <MediaField label="Thumbnail" area="tv" accept="image/*" value={f.thumbnail_url} onChange={(v) => set({ thumbnail_url: v })} error={errors.thumbnail_url} canUpload={rights.create || rights.edit} />
      <Field label="Description"><Textarea rows={4} value={f.description} onChange={(e) => set({ description: e.target.value })} maxLength={4000} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Category" hint="Groups videos on /tv"><Input value={f.category} onChange={(e) => set({ category: e.target.value })} maxLength={60} /></Field>
        <Field label="Order" hint="Lower first"><Input type="number" value={f.sort_order} onChange={(e) => set({ sort_order: e.target.value })} /></Field>
      </div>
      <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={f.in_player} onChange={(e) => set({ in_player: e.target.checked })} className="w-4 h-4 accent-[#C99A2E]" /> Plays on the retro TV set</label>
      <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={f.featured} onChange={(e) => set({ featured: e.target.checked })} className="w-4 h-4 accent-[#C99A2E]" /> Featured</label>
    </>
  );
  return (
    <CollectionManager
      {...routeProps}
      area="tv" table="tv_videos" fields={TV_FIELDS} noun="Video"
      previewPath={(f) => `/tv/${f.slug}`}
      columns={[{ key: 'category', header: 'Category', render: (r) => r.category || '—' }, { key: 'in_player', header: 'On TV set', render: (r) => (r.in_player ? 'Yes' : 'No'), mobileHidden: true }]}
      blank={() => ({ ...common(null), video_url: '', thumbnail_url: '', description: '', category: '', sort_order: 0, in_player: true, featured: false, __fields: fieldsUi })}
      fromRow={(r) => ({ ...common(r), video_url: r.video_url, thumbnail_url: r.thumbnail_url || '', description: r.description || '', category: r.category || '', sort_order: r.sort_order ?? 0, in_player: r.in_player, featured: r.featured, __fields: fieldsUi })}
      toRow={(f) => ({ ...commonRow(f), video_url: f.video_url.trim(), thumbnail_url: f.thumbnail_url.trim() || null, description: f.description.trim() || null, category: f.category.trim() || null, sort_order: Number(f.sort_order) || 0, in_player: f.in_player, featured: f.featured })}
      validate={(f) => {
        const e = {};
        if (!URL_RE.test(f.video_url.trim())) e.video_url = 'Upload a video or enter an https:// link or /media/ path.';
        if (f.thumbnail_url.trim() && !URL_RE.test(f.thumbnail_url.trim())) e.thumbnail_url = 'Use an https:// link or /media/ path.';
        return e;
      }}
    />
  );
}

export function DiaryManager(routeProps) {
  const rights = useContentRights('diary');
  const fieldsUi = (f, set, errors) => (
    <>
      <Field label="Excerpt" hint="Shown in the diary list and link previews (up to 400 characters)."><Textarea rows={2} value={f.excerpt} onChange={(e) => set({ excerpt: e.target.value })} maxLength={400} /></Field>
      <Field label="Body *" hint="Plain text — leave a blank line between paragraphs." error={errors.body}><Textarea rows={12} value={f.body} onChange={(e) => set({ body: e.target.value })} maxLength={50000} /></Field>
      <MediaField label="Cover image" area="diary" accept="image/*" value={f.cover_url} onChange={(v) => set({ cover_url: v })} error={errors.cover_url} canUpload={rights.create || rights.edit} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Location"><Input value={f.location} onChange={(e) => set({ location: e.target.value })} maxLength={120} /></Field>
        <Field label="Author"><Input value={f.author_name} onChange={(e) => set({ author_name: e.target.value })} maxLength={120} /></Field>
      </div>
      <Field label="Tags" hint="Comma separated — used as filters on /diary"><Input value={f.tags} onChange={(e) => set({ tags: e.target.value })} /></Field>
      <Field label="Search description" hint="Up to 200 characters"><Input value={f.seo_description} onChange={(e) => set({ seo_description: e.target.value })} maxLength={200} /></Field>
    </>
  );
  return (
    <CollectionManager
      {...routeProps}
      area="diary" table="diary_posts" fields={DIARY_FIELDS} noun="Post"
      previewPath={(f) => `/diary/${f.slug}`}
      columns={[{ key: 'published_at', header: 'Published', render: (r) => (r.published_at ? fmt.date(r.published_at) : '—') }]}
      blank={() => ({ ...common(null), excerpt: '', body: '', cover_url: '', location: '', author_name: '', tags: '', seo_description: '', __fields: fieldsUi })}
      fromRow={(r) => ({ ...common(r), excerpt: r.excerpt || '', body: r.body || '', cover_url: r.cover_url || '', location: r.location || '', author_name: r.author_name || '', tags: (r.tags || []).join(', '), seo_description: r.seo_description || '', __fields: fieldsUi })}
      toRow={(f) => ({ ...commonRow(f), excerpt: f.excerpt.trim() || null, body: f.body.trim(), cover_url: f.cover_url.trim() || null, location: f.location.trim() || null, author_name: f.author_name.trim() || null,
        tags: [...new Set(f.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))], seo_description: f.seo_description.trim() || null })}
      validate={(f) => {
        const e = {};
        if (f.status === 'published' && !f.body.trim()) e.body = 'A published post needs a body.';
        if (f.cover_url.trim() && !URL_RE.test(f.cover_url.trim())) e.cover_url = 'Use an https:// link or /media/ path.';
        return e;
      }}
    />
  );
}

// Photos of one album: add (upload or link, alt text required), caption,
// reorder, remove. Saved immediately — the album's status decides visibility.
function AlbumPhotos({ albumId, rights }) {
  const toast = useToast();
  const [adding, setAdding] = useState({ url: '', alt: '', caption: '' });
  const [error, setError] = useState('');
  const photos = useAsync(async () => {
    const { data, error: err } = await supabase.from('gallery_photos').select('*').eq('album_id', albumId).order('sort_order');
    if (err) throw new Error(contentErrorMessage(err));
    return data || [];
  }, [albumId]);
  const list = photos.data || [];

  const add = async () => {
    setError('');
    if (!URL_RE.test(adding.url.trim())) { setError('Upload a photo or enter an https:// link or /media/ path.'); return; }
    if (!adding.alt.trim()) { setError('Describe the photo for people using screen readers (alt text).'); return; }
    const { error: err } = await supabase.from('gallery_photos').insert({ album_id: albumId, image_url: adding.url.trim(), alt_text: adding.alt.trim(), caption: adding.caption.trim() || null, sort_order: (list.at(-1)?.sort_order ?? 0) + 1 });
    if (err) { setError(contentErrorMessage(err)); return; }
    setAdding({ url: '', alt: '', caption: '' });
    photos.reload();
  };
  const move = async (i, dir) => {
    const a = list[i]; const b = list[i + dir];
    if (!a || !b) return;
    const r1 = await supabase.from('gallery_photos').update({ sort_order: b.sort_order }).eq('id', a.id);
    const r2 = await supabase.from('gallery_photos').update({ sort_order: a.sort_order }).eq('id', b.id);
    if (r1.error || r2.error) toast(contentErrorMessage(r1.error || r2.error), 'bad');
    photos.reload();
  };
  const removePhoto = async (p) => {
    if (!window.confirm('Remove this photo from the album?')) return;
    const { error: err } = await supabase.from('gallery_photos').delete().eq('id', p.id);
    if (err) toast(contentErrorMessage(err), 'bad');
    photos.reload();
  };

  return (
    <div className="flex flex-col gap-3 border-t border-[#C99A2E]/15 pt-4">
      <h3 className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-[#C99A2E]/85 m-0">Photos ({list.length})</h3>
      <ul className="flex flex-col gap-2 list-none m-0 p-0">
        {list.map((p, i) => (
          <li key={p.id} className="flex items-center gap-3 border border-[#C99A2E]/20 p-2">
            <MediaImg src={p.image_url} alt="" className="w-14 h-14 object-cover" />
            <span className="flex-1 min-w-0 text-[12px]"><span className="block truncate">{p.alt_text}</span>{p.caption && <span className="block truncate opacity-60">{p.caption}</span>}</span>
            {rights.edit && (
              <span className="flex gap-1">
                <Button size="sm" variant="ghost" icon="ArrowUp" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} />
                <Button size="sm" variant="ghost" icon="ArrowDown" aria-label="Move down" disabled={i === list.length - 1} onClick={() => move(i, 1)} />
                <Button size="sm" variant="ghost" icon="Trash2" aria-label="Remove photo" onClick={() => removePhoto(p)} />
              </span>
            )}
          </li>
        ))}
      </ul>
      {rights.edit && (
        <div className="flex flex-col gap-2 border border-dashed border-[#C99A2E]/30 p-3">
          <MediaField label="Add a photo" area="gallery" accept="image/*" value={adding.url} onChange={(v) => setAdding((a) => ({ ...a, url: v }))} canUpload />
          <Field label="Alt text *" hint="What’s in the photo, for screen readers"><Input value={adding.alt} onChange={(e) => setAdding((a) => ({ ...a, alt: e.target.value }))} maxLength={300} /></Field>
          <Field label="Caption"><Input value={adding.caption} onChange={(e) => setAdding((a) => ({ ...a, caption: e.target.value }))} maxLength={300} /></Field>
          {error && <p role="alert" className="text-[12px] text-[#ef6b5e] m-0">{error}</p>}
          <Button icon="Plus" onClick={add} className="self-start">Add photo</Button>
        </div>
      )}
    </div>
  );
}

export function GalleryManager(routeProps) {
  const rights = useContentRights('media');
  const fieldsUi = (f, set, errors, r) => (
    <>
      <Field label="Description"><Textarea rows={3} value={f.description} onChange={(e) => set({ description: e.target.value })} maxLength={2000} /></Field>
      <MediaField label="Cover image" area="gallery" accept="image/*" value={f.cover_url} onChange={(v) => set({ cover_url: v })} error={errors.cover_url} canUpload={r.create || r.edit} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date taken"><Input type="date" value={f.taken_on} onChange={(e) => set({ taken_on: e.target.value })} /></Field>
        <Field label="Order" hint="Lower first"><Input type="number" value={f.sort_order} onChange={(e) => set({ sort_order: e.target.value })} /></Field>
      </div>
      {f.id ? <AlbumPhotos albumId={f.id} rights={r} /> : <p className="text-[12px] text-[#E7D5A4]/55 m-0">Save the album to start adding photos.</p>}
    </>
  );
  return (
    <CollectionManager
      {...routeProps}
      area="media" table="gallery_albums" fields={ALBUM_FIELDS} noun="Album"
      previewPath={(f) => `/gallery/${f.slug}`}
      columns={[{ key: 'taken_on', header: 'Date', render: (r) => (r.taken_on ? fmt.date(r.taken_on) : '—') }]}
      blank={() => ({ ...common(null), description: '', cover_url: '', taken_on: '', sort_order: 0, __fields: fieldsUi })}
      fromRow={(r) => ({ ...common(r), description: r.description || '', cover_url: r.cover_url || '', taken_on: r.taken_on || '', sort_order: r.sort_order ?? 0, __fields: fieldsUi })}
      toRow={(f) => ({ ...commonRow(f), description: f.description.trim() || null, cover_url: f.cover_url.trim() || null, taken_on: f.taken_on || null, sort_order: Number(f.sort_order) || 0 })}
      validate={(f) => (f.cover_url.trim() && !URL_RE.test(f.cover_url.trim()) ? { cover_url: 'Use an https:// link or /media/ path.' } : {})}
    />
  );
}


// Programmes (0031) ------------------------------------------------------------------
const PROGRAMME_FIELDS = 'id, slug, title, year, season, description, venue, cover_url, sort_order, status, published_at, updated_at, programme_events(event_id)';

// Which sessions belong to the programme (programme_events), newest first.
function ProgrammeSessionsField({ value, onChange, disabled }) {
  const events = useAsync(async () => {
    const { data, error } = await supabase.from('events').select('id, name, event_date, status').neq('status', 'draft').order('event_date', { ascending: false });
    if (error) throw error;
    return data || [];
  }, []);
  const [q, setQ] = useState('');
  const rows = (events.data || []).filter((e) => !q || e.name.toLowerCase().includes(q.toLowerCase()) || String(e.event_date).startsWith(q));
  const toggle = (id) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <Field label={`Sessions (${value.length})`} hint="The sessions in this programme, shown on its public page.">
      <div className="flex flex-col gap-2">
        <SearchInput value={q} onChange={setQ} placeholder="Filter by name or year…" />
        <div className="max-h-64 overflow-y-auto border border-[#C99A2E]/20 rounded" data-programme-sessions>
          {events.loading && <p className="p-3 text-[12.5px] text-[#E7D5A4]/60 m-0">Loading sessions…</p>}
          {rows.map((e) => (
            <label key={e.id} className="flex items-center gap-2 px-3 py-2 text-[13px] border-b border-[#E7D5A4]/[0.06] cursor-pointer">
              <input type="checkbox" className="w-4 h-4 accent-[#C99A2E]" checked={value.includes(e.id)} onChange={() => toggle(e.id)} disabled={disabled} />
              <span className="flex-1">{e.name}</span>
              <span className="font-mono text-[11px] text-[#E7D5A4]/60">{fmt.date(e.event_date)}</span>
            </label>
          ))}
        </div>
      </div>
    </Field>
  );
}

export function ProgrammesManager(routeProps) {
  const rights = useContentRights('sessions');
  const fieldsUi = (f, set, errors) => (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Year *" error={errors.year}><Input inputMode="numeric" value={f.year} onChange={(e) => set({ year: e.target.value })} /></Field>
        <Field label="Season"><Input value={f.season} onChange={(e) => set({ season: e.target.value })} maxLength={40} placeholder="Monsoon, Winter…" /></Field>
      </div>
      <Field label="Description"><Textarea rows={4} value={f.description} onChange={(e) => set({ description: e.target.value })} maxLength={4000} /></Field>
      <Field label="Venue(s)"><Input value={f.venue} onChange={(e) => set({ venue: e.target.value })} maxLength={200} /></Field>
      <MediaField label="Cover image" area="sessions" accept="image/*" value={f.cover_url} onChange={(v) => set({ cover_url: v })} error={errors.cover_url} canUpload={false}
        hint="An https:// link or a /media/ path." />
      <ProgrammeSessionsField value={f.event_ids} onChange={(v) => set({ event_ids: v })} disabled={!(rights.create || rights.edit)} />
    </>
  );
  // One transaction (set_programme_sessions, 0043): the list is replaced
  // whole or not at all — a failure never leaves the programme without sessions.
  const syncSessions = async (row, form) => {
    const { error } = await supabase.rpc('set_programme_sessions', { p_programme_id: row.id, p_event_ids: form.event_ids });
    if (error) return { error: `Saved, but the sessions could not be updated (the previous list is unchanged): ${contentErrorMessage(error)}`, form: { event_ids: form.event_ids } };
    return { form: { event_ids: form.event_ids } };
  };
  return (
    <CollectionManager
      {...routeProps}
      area="sessions" table="programmes" fields={PROGRAMME_FIELDS} noun="Programme"
      previewPath={(f) => `/archive/programmes/${f.slug}`}
      columns={[
        { key: 'year', header: 'Year', render: (r) => r.year },
        { key: 'sessions', header: 'Sessions', render: (r) => (r.programme_events || []).length },
      ]}
      blank={() => ({ ...common(null), year: String(new Date().getFullYear()), season: '', description: '', venue: '', cover_url: '', event_ids: [], __fields: fieldsUi })}
      fromRow={(r) => ({ ...common(r), year: String(r.year ?? ''), season: r.season || '', description: r.description || '', venue: r.venue || '', cover_url: r.cover_url || '',
        event_ids: (r.programme_events || []).map((pe) => pe.event_id), __fields: fieldsUi })}
      toRow={(f) => ({ ...commonRow(f), year: Number(f.year), season: f.season.trim() || null, description: f.description.trim(), venue: f.venue.trim() || null, cover_url: f.cover_url.trim() || null })}
      afterSave={syncSessions}
      validate={(f) => {
        const e = {};
        const y = Number(f.year);
        if (!Number.isInteger(y) || y < 2000 || y > 2100) e.year = 'A year between 2000 and 2100.';
        if (f.cover_url.trim() && !URL_RE.test(f.cover_url.trim())) e.cover_url = 'Use an https:// link or /media/ path.';
        return e;
      }}
    />
  );
}
