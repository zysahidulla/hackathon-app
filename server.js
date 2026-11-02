require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { explainRisk } = require('./ai');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const BASE = 'https://api-m.sandbox.paypal.com';

// ---------- PayPal helpers ----------
let cached = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (cached.token && Date.now() < cached.expiresAt) return cached.token;

  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64');

  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Auth failed: ${JSON.stringify(data)}`);

  cached = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return cached.token;
}

async function createPayPalOrder(amount) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          description: 'Hackathon test order',
          amount: { currency_code: 'USD', value: amount.toFixed(2) },
        },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Create order failed: ${JSON.stringify(data)}`);
  return data; // contains id, status, links
}

// ---------- Fake order history (simulated past transactions) ----------
const DAY = 24 * 60 * 60 * 1000;
const orders = [
  { id: 'seed-1', amount: 25, buyerCountry: 'PH', shipCountry: 'PH', createdAt: Date.now() - 5 * DAY },
  { id: 'seed-2', amount: 40, buyerCountry: 'PH', shipCountry: 'PH', createdAt: Date.now() - 4 * DAY },
  { id: 'seed-3', amount: 30, buyerCountry: 'PH', shipCountry: 'PH', createdAt: Date.now() - 2 * DAY },
  { id: 'seed-4', amount: 35, buyerCountry: 'SG', shipCountry: 'SG', createdAt: Date.now() - 1 * DAY },
];

// ---------- Risk scoring ----------
function scoreRisk({ amount, buyerCountry, shipCountry }) {
  const reasons = [];
  let score = 0;

  // Learn "normal" behavior only from seed history and orders the seller approved
  const trusted = orders.filter(o => !o.risk || o.status === 'approved');

  const knownCountries = new Set(trusted.map(o => o.buyerCountry));
  if (!knownCountries.has(buyerCountry)) {
    score += 40;
    reasons.push(`First order ever from ${buyerCountry}`);
  }

  const amounts = trusted.map(o => o.amount).sort((a, b) => a - b);
  const mid = Math.floor(amounts.length / 2);
  const typical = amounts.length % 2
    ? amounts[mid]
    : (amounts[mid - 1] + amounts[mid]) / 2;
  if (amount > typical * 3) {
    score += 30;
    reasons.push(`Amount $${amount} is over 3x the typical order ($${typical.toFixed(2)})`);
  }

  if (buyerCountry !== shipCountry) {
    score += 20;
    reasons.push(`Buyer country (${buyerCountry}) differs from shipping country (${shipCountry})`);
  }

  const recent = orders.filter(o => Date.now() - o.createdAt < 10 * 60 * 1000).length;
  if (recent >= 3) {
    score += 20;
    reasons.push(`${recent} orders in the last 10 minutes`);
  }

  score = Math.min(score, 100);
  const level = score >= 60 ? 'HIGH' : score >= 30 ? 'MEDIUM' : 'LOW';
  return { score, level, reasons };
}

// ---------- Routes ----------
app.get('/api/orders', (req, res) => {
  res.json([...orders].sort((a, b) => b.createdAt - a.createdAt));
});

app.post('/api/orders', async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const buyerCountry = String(req.body.buyerCountry || '').toUpperCase().slice(0, 2);
    const shipCountry = String(req.body.shipCountry || '').toUpperCase().slice(0, 2);

    if (!(amount > 0) || !buyerCountry || !shipCountry) {
      return res.status(400).json({ error: 'amount, buyerCountry, shipCountry are required' });
    }

    // Score BEFORE adding this order, so it's compared against past history
    const risk = scoreRisk({ amount, buyerCountry, shipCountry });
    risk.aiSummary = await explainRisk({ amount, buyerCountry, shipCountry }, risk);

    const paypal = await createPayPalOrder(amount);

    const order = {
      id: paypal.id,
      paypalStatus: paypal.status,
      amount,
      buyerCountry,
      shipCountry,
      createdAt: Date.now(),
      status: 'pending', // pending | approved | held
      risk,
    };
    orders.push(order);
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Seller decision: approve or hold an order
app.post('/api/orders/:id/decision', (req, res) => {
  const decision = req.body.decision;
  if (!['approved', 'held'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "approved" or "held"' });
  }

  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!order.risk) return res.status(400).json({ error: 'Historical orders cannot be changed' });

  order.status = decision;
  order.decidedAt = Date.now();
  res.json(order);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on http://localhost:${PORT} (AI step enabled)`));