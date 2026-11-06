import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

/** Supabase, used for sign-in only: every project and recording request goes to our own server. Null when unconfigured. */
export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null;

export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:8787').replace(/\/$/, '');
