import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { launch, otpLogin, shot, check, api, BASE } from './lib.mjs';

// The Tangy booking form (0024) end to end at 390px: an admin configures the
// event's form (max per booking, chair seating, area, required date of
// birth); a customer goes Your details → Who's coming (5 named people) →
// Requirements → Review & pay, with every step validated; the real
// razorpay-create-order stores the booking + details; payment failure shows
// "Payment unsuccessful / Try again" and confirms nothing; payment success,
// a duplicate and a failure arrive as Razorpay webhooks through the real
// razorpay-webhook (HMAC-verified) function; the customer then sees one QR
// and five names, the admin sees the whole booking and the lead, and staff
// check the named attendees in (2 now, 3 later).
//
// Local-stack limits (stated, not faked): there is no Razorpay account here,
// so the hosted checkout and Razorpay's order API are not reachable. After the
// real create-order has stored the booking, the test attaches an order id
// (what Razorpay's API would return) and delivers webhooks signed with the
// local stack's own test secret — every server check runs for real.

const DB = process.env.DB_CONTAINER || 'supabase_db_localstack';
const ANON = process.env.ANON_KEY;
const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET_LOCAL;
if (!SECRET) throw new Error('Set RAZORPAY_WEBHOOK_SECRET_LOCAL (the local stack\'s functions.env value) — see e2e/README.md');
const sql = (q) => execFileSync('docker', ['exec', DB, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atc', q]).toString().trim();
const until = (p, ms = 15000) => p.waitFor({ timeout: ms }).then(() => true, () => false);
const text = async (loc) => (await loc.innerText().catch(() => '')).replace(/\s+/g, ' ');
const V5 = sql("select id from events where slug = 'vol-5-local'");
const V6 = sql("select id from events where slug = 'vol-6-local'");
const NAMES = ['Rahul Sharma', 'Priya Sharma', 'Arjun Nair', 'Kavya Singh', 'Neha Verma'];

const allErrors = [];
const refused = [];
const track = (label, errors) => allErrors.push(...errors.filter((e) => !/\b(401|403)\b|Failed to load resource|realtime\/v1\/websocket|favicon/.test(e)).map((e) => `${label}: ${e}`));
async function attempt(s, label, fn) {
  const before = s.errors.length;
  const out = await fn();
  refused.push(...s.errors.splice(before).map((e) => `${label}: ${e}`));
  return out;
}
async function fits(p, label) {
  const r = await p.evaluate(() => {
    const over = document.documentElement.scrollWidth - window.innerWidth;
    const small = [...document.querySelectorAll('[data-checkout-step] input:not([type=checkbox]):not([type=radio]), [data-checkout-step] button, [data-checkout-step] textarea')]
      .filter((el) => el.offsetParent).map((el) => el.getBoundingClientRect()).filter((b) => b.height < 43.5).length;
    return { over, small };
  });
  check(r.over <= 1 && r.small === 0, `${label}: fits 390px, inputs and buttons ≥ 44px (${r.over > 1 ? `+${r.over}px ` : ''}${r.small ? `${r.small} small` : 'ok'})`);
}
const webhook = async (event, orderId, paymentId, { forge = false } = {}) => {
  const body = JSON.stringify({ event, payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: 589400, currency: 'INR', status: event === 'payment.failed' ? 'failed' : 'captured' } } } });
  const sig = forge ? 'f'.repeat(64) : createHmac('sha256', SECRET).update(body).digest('hex');
  const res = await fetch('http://127.0.0.1:54321/functions/v1/razorpay-webhook', {
    method: 'POST', body,
    // apikey/Authorization only get past the local gateway; production deploys this function with --no-verify-jwt.
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig, apikey: ANON, Authorization: `Bearer ${ANON}` },
  });
  return { status: res.status, text: await res.text() };
};

