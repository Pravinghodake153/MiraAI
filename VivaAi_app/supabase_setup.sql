-- ============================================================================
-- VivaAI Supabase Database Schema & Storage Setup
-- Run this in your Supabase SQL Editor:
-- https://supabase.com/dashboard/project/vveubzrxvlklepzthuvq/sql
-- ============================================================================

-- 1. Create interviews table
CREATE TABLE IF NOT EXISTS public.interviews (
  id TEXT PRIMARY KEY,
  student_name TEXT,
  student_email TEXT,
  topic TEXT,
  score INTEGER DEFAULT 0,
  integrity_score INTEGER DEFAULT 100,
  duration TEXT,
  date TEXT,
  status TEXT DEFAULT 'Completed',
  recording_url TEXT,
  camera_recording_url TEXT,
  screen_recording_url TEXT,
  technology TEXT DEFAULT 'Python',
  difficulty TEXT DEFAULT 'Medium',
  transcripts JSONB DEFAULT '[]'::jsonb,
  scorecard JSONB DEFAULT '{}'::jsonb,
  feedback JSONB DEFAULT '{}'::jsonb,
  audio_path TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS & allow public read/write with anon key
ALTER TABLE public.interviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public access interviews" ON public.interviews;
CREATE POLICY "Public access interviews" ON public.interviews FOR ALL USING (true) WITH CHECK (true);

-- 2. Create cheating_logs table
CREATE TABLE IF NOT EXISTS public.cheating_logs (
  id TEXT PRIMARY KEY,
  student_name TEXT,
  student_email TEXT,
  session_number TEXT,
  event TEXT,
  severity TEXT,
  risk TEXT,
  details TEXT,
  time TEXT,
  timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
ALTER TABLE public.cheating_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public access cheating_logs" ON public.cheating_logs;
CREATE POLICY "Public access cheating_logs" ON public.cheating_logs FOR ALL USING (true) WITH CHECK (true);

-- 3. Create users table
CREATE TABLE IF NOT EXISTS public.users (
  id TEXT PRIMARY KEY,
  clerk_id TEXT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  avatar TEXT,
  role TEXT DEFAULT 'student',
  status TEXT DEFAULT 'Active',
  joined_date TEXT,
  last_login TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public access users" ON public.users;
CREATE POLICY "Public access users" ON public.users FOR ALL USING (true) WITH CHECK (true);

-- 4. Create topics table
CREATE TABLE IF NOT EXISTS public.topics (
  id TEXT PRIMARY KEY,
  name TEXT,
  code TEXT,
  student_count INTEGER DEFAULT 0,
  avg_score INTEGER DEFAULT 0,
  status TEXT DEFAULT 'Active'
);
ALTER TABLE public.topics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public access topics" ON public.topics;
CREATE POLICY "Public access topics" ON public.topics FOR ALL USING (true) WITH CHECK (true);

-- 5. Create feedbacks table
CREATE TABLE IF NOT EXISTS public.feedbacks (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  topic TEXT,
  rating INTEGER DEFAULT 5,
  comment TEXT,
  date TEXT
);
ALTER TABLE public.feedbacks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public access feedbacks" ON public.feedbacks;
CREATE POLICY "Public access feedbacks" ON public.feedbacks FOR ALL USING (true) WITH CHECK (true);

-- 6. Setup recordings Storage Bucket with public access
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('recordings', 'recordings', true, 104857600, ARRAY['video/webm', 'video/mp4', 'audio/webm', 'audio/wav', 'audio/mpeg', 'image/png', 'image/jpeg'])
ON CONFLICT (id) DO UPDATE SET public = true;

-- Storage RLS policies for recordings bucket
DROP POLICY IF EXISTS "Public select recordings" ON storage.objects;
DROP POLICY IF EXISTS "Public insert recordings" ON storage.objects;
DROP POLICY IF EXISTS "Public update recordings" ON storage.objects;
DROP POLICY IF EXISTS "Public delete recordings" ON storage.objects;

CREATE POLICY "Public select recordings" ON storage.objects FOR SELECT USING (bucket_id = 'recordings');
CREATE POLICY "Public insert recordings" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'recordings');
CREATE POLICY "Public update recordings" ON storage.objects FOR UPDATE USING (bucket_id = 'recordings');
CREATE POLICY "Public delete recordings" ON storage.objects FOR DELETE USING (bucket_id = 'recordings');
