// ═══════════════════════════════════════════════════════
// VIRAL STUDIO — AI PROXY FUNCTION
// File: netlify/functions/ai.js
//
// This function sits between your app and Anthropic.
// Your API key never reaches the user's browser.
// ═══════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

// ── Environment variables (set in Netlify dashboard) ──
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY; // service role key
const FREE_DAILY_LIMIT = 5;

exports.handler = async (event) => {

  // ── CORS headers ──────────────────────────────────────
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { system, message, userToken, model } = body;

    if (!system || !message) {
      return {
        statusCode: 400, headers,
        body: JSON.stringify({ error: 'Missing system or message' })
      };
    }

    // ── SUBSCRIPTION CHECK ────────────────────────────────
    let isPro = false;
    let userId = null;

    if (userToken && SUPABASE_URL && SUPABASE_KEY) {
      try {
        const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
        // Verify the user's JWT token
        const { data: { user }, error } = await supabase.auth.getUser(userToken);
        if (!error && user) {
          userId = user.id;
          // Check subscription in your subscriptions table
          const { data: sub } = await supabase
            .from('subscriptions')
            .select('status, expires_at')
            .eq('user_id', userId)
            .single();
          if (sub && sub.status === 'active') {
            if (!sub.expires_at || new Date(sub.expires_at) > new Date()) {
              isPro = true;
            }
          }
          // Also check user metadata (for code-activated Pro)
          if (!isPro && user.user_metadata?.isPro) {
            isPro = true;
          }
        }
      } catch (authErr) {
        console.warn('Auth check failed:', authErr.message);
        // Continue — let rate limiting handle it
      }
    }

    // ── RATE LIMITING FOR FREE USERS ─────────────────────
    if (!isPro) {
      if (userId && SUPABASE_URL && SUPABASE_KEY) {
        const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
        const today = new Date().toISOString().slice(0, 10);
        // Check usage table
        const { data: usage } = await supabase
          .from('daily_usage')
          .select('count')
          .eq('user_id', userId)
          .eq('date', today)
          .single();

        const currentCount = usage?.count || 0;
        if (currentCount >= FREE_DAILY_LIMIT) {
          return {
            statusCode: 429, headers,
            body: JSON.stringify({
              error: 'daily_limit_reached',
              message: 'You have used all ' + FREE_DAILY_LIMIT + ' free AI generations today. Upgrade to Pro for unlimited access.',
              upgradeRequired: true,
              limit: FREE_DAILY_LIMIT,
              used: currentCount
            })
          };
        }

        // Increment usage counter
        if (usage) {
          await supabase
            .from('daily_usage')
            .update({ count: currentCount + 1 })
            .eq('user_id', userId)
            .eq('date', today);
        } else {
          await supabase
            .from('daily_usage')
            .insert({ user_id: userId, date: today, count: 1 });
        }
      }
    }

    // ── CALL ANTHROPIC ────────────────────────────────────
    if (!ANTHROPIC_KEY) {
      return {
        statusCode: 500, headers,
        body: JSON.stringify({ error: 'API key not configured on server' })
      };
    }

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system,
        messages: [{ role: 'user', content: message }]
      })
    });

    const anthropicData = await anthropicRes.json();

    if (anthropicData.error) {
      return {
        statusCode: 500, headers,
        body: JSON.stringify({ error: anthropicData.error.message })
      };
    }

    const text = (anthropicData.content || []).map(b => b.text || '').join('');

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        text,
        isPro,
        usage: anthropicData.usage
      })
    };

  } catch (err) {
    console.error('AI function error:', err);
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: 'Server error: ' + err.message })
    };
  }
};
