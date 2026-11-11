-- Tangy Sessions — the public artist directory is read-only for the API roles.
--
-- public_artists (0020/0028/0033/0042) is a simple view over artists, so
-- PostgreSQL makes it automatically updatable. Supabase's default privileges
-- gave anon and authenticated ALL privileges on it (only SELECT was ever
-- granted on purpose), and the view runs with its owner's rights — the owner
-- of artists, to whom the artists RLS policies do not apply. So anyone with
-- the public API key could PATCH or DELETE an approved artist's row through
-- /rest/v1/public_artists, bypassing every artists policy and the 0040 guard.
-- (INSERT failed only because artists.email is NOT NULL and not in the view.)
--
-- Now anon and authenticated keep SELECT and lose every write privilege on
-- the view: INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER. A
-- table-level REVOKE also removes the matching column-level privileges.
--
-- Unchanged: the view definition and columns, SELECT for anon and
-- authenticated, service_role and the owner (all privileges, as before), the
-- artists table and its RLS policies, every other object and grant. Nobody
-- writes through this view: the site only reads it; artists edit their own
-- row on artists (RLS + 0040), admins and the review RPCs use artists too.
-- No data is changed.
--
-- The REVOKE removes only grants made by the view's owner (Supabase's
-- default privileges). A write privilege granted by another role, or to
-- PUBLIC, would survive it, so the result is checked in the same
-- transaction: if anon or authenticated could still write — or lost SELECT —
-- the migration stops and changes nothing. Run
-- supabase/preflight/0045_public_artists_read_only_preflight.sql first.
-- Running it again is harmless (REVOKE of a privilege not held is a no-op).

begin;

do $$
begin
  if to_regclass('public.public_artists') is null then
    raise exception 'STOP: 0045 expects the public_artists view (0020/0033/0042).';
  end if;
end $$;

revoke insert, update, delete, truncate, references, trigger on public_artists from anon, authenticated;

do $$
declare
  v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    if not has_table_privilege(v_role, 'public.public_artists', 'SELECT') then
      raise exception 'STOP: % would lose SELECT on public_artists. Nothing was changed.', v_role;
    end if;
    if has_any_column_privilege(v_role, 'public.public_artists', 'INSERT')
       or has_any_column_privilege(v_role, 'public.public_artists', 'UPDATE')
       or has_any_column_privilege(v_role, 'public.public_artists', 'REFERENCES')
       or has_table_privilege(v_role, 'public.public_artists', 'DELETE')
       or has_table_privilege(v_role, 'public.public_artists', 'TRUNCATE')
       or has_table_privilege(v_role, 'public.public_artists', 'TRIGGER') then
      raise exception 'STOP: % can still write to public_artists (a grant made by another role or to PUBLIC). Nothing was changed. See the 0045 preflight.', v_role;
    end if;
  end loop;
end $$;

commit;
