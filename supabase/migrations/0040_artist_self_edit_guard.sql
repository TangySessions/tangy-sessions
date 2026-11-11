-- Tangy Sessions — artists can edit their profile, not Tangy's review record.
--
-- "artists: self update own profile" (0002) limits WHICH row an artist may
-- update (their own; the USING clause also stops them handing it to another
-- account), not WHICH columns. 0003 only guards `status`. So a signed-in
-- artist could PATCH their own row and forge reviewed_by / reviewed_at /
-- applied_at / decision_reason, change their public URL (slug) or contact
-- email without review, and — because move_review_notes() (0033) copies any
-- review_notes write into the admin-only application_reviews table — append
-- text to Tangy's internal review notes.
--
-- This trigger applies to the artist editing THEIR OWN row (auth.uid() =
-- user_id, not an admin). On UPDATE every column outside the artist-editable
-- list below must stay as it is — an allowlist, so a column added later is
-- protected until it is deliberately opened. On INSERT (applying) the
-- applicant cannot backdate applied_at or pick their own slug; 0035's
-- guard_application_start already resets status and review fields.
--
-- Unaffected: admins (is_admin(), "artists: admin full access"), the review
-- RPCs approve_/reject_artist_application (reviewers, not the artist), the
-- artist's own submit_artist_application (writes editable fields only), the
-- service role and the SQL editor (no signed-in user). RLS is unchanged.
--
-- The trigger name sorts before artists_private_notes so a review_notes write
-- is refused before that trigger copies it into application_reviews.

create or replace function guard_artist_self_edit()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  -- What an artist manages themselves: their public profile (artist portal
  -- Profile page, 0020/0033) and the self-described details collected at
  -- application (submit_artist_application).
  c_editable constant text[] := array[
    'name', 'stage_name', 'bio', 'long_bio', 'genre', 'subgenre', 'genres', 'city', 'country',
    'instagram', 'soundcloud', 'spotify', 'youtube', 'website',
    'experience_level', 'performance_type', 'years_active', 'performance_count',
    'languages', 'instruments', 'highlights', 'notable_venues', 'audience_metrics',
    'avatar_url', 'cover_url'];
  v_changed text[];
begin
  if auth.uid() is null or is_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.user_id is not distinct from auth.uid() then
      new.applied_at := now();
      new.slug := null;               -- artists_slug generates it from the stage name
    end if;
    return new;
  end if;
  if old.user_id is distinct from auth.uid() then
    return new;                       -- not a self-edit (RLS decides who else may write)
  end if;
  select array_agg(n.key order by n.key) into v_changed
  from jsonb_each(to_jsonb(new)) n
  join jsonb_each(to_jsonb(old)) o using (key)
  where n.value is distinct from o.value and not (n.key = any (c_editable));
  if v_changed is not null then
    raise exception 'These details are managed by the Tangy team and can''t be changed from your profile: %.', array_to_string(v_changed, ', ')
      using errcode = '42501', hint = 'tangy:user';
  end if;
  return new;
end;
$$;
revoke all on function guard_artist_self_edit() from public, anon, authenticated;

drop trigger if exists artists_guard_self_edit on artists;
create trigger artists_guard_self_edit before insert or update on artists
  for each row execute function guard_artist_self_edit();
