import { useState } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { changeRows } from '../../lib/mutation';
import { useAdminList } from '../useAdminList';
import { SearchBar, StatusBadge, LoadMoreButton, EmptyState, NotConfiguredState, ActionButton } from '../AdminUI';

// A failed load is not "no messages", and a refused status change is not a
// success: both are shown, with the safe wording from changeRows/friendlyError.
const Problem = ({ text, onRetry }) => (
  <div role="alert" data-enquiry-error className="mb-3 p-3 border border-[#ef4444]/60 bg-[#ef4444]/10 text-[#fca5a5] font-mono text-[11px] flex items-center gap-3">
    <span className="flex-1">{text}</span>
    {onRetry && <button type="button" onClick={onRetry} className="px-3 py-1 border border-current uppercase text-[10px]">Retry</button>}
  </div>
);

export const ContactEnquiriesSection = () => {
  const { rows, total, loading, error, search, setSearch, hasMore, loadMore, reload } = useAdminList('contact_enquiries', {
    searchFields: ['name', 'email', 'subject', 'inquiry_type'],
  });

  const [actionError, setActionError] = useState('');
  const updateStatus = async (id, status) => {
    const r = await changeRows(supabase.from('contact_enquiries').update({ status }).eq('id', id), 'contact_enquiries status');
    setActionError(r.ok ? '' : r.message);
    reload();
  };

  if (error === 'not-configured') return <NotConfiguredState />;

  return (
    <div className="bg-[#191410] border border-[#C99A2E]/60 p-6 rounded-sm">
      <h3 className="text-lg font-bold text-[#C99A2E] mb-4 border-b border-[#C99A2E]/30 pb-2">CONTACT ENQUIRIES</h3>
      <SearchBar value={search} onChange={setSearch} placeholder="Search name, email, type..." count={total} />
      {actionError && <Problem text={actionError} />}
      {loading ? <div className="p-10 text-center font-mono text-xs font-bold text-[#E7D5A4]/60">LOADING...</div> : error ? (
        <Problem text="Couldn't load these enquiries. Check your connection and try again." onRetry={reload} />
      ) : rows.length === 0 ? (
        <EmptyState>NO MESSAGES YET.</EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((c) => (
            <div key={c.id} className="bg-[#11100C] border border-[#C99A2E]/30 p-4">
              <div className="flex justify-between items-start gap-2 mb-2">
                <div>
                  <span className="font-bold">{c.name}</span> <span className="opacity-60 text-[10px]">· {c.email}</span>
                  <div className="text-[9px] text-[#C99A2E] uppercase mt-0.5">{c.inquiry_type} — {c.subject}</div>
                </div>
                <StatusBadge status={c.status} />
              </div>
              <p className="text-xs text-[#E7D5A4]/80 mb-3 whitespace-pre-wrap">{c.message}</p>
              <div className="flex gap-1.5">
                {c.status !== 'read' && <ActionButton onClick={() => updateStatus(c.id, 'read')}>MARK READ</ActionButton>}
                {c.status !== 'replied' && <ActionButton tone="success" onClick={() => updateStatus(c.id, 'replied')}>MARK REPLIED</ActionButton>}
              </div>
            </div>
          ))}
        </div>
      )}
      <LoadMoreButton hasMore={hasMore} onClick={loadMore} />
    </div>
  );
};

export const PrivateEnquiriesSection = () => {
  const { rows, total, loading, error, search, setSearch, hasMore, loadMore, reload } = useAdminList('private_enquiries', {
    searchFields: ['name', 'email', 'type', 'status'],
  });

  const [actionError, setActionError] = useState('');
  const updateStatus = async (id, status) => {
    const r = await changeRows(supabase.from('private_enquiries').update({ status }).eq('id', id), 'private_enquiries status');
    setActionError(r.ok ? '' : r.message);
    reload();
  };

  if (error === 'not-configured') return <NotConfiguredState />;

  return (
    <div className="bg-[#191410] border border-[#C99A2E]/60 p-6 rounded-sm">
      <h3 className="text-lg font-bold text-[#C99A2E] mb-4 border-b border-[#C99A2E]/30 pb-2">PRIVATE SESSION ENQUIRIES</h3>
      <SearchBar value={search} onChange={setSearch} placeholder="Search name, email, type..." count={total} />
      {actionError && <Problem text={actionError} />}
      {loading ? <div className="p-10 text-center font-mono text-xs font-bold text-[#E7D5A4]/60">LOADING...</div> : error ? (
        <Problem text="Couldn't load these enquiries. Check your connection and try again." onRetry={reload} />
      ) : rows.length === 0 ? (
        <EmptyState>NO PRIVATE ENQUIRIES YET.</EmptyState>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((p) => (
            <div key={p.id} className="bg-[#11100C] border border-[#C99A2E]/30 p-4">
              <div className="flex justify-between items-start gap-2 mb-2">
                <div>
                  <span className="font-bold">{p.name}</span> <span className="opacity-60 text-[10px]">· {p.email} · {p.phone}</span>
                  <div className="text-[9px] text-[#C99A2E] uppercase mt-0.5">{p.type.replace('_', ' ')} — {p.preferred_date} — {p.guest_count} guests</div>
                </div>
                <StatusBadge status={p.status} />
              </div>
              <p className="text-xs text-[#E7D5A4]/80 mb-3 whitespace-pre-wrap">{p.message}</p>
              <div className="flex gap-1.5">
                {p.status !== 'approved' && <ActionButton tone="success" onClick={() => updateStatus(p.id, 'approved')}>APPROVE</ActionButton>}
                {p.status !== 'rejected' && <ActionButton tone="danger" onClick={() => updateStatus(p.id, 'rejected')}>DECLINE</ActionButton>}
              </div>
            </div>
          ))}
        </div>
      )}
      <LoadMoreButton hasMore={hasMore} onClick={loadMore} />
    </div>
  );
};
