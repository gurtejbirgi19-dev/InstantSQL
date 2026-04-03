const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors());
app.use(express.json());

// Simple in-memory usage tracker (resets on server restart)
// For production, replace with a database like Supabase
const usageTracker = {};

const FREE_LIMIT = 10;

function getUsageKey(ip) {
  const now = new Date();
  return `${ip}_${now.getFullYear()}_${now.getMonth()}`;
}

function getUsageCount(ip) {
  const key = getUsageKey(ip);
  return usageTracker[key] || 0;
}

function incrementUsage(ip) {
  const key = getUsageKey(ip);
  usageTracker[key] = (usageTracker[key] || 0) + 1;
}

// ── GENERATE SQL ──────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const { prompt, dbType, tableContext, isPro } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  // Check usage limit for free users
  if (!isPro) {
    const usage = getUsageCount(ip);
    if (usage >= FREE_LIMIT) {
      return res.status(429).json({
        error: 'Free limit reached',
        message: 'You have used all 10 free queries this month. Upgrade to Pro for unlimited queries.',
        upgradeRequired: true
      });
    }
  }

  const systemPrompt = `You are QueryCraft, an expert SQL generator. Generate precise, production-ready SQL queries.

Always respond in this exact JSON format (no markdown, no backticks):
{"sql": "THE_SQL_QUERY_HERE", "explanation": "Brief plain-English explanation of what the query does and how it works (2-3 sentences max)"}

Rules:
- Use proper ${dbType || 'MySQL'} syntax
- Write clean, readable SQL with proper indentation
- Add helpful inline comments for complex parts
- The SQL should be immediately runnable`;

  const userMessage = `Database: ${dbType || 'MySQL'}
${tableContext ? `Tables/Context: ${tableContext}` : ''}
Request: ${prompt}

Generate the SQL query.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`);
    }

    const data = await response.json();
    const raw = data.content?.[0]?.text || '';

    let sql = '', explanation = '';
    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);
      sql = parsed.sql || '';
      explanation = parsed.explanation || '';
    } catch {
      sql = raw;
    }

    // Increment usage for free users
    if (!isPro) incrementUsage(ip);

    // Return remaining queries for free users
    const remaining = isPro ? null : FREE_LIMIT - getUsageCount(ip);

    res.json({ sql, explanation, remaining });

  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: 'Failed to generate SQL. Please try again.' });
  }
});

// ── USAGE CHECK ───────────────────────────────────────────────
app.get('/api/usage', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const used = getUsageCount(ip);
  const remaining = Math.max(0, FREE_LIMIT - used);
  res.json({ used, remaining, limit: FREE_LIMIT });
});

// ── STRIPE CHECKOUT ───────────────────────────────────────────
app.post('/api/create-checkout', async (req, res) => {
  const { plan } = req.body; // 'pro' or 'team'

  const prices = {
    pro: { amount: 1900, name: 'QueryCraft Pro', description: 'Unlimited SQL queries per month' },
    team: { amount: 4900, name: 'QueryCraft Team', description: 'Up to 5 seats, API access' }
  };

  const selected = prices[plan] || prices.pro;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: selected.name,
            description: selected.description,
          },
          unit_amount: selected.amount,
          recurring: { interval: 'month' }
        },
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}?success=true`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}?canceled=true`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'QueryCraft API' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`QueryCraft backend running on port ${PORT}`);
});
