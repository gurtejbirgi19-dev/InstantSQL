const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.options('*', cors());
app.use(express.json());

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

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'InstantSQL API' });
});

app.get('/api/usage', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const used = getUsageCount(ip);
  const remaining = Math.max(0, FREE_LIMIT - used);
  res.json({ used, remaining, limit: FREE_LIMIT });
});

app.post('/api/generate', async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const { prompt, dbType, tableContext } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    const usage = getUsageCount(ip);
    if (usage >= FREE_LIMIT) {
      return res.status(429).json({
        error: 'Free limit reached',
        message: 'You have used all 10 free queries this month.',
        upgradeRequired: true
      });
    }

    const systemPrompt = `You are InstantSQL, an expert SQL generator. Always respond in this exact JSON format with no markdown or backticks: {"sql": "THE_SQL_HERE", "explanation": "Brief plain English explanation of what the query does"}. Use proper ${dbType || 'MySQL'} syntax. Write clean readable SQL.`;

    const userMessage = `Database: ${dbType || 'MySQL'}\n${tableContext ? `Tables: ${tableContext}\n` : ''}Request: ${prompt}`;

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
      const err = await response.text();
      console.error('Anthropic error:', err);
      return res.status(500).json({ error: 'AI service error. Please try again.' });
    }

    const data = await response.json();
    const raw = data.content?.[0]?.text || '';

    let sql = '', explanation = '';
    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);
      sql = parsed.sql || raw;
      explanation = parsed.explanation || '';
    } catch {
      sql = raw;
    }

    incrementUsage(ip);
    const remaining = FREE_LIMIT - getUsageCount(ip);
    res.json({ sql, explanation, remaining });

  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

app.post('/api/create-checkout', async (req, res) => {
  try {
    const Stripe = require('stripe');
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const { plan } = req.body;
    const prices = {
      starter: { amount: 900, name: 'InstantSQL Starter', description: '100 queries/month' },
      pro: { amount: 1900, name: 'InstantSQL Pro', description: 'Unlimited queries' },
      team: { amount: 4900, name: 'InstantSQL Team', description: '5 seats unlimited' }
    };
    const selected = prices[plan] || prices.pro;
    const frontendUrl = process.env.FRONTEND_URL || 'https://project-l2lme.vercel.app';
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency: 'usd', product_data: { name: selected.name, description: selected.description }, unit_amount: selected.amount, recurring: { interval: 'month' } }, quantity: 1 }],
      mode: 'subscription',
      success_url: `${frontendUrl}?success=true`,
      cancel_url: `${frontendUrl}?canceled=true`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: 'Payment error.' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`InstantSQL backend running on port ${PORT}`);
});