// ================================================================ 1. admin configures the event's booking form
{
  const s = await launch();
  await otpLogin(s.page, 'manager@tangy.test', '/admin-portal');
  const p = s.page;
  await p.goto(`${BASE}/admin-portal/events/${V6}?tab=details`);
  check(await until(p.getByRole('button', { name: 'Save booking form' })), 'event details: booking form editor');
  await p.getByLabel('Max tickets per booking').fill('6');
  for (const preset of ['Chair seating (count)', 'Area of the city', 'Date of birth']) await p.getByRole('button', { name: preset, exact: true }).click();
  await p.getByLabel('Required: Date of birth').check();
  check(await p.getByRole('button', { name: 'Gender', exact: true }).isEnabled() && await p.getByRole('button', { name: 'Date of birth', exact: true }).isDisabled(), 'added presets cannot be added twice; others stay optional');
  await p.getByRole('button', { name: 'Save booking form' }).click();
  check(await until(p.getByText('Booking form saved')), 'admin saves the booking form');
  const cfg = JSON.parse(sql(`select json_build_object('max', booking_max_quantity, 'q', booking_questions) from events where id = '${V6}'`));
  check(cfg.max === 6 && cfg.q.map((q) => q.id).join(',') === 'chairs,area,dob' && cfg.q.find((q) => q.id === 'dob').required === true
    && !cfg.q.some((q) => q.id === 'gender'), 'stored: max 6; chairs, area, required DOB; no gender (not configured)');
  await shot(p, 'c01-admin-booking-form');
  track('admin form', s.errors); await s.browser.close();
}

