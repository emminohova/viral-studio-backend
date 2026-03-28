const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;

const PRO_CODES = {
  'VSTUDIO2024': 'lifetime',
  'PROLAUNCH':   'lifetime',
  'CREATOR99':   '2025-12-31'
};

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const path = event.path.replace('/.netlify/functions/subscription', '');
  const body = event.body ? JSON.parse(event.body) : {};

  try {

    if (event.httpMethod === 'GET' || path === '/check') {
      const token = event.headers.authorization?.replace('Bearer ', '');
      if (!token) return respond(401, { error: 'No token' });

      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
      const { data: { user } } = await supabase.auth.getUser(token);

      const { data: sub } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('user_id', user.id)
        .single();

      const isPro = sub?.status === 'active';

      return respond(200, { isPro });
    }

    if (path === '/activate-code') {
      const { code, userToken } = body;

      const expiry = PRO_CODES[code?.toUpperCase()];
      if (!expiry) return respond(400, { error: 'Invalid code' });

      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

      const { data: { user } } = await supabase.auth.getUser(userToken);

      await supabase.from('subscriptions').upsert({
        user_id: user.id,
        status: 'active',
        plan: 'pro_code',
        code_used: code.toUpperCase()
      });

      return respond(200, { success: true });
    }

    return respond(404, { error: 'Not found' });

  } catch (err) {
    return respond(500, { error: err.message });
  }
};

function respond(status, data) {
  return { statusCode: status, headers, body: JSON.stringify(data) };
}
