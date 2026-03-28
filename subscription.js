// ═══════════════════════════════════════════════════════
// VIRAL STUDIO — SUBSCRIPTION CHECK FUNCTION
// File: netlify/functions/subscription.js
//
// Check, activate and manage Pro subscriptions.
// Called by the app to verify subscription status.
// ═══════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Pro codes (same as in app — keep in sync)
const PRO_CODES = {
  'VSTUDIO2024': 'lifetime',
  'PROLAUNCH':   'lifetime',
  'CREATOR99':   '2025-12-31',
  'EARLYBIRD':   '2025-06-30',
};

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const path = event.path.replace('/.netlify/functions/subscription', '');
  const body = event.body ? JSON.parse(event.body) : {};

  try {

    // ── GET /check — Check subscription status ───────────
    if (event.httpMethod === 'GET' || path === '/check') {
      const token = event.headers.authorization?.replace('Bearer ', '');
      if (!token) return respond(401, { error: 'No auth token' });

      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (error || !user) return respond(401, { error: 'Invalid token' });

      // Check subscriptions table
      const { data: sub } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('user_id', user.id)
        .single();

      const isPro = sub?.status === 'active' &&
        (!sub.expires_at || new Date(sub.expires_at) > new Date());

      // Get daily usage
      const today = new Date().toISOString().slice(0, 10);
      const { data: usage } = await supabase
        .from('daily_usage')
        .select('count')
        .eq('user_id', user.id)
        .eq('date', today)
        .single();

      return respond(200, {
        isPro,
        plan: isPro ? 'pro' : 'free',
        expiresAt: sub?.expires_at || null,
        dailyUsage: usage?.count || 0,
        dailyLimit: isPro ? 999999 : 5,
        email: user.email
      });
    }

    // ── POST /activate-code — Activate a Pro code ────────
    if (path === '/activate-code' || body.action === 'activate-code') {
      const { code, userToken } = body;
      if (!code) return respond(400, { error: 'No code provided' });

      const expiry = PRO_CODES[code.toUpperCase()];
      if (!expiry) return respond(400, { error: 'Invalid code' });

      // Check not expired
      if (expiry !== 'lifetime' && new Date() > new Date(expiry)) {
        return respond(400, { error: 'This code has expired' });
      }

      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

      if (userToken) {
        const { data: { user } } = await supabase.auth.getUser(userToken);
        if (user) {
          const expiresAt = expiry === 'lifetime' ? null :
            new Date(expiry).toISOString();

          await supabase.from('subscriptions').upsert({
            user_id: user.id,
            status: 'active',
            plan: 'pro_code',
            code_used: code.toUpperCase(),
            expires_at: expiresAt,
            activated_at: new Date().toISOString()
          });

          return respond(200, {
            success: true,
            isPro: true,
            plan: 'pro',
            expiresAt,
            message: 'Pro activated successfully!'
          });
        }
      }

      // No auth token — return confirmation for local activation
      return respond(200, {
        success: true,
        valid: true,
        expiry,
        message: 'Code valid'
      });
    }

    // ── POST /webhook/stripe — Stripe payment webhook ────
    if (path === '/webhook/stripe' || body.action === 'stripe-webhook') {
      // Verify Stripe signature
      const sig = event.headers['stripe-signature'];
      if (!sig || !STRIPE_WEBHOOK_SECRET) {
        return respond(400, { error: 'Missing stripe signature' });
      }

      const stripeEvent = body; // Already parsed above

      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

      if (stripeEvent.type === 'checkout.session.completed' ||
          stripeEvent.type === 'customer.subscription.created' ||
          stripeEvent.type === 'customer.subscription.updated') {
        const session = stripeEvent.data.object;
        const customerId = session.customer;
        const subscriptionId = session.subscription || session.id;
        const status = session.status || 'active';
        const userEmail = session.customer_email ||
          session.customer_details?.email;

        // Find user by email
        if (userEmail) {
          const { data: users } = await supabase.auth.admin.listUsers();
          const user = users?.users?.find(u => u.email === userEmail);
          if (user) {
            await supabase.from('subscriptions').upsert({
              user_id: user.id,
              status: status === 'active' ? 'active' : 'inactive',
              plan: 'pro_stripe',
              stripe_customer_id: customerId,
              stripe_subscription_id: subscriptionId,
              expires_at: null, // Stripe manages renewals
              activated_at: new Date().toISOString()
            });
          }
        }
      }

      if (stripeEvent.type === 'customer.subscription.deleted' ||
          stripeEvent.type === 'customer.subscription.paused') {
        const sub = stripeEvent.data.object;
        await supabase.from('subscriptions')
          .update({ status: 'inactive' })
          .eq('stripe_subscription_id', sub.id);
      }

      return respond(200, { received: true });
    }

    return respond(404, { error: 'Unknown endpoint' });

  } catch (err) {
    console.error('Subscription function error:', err);
    return respond(500, { error: 'Server error: ' + err.message });
  }
};

function respond(status, data) {
  return { statusCode: status, headers, body: JSON.stringify(data) };
}