// ================================================================ 2. customer checkout at 390px
let code;
const customer = await launch({ mobile: true });
await otpLogin(customer.page, 'patron@tangy.test', '/join/login');
{
  const p = customer.page;
  await p.goto(`${BASE}/book/vol-6-local`);
  const progress = p.locator('[data-checkout-progress]');
  check(await until(progress) && /Your details/i.test(await text(progress.locator('[aria-current="step"]'))), 'progress: step 1 of 5 (Your details)');
  // Step 1 — required details, validated before moving on.
  await p.getByLabel(/^Full name/).fill('');
  await p.getByLabel(/^Mobile \/ WhatsApp number/).fill('12345');
  await p.getByLabel(/^Email/).fill('pat@');
  await p.getByLabel(/^Instagram/).fill('bad handle!');
  await p.getByRole('button', { name: 'Continue →' }).tap();
  const errs = await text(p.locator('[data-checkout-step]'));
  check(/Enter your full name/.test(errs) && /valid 10-digit mobile/.test(errs) && /valid email/.test(errs) && /Instagram handles use/.test(errs),
    'step 1 refuses missing name, bad mobile, bad email, bad Instagram');
  const firstFocus = await p.waitForFunction(() => document.activeElement?.id === 'c-name', null, { timeout: 3000 }).then(() => true, () => false);
  check(firstFocus && (await p.getByLabel(/^Full name/).getAttribute('aria-invalid')) === 'true', 'focus moves to the first problem, marked aria-invalid');
  await fits(p, 'step 1');
  await shot(p, 'c02-step1-errors');
  await p.getByLabel(/^Full name/).fill('Pat Patron');
  await p.getByLabel(/^Mobile \/ WhatsApp number/).fill('98765 43210');
  await p.getByLabel(/^Email/).fill('patron@tangy.test');
  await p.getByLabel(/^Instagram/).fill('@pat.patron');
  await p.getByRole('button', { name: 'Continue →' }).tap();

  // Step 2 — number of people within the event's range, a name for each.
  check(await until(p.locator('[data-checkout-step="2"]')), 'step 2: who’s coming');
  for (let i = 0; i < 5; i++) await p.getByRole('button', { name: 'More people' }).tap();
  check(await p.locator('[data-ticket-quantity]').innerText() === '6' && await p.getByRole('button', { name: 'More people' }).isDisabled(), 'cannot exceed the event maximum (6)');
  await p.getByRole('button', { name: 'Fewer people' }).tap();
  const person = (i) => p.getByLabel(new RegExp(`^Person ${i} — full name`));
  check(await p.waitForFunction(() => document.querySelectorAll('[data-attendee-names] input').length === 5, null, { timeout: 5000 }).then(() => true, () => false), '5 people: 5 name fields');
  check(/₹999 \/ person · Subtotal ₹4,995/.test(await text(p.locator('[data-price-line]'))), 'price from the event: ₹999 / person, subtotal ₹4,995');
  for (const [i, n] of NAMES.entries()) await person(i + 1).fill(i === 2 ? '   ' : n);
  await p.getByRole('button', { name: 'Continue →' }).tap();
  const blankErr = await until(p.getByText('✕ Enter this person’s full name.'));
  const focused = await p.waitForFunction(() => document.activeElement?.id === 'person-3', null, { timeout: 3000 }).then(() => 'person-3', () => p.evaluate(() => document.activeElement?.id));
  check(blankErr && focused === 'person-3', `a whitespace-only attendee name blocks the step and is focused (${blankErr}, focus ${focused})`);
  await person(3).fill(NAMES[2]);
  // Going back keeps everything.
  await p.getByRole('button', { name: '← Back', exact: true }).tap();
  check((await p.getByLabel(/^Instagram/).inputValue()) === '@pat.patron', 'back to step 1: details kept');
  await p.getByRole('button', { name: 'Continue →' }).tap();
  check((await person(5).inputValue()) === 'Neha Verma' && await p.locator('[data-attendee-names] input').count() === 5, 'forward again: 5 names kept');
  await fits(p, 'step 2');
  await shot(p, 'c03-step2-attendees');
  await p.getByRole('button', { name: 'Continue →' }).tap();

  // Step 3 — only this event's questions.
  check(await until(p.locator('[data-checkout-step="3"]')), 'step 3: event requirements');
  const qs = await text(p.locator('[data-checkout-step]'));
  check(/How many people in your group need chair seating/i.test(qs) && /Which part of Hyderabad/i.test(qs) && /Date of birth/i.test(qs) && !/Gender/i.test(qs),
    'shows chair seating, area and date of birth — not gender (not configured)');
  await p.getByRole('button', { name: 'Review →' }).tap();
  check(await until(p.getByText('✕ Please answer this question.')), 'required date of birth enforced');
  await p.getByLabel(/^How many people in your group need chair seating/).fill('6');
  await p.getByLabel(/^Date of birth/).fill('1962-03-14');
  await p.getByRole('button', { name: 'Review →' }).tap();
  check(await until(p.getByText(/Enter a whole number from 0 to 5/)), 'chairs cannot exceed the group size');
  await p.getByLabel(/^How many people in your group need chair seating/).fill('2');
  await p.locator('[data-question="area"]').getByText('Old City', { exact: true }).tap();
  await p.getByText(/Interested in collaborating with Tangy/).tap();
  await p.getByText('Volunteer', { exact: true }).tap();
  await p.getByText('Sound / technical', { exact: true }).tap();
  await p.getByLabel(/^Tell us more/).fill('FOH mixing for 5 years');
  await p.getByLabel(/^Anything else/).fill('One of us uses a walking stick.');
  await fits(p, 'step 3');
  await shot(p, 'c04-step3-requirements');
  await p.getByRole('button', { name: 'Review →' }).tap();

  // Step 4 — summary from real pricing, then payment.
  const sum = p.locator('[data-order-summary]');
  check(await until(sum), 'step 4: order summary');
  const st = await text(sum);
  check(/Tangy Sessions Vol\. 6/.test(st) && /₹999 × 5/.test(st) && NAMES.every((n) => st.includes(n)) && /Subtotal ₹4,995/.test(st) && /GST \(18%\) ₹899/.test(st),
    'summary: event, ₹999 × 5, all 5 attendees, subtotal and GST');
  check(/TOTAL ₹5,894/.test(await text(p.locator('[data-order-total]'))) && /Old City/.test(st) && /Volunteer, Sound \/ technical/.test(st), 'total ₹5,894; answers and interests shown for review');
  const manualPay = await p.locator('input, textarea').evaluateAll((els) => els.filter((e) => /upi|screenshot|transaction|amount paid/i.test(`${e.labels?.[0]?.innerText || ''} ${e.name} ${e.id} ${e.placeholder}`)).length);
  check(manualPay === 0, 'no manual UPI id / screenshot / amount fields — the gateway provides them');
  await fits(p, 'step 4');
  await shot(p, 'c05-step4-summary');
  const before = Number(sql(`select count(*) from bookings where event_id = '${V6}' and attendee_email = 'patron@tangy.test'`));
  await attempt(customer, 'checkout (no Razorpay account on the local stack)', async () => {
    await p.getByRole('button', { name: /Proceed to payment · ₹5,894/ }).tap();
    await p.locator('[data-payment-failed]').waitFor({ timeout: 25000 }).catch(() => {});
  });
  check(await until(p.locator('[data-payment-failed]')) && /Payment unsuccessful/.test(await text(p.locator('[data-payment-failed]'))), 'payment failure: "Payment unsuccessful" with a way to retry');
  const b1 = JSON.parse(sql(`select row_to_json(x) from (select registration_code, status, attendee_names, booking_answers, contact_instagram, customer_note, collab_interests, collab_note, attendee_phone
    from bookings where event_id = '${V6}' and attendee_email = 'patron@tangy.test' order by created_at desc limit 1) x`));
  check(Number(sql(`select count(*) from bookings where event_id = '${V6}' and attendee_email = 'patron@tangy.test'`)) === before + 1 && b1.status === 'failed',
    `the real create-order stored the booking, then released it when payment could not start (${b1.status})`);
  check(JSON.stringify(b1.attendee_names) === JSON.stringify(NAMES) && b1.booking_answers.dob === '1962-03-14' && b1.booking_answers.chairs === 2 && b1.booking_answers.area === 'Old City'
    && b1.contact_instagram === 'pat.patron' && b1.attendee_phone === '9876543210' && b1.customer_note === 'One of us uses a walking stick.'
    && b1.collab_interests.join(',') === 'sound_technical,volunteer' && b1.collab_note === 'FOH mixing for 5 years',
    'server stored the 5 names, validated answers, normalised phone and handle, interests and notes');
  check(Number(sql(`select count(*) from tickets t join bookings b on b.id = t.booking_id where b.registration_code = '${b1.registration_code}'`)) === 0, 'failed payment: no attendees, no usable QR');

  // Retry: a new attempt, still nothing confirmed.
  await attempt(customer, 'retry (no Razorpay account on the local stack)', async () => {
    await p.locator('[data-payment-failed]').getByRole('button', { name: 'Try again' }).tap();
    await p.waitForTimeout(2500);
    await p.locator('[data-payment-failed]').waitFor({ timeout: 20000 }).catch(() => {});
  });
  const attempts = sql(`select string_agg(status::text, ',' order by created_at) from bookings where event_id = '${V6}' and attendee_email = 'patron@tangy.test'`);
  check(attempts === 'failed,failed' && Number(sql(`select count(*) from bookings where event_id = '${V6}' and status = 'confirmed' and attendee_email = 'patron@tangy.test'`)) === 0,
    `retry makes a fresh attempt; still no confirmed booking (${attempts})`);
  check(/Payment unsuccessful/.test(await text(p.locator('[data-payment-failed]'))) && (await p.getByLabel(/^Person 1/).count()) === 0 && /Rahul Sharma/.test(await text(p.locator('[data-order-summary]'))),
    'the customer stays on the summary with everything kept');
  code = sql(`select registration_code from bookings where event_id = '${V6}' and attendee_email = 'patron@tangy.test' order by created_at desc limit 1`);
}

