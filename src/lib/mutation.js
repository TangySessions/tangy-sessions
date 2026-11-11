import { friendlyError } from '../admin/api';

// Runs a Supabase update/delete that must change at least one row, and says
// in words a person can act on whether it did. An update that RLS (or a
// guard) filters out returns no error and no rows — that is a refusal, never
// a success. Raw database errors go to the console only.
export const NOT_CHANGED = "That change wasn't saved — you may not have access to it any more, or it was changed elsewhere. Refresh and try again.";

export async function changeRows(query, label = 'update') {
  try {
    const { data, error } = await query.select('id');
    if (error) {
      console.error(`[tangy] ${label} failed`, error);
      return { ok: false, message: friendlyError(error).message };
    }
    if (!data || data.length === 0) return { ok: false, message: NOT_CHANGED };
    return { ok: true, rows: data };
  } catch (err) {
    console.error(`[tangy] ${label} failed`, err);
    return { ok: false, message: 'Network error — check your connection and try again.' };
  }
}

// A list load that failed, in safe words (for "couldn't load" banners).
export const loadFailed = (error) => (error ? friendlyError(error).message : null);
