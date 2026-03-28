-- ═══════════════════════════════════════════════════════
-- VIRAL STUDIO — SUPABASE DATABASE SETUP
-- Run this SQL in your Supabase SQL Editor
-- ═══════════════════════════════════════════════════════

-- 1. App data table (already created if you set up cloud sync)
CREATE TABLE IF NOT EXISTS viral_studio_data (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES auth.users ON DELETE CASCADE,
  data JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE viral_studio_data ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own data" ON viral_studio_data
  USING (auth.uid()::text = id)
  WITH CHECK (auth.uid()::text = id);

-- 2. Subscriptions table
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users ON DELETE CASCADE UNIQUE,
  status TEXT NOT NULL DEFAULT 'inactive', -- 'active' | 'inactive' | 'cancelled'
  plan TEXT NOT NULL DEFAULT 'free',       -- 'free' | 'pro_code' | 'pro_stripe'
  code_used TEXT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  expires_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
-- Users can read their own subscription
CREATE POLICY "Users read own subscription" ON subscriptions
  FOR SELECT USING (auth.uid() = user_id);
-- Only service role can write (your backend)
CREATE POLICY "Service role manages subscriptions" ON subscriptions
  FOR ALL USING (auth.role() = 'service_role');

-- 3. Daily usage tracking table
CREATE TABLE IF NOT EXISTS daily_usage (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users ON DELETE CASCADE,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, date)
);
ALTER TABLE daily_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own usage" ON daily_usage
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Service role manages usage" ON daily_usage
  FOR ALL USING (auth.role() = 'service_role');

-- 4. Helpful view: subscription status with user email
CREATE OR REPLACE VIEW subscription_status AS
SELECT
  u.email,
  u.id as user_id,
  s.status,
  s.plan,
  s.expires_at,
  s.activated_at,
  CASE
    WHEN s.status = 'active' AND (s.expires_at IS NULL OR s.expires_at > NOW()) THEN true
    ELSE false
  END as is_pro
FROM auth.users u
LEFT JOIN subscriptions s ON u.id = s.user_id
ORDER BY s.activated_at DESC;

-- 5. Function to auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER subscriptions_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ═══════════════════════════════════════════════════════
-- DONE. Your database is ready.
-- ═══════════════════════════════════════════════════════