// ================================================================ 3. payment via signed Razorpay webhooks
const orderId = `order_e2e_${randomBytes(6).toString('hex')}`;
const paymentId = `pay_e2e_${randomBytes(6).toString('hex')}`;
const failedCode = sql(`select registration_code from bookings where event_id = '${V6}' and attendee_email = 'patron@tangy.test' order by created_at asc limit 1`);
{
  // What Razorpay's order API returns (unreachable locally): the order id on
  // the pending booking. One account holds at most one unpaid checkout per
  // session (0037, bookings_one_active_hold), so the two attempts are made the
  // pending hold one after the other.
  //
  // a) A failed payment ATTEMPT (0037/0038 revision): the hold keeps its seats
  //    and stays pending so the customer can retry on the same order; only
  //    payment_status records the failure. It is released by the normal expiry.
  sql(`update bookings set status = 'pending', payment_status = 'created', razorpay_order_id = '${orderId}_x' where registration_code = '${failedCode}'`);
  const fl = await webhook('payment.failed', `${orderId}_x`, `${paymentId}_f`);
  check(fl.status === 200 && sql(`select status || '|' || payment_status from bookings where registration_code = '${failedCode}'`) === 'pending|failed'
    && Number(sql(`select count(*) from tickets t join bookings b on b.id = t.booking_id where b.registration_code = '${failedCode}'`)) === 0,
    'payment.failed webhook: the hold stays pending for a retry (payment_status failed), no attendees, no QR');
  // The hold lapses (expire_stale_bookings would do this after the timeout).
  sql(`update bookings set status = 'expired', expired_at = now() where registration_code = '${failedCode}'`);
  // b) The successful checkout.
  sql(`update bookings set status = 'pending', payment_status = 'created', razorpay_order_id = '${orderId}' where registration_code = '${code}'`);
  const forged = await webhook('payment.captured', orderId, paymentId, { forge: true });
  check(forged.status === 400 && sql(`select status from bookings where registration_code = '${code}'`) === 'pending', 'forged webhook signature refused; booking not confirmed');
  const ok = await webhook('payment.captured', orderId, paymentId);
  check(ok.status === 200, `signed payment.captured accepted (${ok.status} ${ok.text})`);
  const bk = sql(`select status || '|' || payment_status || '|' || coalesce(razorpay_payment_id, '') from bookings where registration_code = '${code}'`);
  check(bk === `confirmed|captured|${paymentId}`, `payment verified server-side: booking confirmed (${bk})`);
  check(sql(`select string_agg(t.attendee_name, ',' order by t.ticket_number) from tickets t join bookings b on b.id = t.booking_id where b.registration_code = '${code}'`) === NAMES.join(','),
    'booking created 5 attendees, in order');
  const dup = await webhook('payment.captured', orderId, paymentId);
  check(dup.status === 200 && /duplicate/.test(dup.text) && Number(sql(`select count(*) from tickets t join bookings b on b.id = t.booking_id where b.registration_code = '${code}'`)) === 5
    && Number(sql(`select count(*) from payment_webhook_events where event_id = 'payment.captured:${paymentId}'`)) === 1, 'duplicate webhook: recognised, no duplicate booking or attendees');
  // The lapsed attempt never became a booking.
  check(Number(sql(`select count(*) from tickets t join bookings b on b.id = t.booking_id where b.registration_code = '${failedCode}'`)) === 0
    && sql(`select status from bookings where registration_code = '${failedCode}'`) === 'expired', 'the failed, lapsed attempt has no attendees and is not a booking');
}

