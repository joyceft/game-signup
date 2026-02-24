import { createClient } from '@supabase/supabase-js'

// 🔧 Replace these with your actual values from Supabase project settings
const SUPABASE_URL = 'https://xaojtbswqrlmwmipsobl.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhhb2p0YnN3cXJsbXdtaXBzb2JsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE4OTc3MzQsImV4cCI6MjA4NzQ3MzczNH0.qHFfWacgaqB4czFpdPFFZ-baaA72Nb54rw0UnFlTHJ4'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
