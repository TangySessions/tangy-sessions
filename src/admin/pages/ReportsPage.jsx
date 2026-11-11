import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAdminSession } from '../AdminSession';
import { adminApi, rpc } from '../api';
import { useAsync } from '../hooks';
import { P, localISODate } from '../rbac';
import { Page, Panel, Grid, StatTile, Toolbar, FilterSelect, Input, Badge, AsyncBlock, Button, fmt } from '../ui';

const PRESETS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: 'year', label: 'This year' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom range' },
];

function presetRange(preset) {
  const today = new Date();
  if (preset === 'all') return ['', ''];
  if (preset === 'year') return [`${today.getFullYear()}-01-01`, ''];
  const from = new Date(today);
  from.setDate(from.getDate() - Number(preset));
  return [localISODate(from), ''];
}

// Single-series magnitude bar with the value always printed beside it.
const InlineBar = ({ value, max, label }) => (
  <div className="flex items-center gap-2 min-w-[160px]" title={label}>
    <div className="flex-1 h-2 rounded-full bg-[#E7D5A4]/[0.07] overflow-hidden">
      <div className="h-full rounded-full bg-[#C99A2E]" style={{ width: `${max > 0 ? Math.max(2, (100 * value) / max) : 0}%` }} />
    </div>
    <span className="w-24 text-right tabular-nums text-[12.5px]">{label}</span>
  </div>
);

const Th = ({ children, right }) => <th className={`px-4 py-2 font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-[#E7D5A4]/60 whitespace-nowrap ${right ? 'text-right' : 'text-left'}`}>{children}</th>;
const Td = ({ children, right, className = '' }) => <td className={`px-4 py-2.5 ${right ? 'text-right tabular-nums' : ''} ${className}`}>{children}</td>;