// ================================================================ 4. customer: booking management
{
  const p = customer.page;
  await p.goto(`${BASE}/dashboard`);
  await p.getByRole('link', { name: /BOOKINGS/ }).tap();
  const card = p.locator('div', { has: p.locator('[data-booking-pass]') }).filter({ hasText: 'Tangy Sessions Vol. 6' }).last();
  check(await until(card), 'the booking appears under upcoming bookings');
  const ct = await text(card);
  check(new RegExp(`Booking ${code} · 5 attendees .* Paid`, 'i').test(ct), `card: booking ID, 5 attendees, paid (${ct.slice(0, 120)})`);
  check(await card.getByRole('img', { name: 'Group pass QR code' }).count() === 1 && NAMES.every((n) => ct.includes(n)) && /0 \/ 5 checked in/i.test(ct), 'one QR, all five names, 0 / 5 checked in');
  check(await p.locator('[data-booking-pass]').filter({ hasText: 'Tangy Sessions Vol. 6' }).count() <= 1 && !/FAILED/i.test(await text(p.locator('main'))), 'failed attempts are not listed as bookings');
  const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(over <= 1, `booking management fits 390px${over > 1 ? ` (+${over}px)` : ''}`);
  await shot(p, 'c06-customer-booking');
  // Privacy: another account can't see this booking or its attendees.
  const other = await launch();
  await otpLogin(other.page, 'vendorco@tangy.test', '/join/login');
  const rb = await api(other.page, 'GET', `/rest/v1/bookings?registration_code=eq.${code}&select=booking_answers`);
  const rt = await api(other.page, 'GET', `/rest/v1/tickets?select=attendee_name&ticket_number=like.${code}*`);
  check(Array.isArray(rb.data) && rb.data.length === 0 && Array.isArray(rt.data) && rt.data.length === 0, 'another account sees neither the booking, its answers nor its attendees');
  const pub = await fetch(`http://127.0.0.1:54321/rest/v1/tickets?select=attendee_name&ticket_number=like.${code}*`, { headers: { apikey: ANON } }).then((r) => r.json());
  check(Array.isArray(pub) && pub.length === 0, 'the public API exposes no attendee names');
  track('other account', other.errors); await other.browser.close();
}

