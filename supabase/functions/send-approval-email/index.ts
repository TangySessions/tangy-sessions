// Sends the Tangy-branded "your application is approved" email through the
// shared provider module (_shared/email.ts — the only place email secrets
// are read; they never leave the server).
//
// Called by the client (src/services/notificationService.js) right after an
// admin's approve_collaboration / approve_crew_application /
// approve_artist_application RPC call succeeds. This function does NOT trust
// that call at face value — it re-verifies the caller is a real admin, and
// re-fetches the application + the applicant's profile email itself, so a
// forged or stale client request can't spoof a role, a name, or an email
// address. See src/lib/bookingService.js + razorpay-verify-payment for the
// same auth-client/admin-client split this function follows.
//
// Idempotency: application_notifications has a unique (source_table,
// source_id, notification_type) row per application, inserted by the
// approval RPC itself (0015_application_lifecycle.sql). This function only
// ever sends when that row's status isn't already 'sent' — re-approving, or
// re-invoking this function for the same application, cannot double-send.
// Pass `force: true` to explicitly resend (the admin "RESEND EMAIL" action).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { handleOptions, jsonResponse } from '../_shared/cors.ts';
import { sendEmail } from '../_shared/email.ts';
import { activeRole } from '../_shared/caller.ts';

const ROLE_META: Record<string, { label: string; loginPath: string }> = {
  vendor: { label: 'Vendor', loginPath: '/join/login' },
  sponsor: { label: 'Sponsor', loginPath: '/join/login' },
  venue_host: { label: 'Venue / Host', loginPath: '/join/login' },
  crew: { label: 'Crew', loginPath: '/join/login' },
  volunteer: { label: 'Volunteer', loginPath: '/join/login' },
  artist: { label: 'Artist', loginPath: '/artist/login' },
};

function emailHtml({ name, roleLabel, portalUrl }: { name: string; roleLabel: string; portalUrl: string }) {
  const safeName = name.replace(/</g, '&lt;');
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:#11100C;font-family:Georgia,'Times New Roman',serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#11100C;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" style="max-width:520px;background-color:#EDE0C0;border:4px solid #11100C;">
            <tr>
              <td style="padding:28px 32px 16px 32px;border-bottom:2px solid #11100C;">
                <p style="margin:0;font-family:Courier,monospace;font-size:11px;font-weight:bold;letter-spacing:3px;color:#8B2E00;text-transform:uppercase;">✦ TANGY SESSIONS</p>
                <h1 style="margin:6px 0 0 0;font-size:26px;color:#11100C;text-transform:uppercase;">Application Approved</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px;color:#11100C;">
                <p style="margin:0 0 14px 0;font-size:15px;">Hi ${safeName},</p>
                <p style="margin:0 0 14px 0;font-size:14px;line-height:1.6;">
                  Good news — your <strong>${roleLabel}</strong> application has been approved. Welcome to Tangy.
                </p>
                <p style="margin:0 0 22px 0;font-size:14px;line-height:1.6;">
                  Your Tangy portal is now available. Log in with the account you applied with to reach your
                  ${roleLabel} dashboard.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="background-color:#8B2E00;">
                      <a href="${portalUrl}" style="display:inline-block;padding:14px 28px;font-family:Courier,monospace;font-size:12px;font-weight:bold;letter-spacing:2px;color:#E7D5A4;text-decoration:none;text-transform:uppercase;">
                        Open Your Tangy Portal →
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:26px 0 0 0;font-size:13px;line-height:1.6;color:#4A2E1A;">
                  See you inside,<br />Tangy Sessions
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 24px 32px;border-top:1px solid rgba(17,16,12,0.2);">
                <p style="margin:0;font-family:Courier,monospace;font-size:9px;color:rgba(17,16,12,0.5);text-transform:uppercase;letter-spacing:1px;">
                  Tangy Sessions · Hyderabad
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

Deno.serve(async (req) => {
  // Answers with this request's origin when it is allowed (_shared/cors.ts).
  const json = (body: unknown, status = 200) => jsonResponse(req, body, status);
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const siteUrl = (Deno.env.get('SITE_URL') ?? 'https://tangysessions.com').replace(/\/$/, '');

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await authClient.auth.getUser();
    if (userError || !userData?.user) {
      return json({ error: 'Sign in required.' }, 401);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey);

    // Re-verify admin server-side — never trust that the caller reaching
    // this function already passed an admin check somewhere else. A
    // deactivated admin's session is still valid; their role no longer counts.
    const callerRole = await activeRole(admin, userData.user.id);
    if (callerRole === null || !['admin', 'super_admin'].includes(callerRole)) {
      return json({ error: 'Admin access required.' }, 403);
    }

    const { source_table, source_id, force } = await req.json();
    const allowedTables = ['collaborations', 'crew_applications', 'artists'];
    if (!allowedTables.includes(source_table) || !source_id) {
      return json({ error: 'Invalid request.' }, 400);
    }

    const { data: notif, error: notifError } = await admin
      .from('application_notifications')
      .select('*')
      .eq('source_table', source_table)
      .eq('source_id', source_id)
      .eq('notification_type', 'approval')
      .maybeSingle();

    if (notifError || !notif) {
      // No notification row means the approval RPC hasn't run (or this
      // application has no linked account to email) — nothing to send.
      return json({ error: 'No pending approval notification for this application.' }, 404);
    }

    if (notif.status === 'sent' && !force) {
      return json({ success: true, already_sent: true });
    }

    const { data: application, error: appError } = await admin
      .from(source_table)
      .select('*')
      .eq('id', source_id)
      .single();
    if (appError || !application) {
      return json({ error: 'Application not found.' }, 404);
    }

    const roleKey = source_table === 'artists' ? 'artist' : (source_table === 'crew_applications' ? application.category : application.type);
    const meta = ROLE_META[roleKey];
    if (!meta) {
      return json({ error: 'Unknown application role.' }, 400);
    }

    const { data: profile } = await admin
      .from('profiles')
      .select('email, full_name')
      .eq('id', application.user_id)
      .maybeSingle();

    // The applicant's AUTHENTICATED account email — never the (user-typed,
    // unverified) email column on the application row itself.
    const recipientEmail = profile?.email;
    const recipientName = profile?.full_name || application.name || application.business_name || 'there';

    if (!recipientEmail) {
      await admin.from('application_notifications').update({
        status: 'failed',
        error: 'No linked account email on file.',
      }).eq('id', notif.id);
      return json({ success: false, error: 'No linked account email on file.' });
    }

    const portalUrl = `${siteUrl}${meta.loginPath}`;
    const html = emailHtml({ name: recipientName, roleLabel: meta.label, portalUrl });
    const result = await sendEmail({
      to: recipientEmail,
      subject: `You're officially part of Tangy — ${meta.label} Application Approved`,
      html,
    });
    const sendOk = result.ok;
    const sendError = result.error ?? '';

    if (sendOk) {
      await admin.from('application_notifications').update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        error: null,
      }).eq('id', notif.id);
      return json({ success: true });
    }

    // Approval itself already succeeded and is NOT rolled back here — only
    // the notification's own status reflects the delivery failure, so an
    // admin can see it and retry without re-approving anything.
    await admin.from('application_notifications').update({
      status: 'failed',
      error: sendError || 'Unknown delivery failure.',
    }).eq('id', notif.id);
    return json({ success: false, error: sendError || 'Email delivery failed.' });
  } catch (err) {
    console.error('send-approval-email error', err);
    return json({ error: 'Unexpected server error.' }, 500);
  }
});