export default function ReportsPage() {
  const { can } = useAdminSession();
  const [preset, setPreset] = useState('90');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [from, to] = preset === 'custom' ? [custom.from, custom.to] : presetRange(preset);

  const events = useAsync(() => adminApi.reportEventPerformance(from, to), [from, to]);
  const revenue = useAsync(() => (can(P.PAYMENTS) ? adminApi.reportRevenueByMonth(from, to) : []), [from, to]);
  const apps = useAsync(() => (can(P.APPLICATIONS_VIEW) ? adminApi.reportApplications(from, to) : []), [from, to]);
  const staff = useAsync(() => adminApi.reportStaffActivity(from, to), [from, to]);
  const platform = useAsync(() => rpc('report_platform_activity', { p_from: from || null, p_to: to || null }), [from, to]);

  const ev = events.data || [];
  const totals = ev.reduce((t, e) => ({
    sold: t.sold + Number(e.tickets_sold), comp: t.comp + Number(e.complimentary), revenue: t.revenue + Number(e.revenue || 0),
    checkedIn: t.checkedIn + Number(e.checked_in), capacity: t.capacity + e.capacity,
  }), { sold: 0, comp: 0, revenue: 0, checkedIn: 0, capacity: 0 });
  const maxRevenue = Math.max(0, ...(revenue.data || []).map((r) => Number(r.revenue)));
  const maxSold = Math.max(0, ...ev.map((e) => Number(e.tickets_sold)));

  return (
    <Page title="Reports" subtitle="Every figure is computed live from bookings, tickets, check-ins and applications — nothing is estimated.">
      <Toolbar>
        <FilterSelect label="Period" value={preset} onChange={setPreset} options={PRESETS} />
        {preset === 'custom' && (
          <>
            <Input type="date" aria-label="From" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} className="w-auto" />
            <Input type="date" aria-label="To" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} className="w-auto" />
          </>
        )}
        <span className="font-mono text-[11px] text-[#E7D5A4]/60">Events by event date · revenue by booking date</span>
      </Toolbar>

      <Grid cols={4}>
        <StatTile label="Tickets sold" value={events.loading ? '…' : fmt.num(totals.sold)} sub={`${fmt.num(totals.comp)} complimentary · ${ev.length} events`} />
        {can(P.PAYMENTS) && <StatTile label="Revenue (events in period)" value={events.loading ? '…' : fmt.money(totals.revenue)} />}
        <StatTile label="Sell-through" value={totals.capacity ? fmt.pct((100 * totals.sold) / totals.capacity) : '—'} sub={`${fmt.num(totals.sold)} of ${fmt.num(totals.capacity)} seats`} />
        <StatTile label="Attendance" value={totals.sold ? fmt.pct((100 * totals.checkedIn) / totals.sold) : '—'} sub={`${fmt.num(totals.checkedIn)} checked in of ${fmt.num(totals.sold)} sold`} />
      </Grid>

      <Panel title="Event performance" flush>
        <AsyncBlock loading={events.loading} error={events.error} onRetry={events.reload} empty={ev.length === 0} emptyProps={{ title: 'No published events in this period', icon: 'BarChart3' }}>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead><tr className="border-b border-[#C99A2E]/20"><Th>Event</Th><Th>Status</Th><Th>Tickets sold</Th><Th right>Sell-through</Th>{can(P.PAYMENTS) && <Th right>Revenue</Th>}<Th right>Check-in</Th><Th right>Pending</Th><Th right>Cancelled</Th><Th right>Refunded</Th></tr></thead>
              <tbody>
                {ev.map((e) => (
                  <tr key={e.event_id} className="border-b border-[#E7D5A4]/[0.06]">
                    <Td><Link to={`/admin-portal/events/${e.event_id}/reports`} className="hover:underline text-[#EFE2C0]">{e.name}</Link><div className="font-mono text-[11px] text-[#E7D5A4]/60">{fmt.date(e.event_date)}</div></Td>
                    <Td><Badge status={e.status} /></Td>
                    <Td><InlineBar value={Number(e.tickets_sold)} max={maxSold} label={`${fmt.num(e.tickets_sold)} / ${fmt.num(e.capacity)}`} /></Td>
                    <Td right>{fmt.pct(e.sell_through)}</Td>
                    {can(P.PAYMENTS) && <Td right>{fmt.money(e.revenue)}</Td>}
                    <Td right>{e.check_in_rate != null ? fmt.pct(e.check_in_rate) : '—'}</Td>
                    <Td right>{fmt.num(e.bookings_pending)}</Td>
                    <Td right>{fmt.num(e.bookings_cancelled)}</Td>
                    <Td right>{fmt.num(e.bookings_refunded)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AsyncBlock>
      </Panel>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {can(P.PAYMENTS) && (
          <Panel title="Revenue by month" subtitle="Confirmed bookings by booking date" flush>
            <AsyncBlock loading={revenue.loading} error={revenue.error} onRetry={revenue.reload} empty={(revenue.data || []).length === 0} emptyProps={{ title: 'No bookings in this period', icon: 'BarChart3' }}>
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead><tr className="border-b border-[#C99A2E]/20"><Th>Month</Th><Th>Revenue</Th><Th right>Bookings</Th><Th right>Tickets</Th><Th right>Refunded</Th></tr></thead>
                  <tbody>
                    {(revenue.data || []).map((r) => (
                      <tr key={r.month} className="border-b border-[#E7D5A4]/[0.06]">
                        <Td className="font-mono text-[12px]">{new Date(`${r.month}T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}</Td>
                        <Td><InlineBar value={Number(r.revenue)} max={maxRevenue} label={fmt.money(r.revenue)} /></Td>
                        <Td right>{fmt.num(r.bookings)}</Td><Td right>{fmt.num(r.tickets)}</Td><Td right>{fmt.money(r.refunded)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </AsyncBlock>
          </Panel>
        )}
        {can(P.APPLICATIONS_VIEW) && (
          <Panel title="Applications" subtitle="By submission date" flush actions={<Button size="sm" variant="ghost" to="/admin-portal/applications">Open</Button>}>
            <AsyncBlock loading={apps.loading} error={apps.error} onRetry={apps.reload} empty={(apps.data || []).length === 0} emptyProps={{ title: 'No applications in this period', icon: 'Inbox' }}>
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead><tr className="border-b border-[#C99A2E]/20"><Th>Type</Th><Th right>Pending</Th><Th right>Approved</Th><Th right>Rejected</Th><Th right>Avg. review time</Th></tr></thead>
                  <tbody>
                    {(apps.data || []).map((a) => (
                      <tr key={a.type} className="border-b border-[#E7D5A4]/[0.06]">
                        <Td className="capitalize">{a.type}</Td><Td right>{fmt.num(a.pending)}</Td><Td right>{fmt.num(a.approved)}</Td><Td right>{fmt.num(a.rejected)}</Td>
                        <Td right>{a.avg_review_hours != null ? (a.avg_review_hours < 48 ? `${a.avg_review_hours} h` : `${(a.avg_review_hours / 24).toFixed(1)} d`) : '—'}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </AsyncBlock>
          </Panel>
        )}
      </div>

      <Panel title="Staff & team activity" subtitle="Check-ins in the period; tasks and assignments all-time" flush>
        <AsyncBlock loading={staff.loading} error={staff.error} onRetry={staff.reload} empty={(staff.data || []).length === 0} emptyProps={{ title: 'No team activity yet', icon: 'UsersRound' }}>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead><tr className="border-b border-[#C99A2E]/20"><Th>Person</Th><Th>Role</Th><Th right>Events</Th><Th right>Check-ins</Th><Th right>Manual</Th><Th right>Tasks done</Th><Th right>Tasks open</Th></tr></thead>
              <tbody>
                {(staff.data || []).map((s) => (
                  <tr key={s.user_id} className="border-b border-[#E7D5A4]/[0.06]">
                    <Td className="text-[#EFE2C0]">{s.name}</Td><Td><Badge status={s.role}>{s.role.replace('_', ' ')}</Badge></Td>
                    <Td right>{fmt.num(s.events_assigned)}</Td><Td right>{fmt.num(s.checkins)}</Td><Td right>{fmt.num(s.manual_checkins)}</Td><Td right>{fmt.num(s.tasks_done)}</Td><Td right>{fmt.num(s.tasks_open)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AsyncBlock>
      </Panel>

      <PlatformActivity q={platform} />
    </Page>
  );
}

const TYPE_LABEL = { artist_support: 'Artists', sponsor_support: 'Sponsors', vendor_support: 'Vendors', venue_support: 'Venue hosts' };

// Partners, volunteer participation and partner communication — real counts only.
const PlatformActivity = ({ q }) => {
  const d = q.data;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Panel title="Partners" subtitle="Active accounts today">
        <AsyncBlock loading={q.loading} error={q.error} onRetry={q.reload} rows={3}>
          {d && <Grid cols={2}>
            <StatTile label="Artists" value={fmt.num(d.partners.artists)} sub="approved" />
            <StatTile label="Sponsors" value={fmt.num(d.partners.sponsors)} />
            <StatTile label="Vendors" value={fmt.num(d.partners.vendors)} />
            <StatTile label="Venue hosts" value={fmt.num(d.partners.venue_hosts)} />
          </Grid>}
        </AsyncBlock>
      </Panel>
      <Panel title="Volunteer participation" subtitle="In the selected period">
        <AsyncBlock loading={q.loading} error={q.error} onRetry={q.reload} rows={3}>
          {d && <Grid cols={2}>
            <StatTile label="Active volunteers" value={fmt.num(d.partners.volunteers)} />
            <StatTile label="Event assignments" value={fmt.num(d.volunteers.assignments)} />
            <StatTile label="Check-in grants" value={fmt.num(d.volunteers.access_grants)} sub={`${fmt.num(d.volunteers.access_revoked)} revoked · ${fmt.num(d.volunteers.access_requests)} requested`} />
            <StatTile label="Tickets checked in" value={fmt.num(d.volunteers.checkins_by_volunteers)} sub="by volunteers" />
          </Grid>}
        </AsyncBlock>
      </Panel>
      <Panel title="Partner communication" subtitle="In the selected period">
        <AsyncBlock loading={q.loading} error={q.error} onRetry={q.reload} rows={3}>
          {d && (
            <div className="flex flex-col gap-3">
              <Grid cols={2}>
                <StatTile label="Conversations" value={fmt.num(d.communication.conversations)} />
                <StatTile label="Messages" value={fmt.num(d.communication.messages)} />
                <StatTile label="Awaiting reply" value={fmt.num(d.communication.awaiting_reply)} tone={d.communication.awaiting_reply ? 'warn' : undefined} sub="right now" />
                <StatTile label="Median first reply" value={d.communication.median_first_reply_minutes != null ? `${fmt.num(d.communication.median_first_reply_minutes)} min` : 'No data'} />
              </Grid>
              {Object.keys(d.communication.by_type || {}).length > 0 ? (
                <ul className="text-[12.5px] flex flex-wrap gap-x-4 gap-y-1 text-[#E7D5A4]/70">
                  {Object.entries(d.communication.by_type).map(([k, n]) => <li key={k}>{TYPE_LABEL[k] || k}: <span className="text-[#EFE2C0] tabular-nums">{n}</span></li>)}
                </ul>
              ) : <p className="text-[12.5px] text-[#E7D5A4]/60">No data available</p>}
              <p className="text-[12px] text-[#E7D5A4]/60">Requirements: {fmt.num(d.requirements.requested)} requested · {fmt.num(d.requirements.answered)} answered · {fmt.num(d.requirements.open)} open now</p>
            </div>
          )}
        </AsyncBlock>
      </Panel>
    </div>
  );
};