// ================================================================ 5. admin: booking, lead, attendees
{
  const s = await launch({ mobile: true });
  await otpLogin(s.page, 'manager@tangy.test', '/admin-portal');
  const p = s.page;
  await p.goto(`${BASE}/admin-portal/bookings?q=${code}`);
  await p.locator('main').getByText(code).locator('visible=true').first().tap();
  const drawer = p.locator('[data-detail-page]');
  check(await until(drawer.getByText('Primary booker', { exact: true })), 'admin opens the booking (its own page)');
  const dt = await text(drawer);
  check(/Pat Patron/.test(dt) && /9876543210/.test(dt) && /patron@tangy\.test/.test(dt) && /@pat\.patron/.test(dt), 'primary booker: name, mobile, email, Instagram');
  check(await until(drawer.getByText(/1 other confirmed booking/)), 'previous attendance derived from history (not asked)');
  const det = await text(drawer.locator('[data-booking-details]'));
  check(/How many people in your group need chair seating\? 2/i.test(det) && /Which part of Hyderabad are you coming from\? Old City/i.test(det) && /Date of birth 14 Mar 1962/i.test(det)
    && /Volunteer/i.test(det) && /Sound \/ technical/i.test(det) && /FOH mixing/.test(det) && /walking stick/i.test(det), `booking details: answers, collaboration interest, note (${det.slice(0, 220)})`);
  check(/Captured/i.test(dt) && NAMES.every((n) => dt.includes(n)) && /0 \/ 5 checked in/.test(dt), 'payment captured, 5 named attendees, 0 / 5');
  await shot(p, 'c07-admin-booking');
  await p.goto(`${BASE}/admin-portal/applications`);
  const lead = p.locator(`[data-lead="${code}"]`);
  check(await until(lead) && /Volunteer/i.test(await text(lead)) && /FOH mixing/.test(await text(lead)), 'collaboration interest appears as a lead (no role granted)');
  check(sql("select role from profiles where email = 'patron@tangy.test'") === 'user', 'the customer’s role is unchanged');
  track('admin', s.errors); await s.browser.close();
}

