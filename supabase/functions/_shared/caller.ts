// The caller's team role for Edge Functions that authorize by role
// themselves (send-ticket-email, send-approval-email). Deactivating an
// account (admin_set_user_active) only sets profiles.is_active = false — the
// person's session stays valid — so the role counts only while the profile
// is active, exactly as current_role_name() does in the database. Read fresh
// from profiles with the service client on every request; nothing the
// client sends (body, JWT metadata) is consulted. Fails closed: no profile,
// a read error, or is_active anything but true → null.
// deno-lint-ignore no-explicit-any
export async function activeRole(admin: any, userId: string): Promise<string | null> {
  const { data, error } = await admin.from('profiles').select('role, is_active').eq('id', userId).maybeSingle();
  if (error || !data || data.is_active !== true) return null;
  return data.role ?? null;
}