// ================================================================ 6. named check-in with the booking's one QR
const CAM = fileURLToPath(new URL('./cam/', import.meta.url));
mkdirSync(CAM, { recursive: true });
{
  const QR = createRequire(new URL('../package.json', import.meta.url))('qrcode');
  await QR.toFile(`${CAM}checkout.png`, `TANGY:BOOKING:${sql(`select group_token from bookings where registration_code = '${code}'`)}`, { width: 480, margin: 4 });
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-loop', '1', '-i', `${CAM}checkout.png`, '-t', '4', '-r', '10',
    '-vf', 'scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2:white,format=yuv420p', `${CAM}checkout.y4m`]);
}
const inNames = () => sql(`select coalesce(string_agg(t.attendee_name, ',' order by t.ticket_number), '') from tickets t join bookings b on b.id = t.booking_id where b.registration_code = '${code}' and t.status = 'checked_in'`);
{
  const s = await launch({ mobile: true, camera: `${CAM}checkout.y4m` });
  await otpLogin(s.page, 'manager@tangy.test', `/check-in?event=${V6}`);
  const p = s.page;
  const panel = p.locator('[data-group-panel]');
  check(await until(panel), 'scanning the customer’s QR opens their attendee list');
  const names = await text(panel);
  check(NAMES.every((n) => names.includes(n)) && /5 attendees/.test(names), 'all five named attendees shown');
  for (const n of ['Rahul Sharma', 'Priya Sharma']) await panel.locator(`label[data-attendee="${n}"]`).tap();
  await p.getByRole('button', { name: 'Check in selected (2)' }).tap();
  check(await until(p.getByRole('status').getByText('Check-in successful', { exact: true })), 'Rahul and Priya checked in');
  check(inNames() === 'Rahul Sharma,Priya Sharma', 'exactly Rahul and Priya — nobody else');
  await p.getByRole('button', { name: 'Dismiss' }).tap();
  check(await until(panel) && /2 \/ 5/.test(await text(panel)), 'same QR later: 2 / 5');
  for (const n of ['Arjun Nair', 'Kavya Singh', 'Neha Verma']) await panel.locator(`label[data-attendee="${n}"]`).tap();
  await p.getByRole('button', { name: 'Check in selected (3)' }).tap();
  check(await until(p.getByRole('status').getByText('Check-in complete', { exact: true })) && inNames() === NAMES.join(','), 'later arrivals complete 5 / 5');
  await shot(p, 'c08-checkin-complete');
  track('check-in', s.errors); await s.browser.close();
}
{
  // The same QR at another event's gate.
  const s = await launch({ mobile: true, camera: `${CAM}checkout.y4m` });
  await otpLogin(s.page, 'staff@tangy.test', `/check-in?event=${V5}`);
  check(await until(s.page.getByRole('status').getByText('Wrong event', { exact: true })), 'Vol. 6 booking QR at the Vol. 5 gate: wrong event');
  track('wrong event', s.errors); await s.browser.close();
}
{
  // Customers can't check themselves in.
  const r = await attempt(customer, 'customer self check-in', () => api(customer.page, 'POST', '/rest/v1/rpc/check_in_ticket',
    { p_token: sql(`select group_token from bookings where registration_code = '${code}'`), p_event_id: V6, p_attendee_ids: [] }));
  check(r.status >= 400 && /permission/i.test(JSON.stringify(r.data)), `the customer cannot check anyone in (HTTP ${r.status})`);
}

track('customer', customer.errors);
await customer.browser.close();
console.log('\nEXPECTED REFUSALS (deliberate attacks / local-stack payment limits):\n' + (refused.join('\n') || '(none)'));
console.log('\nERRORS:\n' + (allErrors.join('\n') || '(none)'));
