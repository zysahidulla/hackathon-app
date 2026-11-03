require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { explainRisk } = require('./ai');
const { buildEvidencePacket } = require('./evidence');
const { buildMockContext } = require('./data/mockContext');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

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
      // Gives us a buyer-approval link and sends the buyer back to the dashboard afterward
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'Seller Shield (sandbox)',
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            return_url: `${APP_URL}/`,
            cancel_url: `${APP_URL}/`,
          },
        },
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Create order failed: ${JSON.stringify(data)}`);
  return data; // contains id, status, links
}

async function capturePayPalOrder(orderId) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': crypto.randomUUID(),
    },
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

async function listPayPalDisputes() {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}/v1/customer/disputes?page_size=50`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`List disputes failed: ${JSON.stringify(data)}`);
  return data.items || [];
}

// Full details (the list above leaves out fields like the buyer's messages)
async function getPayPalDispute(disputeId) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}/v1/customer/disputes/${disputeId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Get dispute failed: ${JSON.stringify(data)}`);
  return data;
}

// Tries to capture and records the outcome on the order (never throws)
async function tryCapture(order) {
  try {
    const { ok, data } = await capturePayPalOrder(order.id);

    if (ok) {
      order.paypalStatus = data.status; // COMPLETED, or PENDING if the account holds payments for review
      order.captureId = data.purchase_units?.[0]?.payments?.captures?.[0]?.id;
      order.captureMessage =
        data.status === 'COMPLETED' ? null : `Capture status: ${data.status}`;
      return;
    }

    const issue = data.details?.[0]?.issue;
    if (issue === 'ORDER_NOT_APPROVED') {
      order.captureMessage = 'Waiting for the buyer to approve this payment on PayPal.';
    } else if (issue === 'ORDER_ALREADY_CAPTURED') {
      order.paypalStatus = 'COMPLETED';
      order.captureMessage = null;
    } else {
      order.captureMessage = `Capture failed: ${issue || data.message || 'unknown error'}`;
      console.error('Capture error:', JSON.stringify(data));
    }
  } catch (err) {
    order.captureMessage = `Capture failed: ${err.message}`;
    console.error('Capture error:', err);
  }
}

// ---------- Fake order history (simulated past transactions) ----------
const DAY = 24 * 60 * 60 * 1000;
const orders = [
  { id: 'seed-1', amount: 25, buyerCountry: 'PH', shipCountry: 'PH', createdAt: Date.now() - 5 * DAY },
  { id: 'seed-2', amount: 40, buyerCountry: 'PH', shipCountry: 'PH', createdAt: Date.now() - 4 * DAY },
  { id: 'seed-3', amount: 30, buyerCountry: 'PH', shipCountry: 'PH', createdAt: Date.now() - 2 * DAY },
  { id: 'seed-4', amount: 35, buyerCountry: 'SG', shipCountry: 'SG', createdAt: Date.now() - 1 * DAY },
];

// ---------- Save orders to disk so a restart does not lose them ----------
const ORDERS_FILE = path.join(__dirname, 'data', 'orders.json');

function saveOrders() {
  try {
    fs.mkdirSync(path.dirname(ORDERS_FILE), { recursive: true });
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders.filter(o => o.risk), null, 2));
  } catch (err) {
    console.error('Could not save orders:', err.message);
  }
}

try {
  orders.push(...JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')));
} catch { /* no saved orders yet */ }

// ---------- Distance helper (approximate country-center coordinates) ----------
const COUNTRY_COORDS = {
  PH: [12.9, 121.8], SG: [1.35, 103.8], MY: [4.2, 101.9], ID: [-0.8, 113.9],
  TH: [15.9, 101.0], VN: [14.1, 108.3], JP: [36.2, 138.3], KR: [35.9, 127.8],
  CN: [35.9, 104.2], HK: [22.3, 114.2], TW: [23.7, 121.0], IN: [20.6, 79.0],
  PK: [30.4, 69.3], BD: [23.7, 90.4], AU: [-25.3, 133.8], NZ: [-40.9, 174.9],
  US: [37.1, -95.7], CA: [56.1, -106.3], MX: [23.6, -102.6], BR: [-14.2, -51.9],
  GB: [55.4, -3.4], DE: [51.2, 10.5], FR: [46.2, 2.2], ES: [40.5, -3.7],
  IT: [41.9, 12.6], NL: [52.1, 5.3], RU: [61.5, 105.3], TR: [39.0, 35.2],
  AE: [23.4, 53.8], SA: [23.9, 45.1], EG: [26.8, 30.8], NG: [9.1, 8.7],
  GH: [7.9, -1.0], KE: [0.0, 37.9], ZA: [-30.6, 22.9],
};

function distanceKm([lat1, lon1], [lat2, lon2]) {
  const R = 6371;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- Risk scoring ----------
function scoreRisk({ amount, buyerCountry, shipCountry }) {
  const reasons = [];
  let score = 0;

  // Learn "normal" behavior only from seed history and orders the seller approved
  const trusted = orders.filter(o => !o.risk || o.status === 'approved');

  // Signal 1: new buyer country
  const knownCountries = new Set(trusted.map(o => o.buyerCountry));
  const isNewCountry = !knownCountries.has(buyerCountry);
  if (isNewCountry) {
    score += 40;
    reasons.push(`First order ever from ${buyerCountry}`);
  }

  // Signal 2: distance from where this seller usually gets orders
  if (isNewCountry && COUNTRY_COORDS[buyerCountry]) {
    const distances = [...knownCountries]
      .filter(c => COUNTRY_COORDS[c])
      .map(c => distanceKm(COUNTRY_COORDS[buyerCountry], COUNTRY_COORDS[c]));
    if (distances.length) {
      const nearest = Math.min(...distances);
      if (nearest > 3000) {
        score += 15;
        reasons.push(
          `Buyer country is about ${(Math.round(nearest / 100) * 100).toLocaleString('en-US')} km from the closest place this seller usually gets orders`
        );
      }
    }
  }

  // Signal 3: amount far above the typical order (median resists being skewed by one big order)
  const amounts = trusted.map(o => o.amount).sort((a, b) => a - b);
  const mid = Math.floor(amounts.length / 2);
  const typical = amounts.length % 2
    ? amounts[mid]
    : (amounts[mid - 1] + amounts[mid]) / 2;
  const isLargeAmount = amount > typical * 3;
  if (isLargeAmount) {
    score += 30;
    reasons.push(`Amount $${amount} is over 3x the typical order ($${typical.toFixed(2)})`);
  }

  // Signal 4: new buyer country combined with a large order
  if (isNewCountry && isLargeAmount) {
    score += 10;
    reasons.push('A new buyer country combined with a large order');
  }

  // Signal 5: buyer and shipping country differ
  if (buyerCountry !== shipCountry) {
    score += 20;
    reasons.push(`Buyer country (${buyerCountry}) differs from shipping country (${shipCountry})`);
  }

  // Signal 6: burst of orders
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
    const approveUrl = (paypal.links || []).find(
      l => l.rel === 'payer-action' || l.rel === 'approve'
    )?.href;

    const order = {
      id: paypal.id,
      paypalStatus: paypal.status,
      approveUrl,
      amount,
      buyerCountry,
      shipCountry,
      createdAt: Date.now(),
      status: 'pending', // pending | approved | held
      risk,
    };
    orders.push(order);
    saveOrders();
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Seller decision: approve (and try to capture payment) or hold
app.post('/api/orders/:id/decision', async (req, res) => {
  const decision = req.body.decision;
  if (!['approved', 'held'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "approved" or "held"' });
  }

  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!order.risk) return res.status(400).json({ error: 'Historical orders cannot be changed' });
  if (decision === 'held' && order.paypalStatus === 'COMPLETED') {
    return res.status(400).json({ error: 'Payment already captured; a refund would be needed' });
  }

  order.status = decision;
  order.decidedAt = Date.now();

  if (decision === 'approved' && order.paypalStatus !== 'COMPLETED') {
    await tryCapture(order);
  }
  saveOrders();
  res.json(order);
});

// Retry capture (after the buyer has approved on PayPal)
app.post('/api/orders/:id/capture', async (req, res) => {
  const order = orders.find(o => o.id === req.params.id);
  if (!order || !order.risk) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'approved') {
    return res.status(400).json({ error: 'Approve the order before capturing payment' });
  }
  if (order.paypalStatus !== 'COMPLETED') await tryCapture(order);
  saveOrders();
  res.json(order);
});

// Disputes from PayPal, each matched to its Seller Shield order by capture ID
app.get('/api/disputes', async (req, res) => {
  try {
    const list = await listPayPalDisputes();
    const disputes = await Promise.all(list.map(d => getPayPalDispute(d.dispute_id)));

    const withOrders = disputes.map(d => {
      const captureId = d.disputed_transactions?.[0]?.seller_transaction_id;
      const order = orders.find(o => o.captureId && o.captureId === captureId) || null;
      return { ...d, order };
    });
    res.json(withOrders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Dispute evidence and response ----------
const DISPUTE_ID = /^[A-Za-z0-9-]{3,64}$/;

function orderForDispute(d) {
  const captureId = d.disputed_transactions?.[0]?.seller_transaction_id;
  return orders.find(o => o.captureId && o.captureId === captureId) || null;
}

async function paypalPost(path, { json, form } = {}) {
  const token = await getAccessToken();
  const headers = { Authorization: `Bearer ${token}` };
  let body;
  if (json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    body = form; // fetch adds the multipart boundary itself
  }
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON reply */ }
  return { ok: res.ok, data };
}

// provide-evidence needs multipart/form-data with the "input" part labeled as JSON
async function paypalProvideEvidence(disputeId, input) {
  const token = await getAccessToken();
  const boundary = '----SellerShield' + crypto.randomBytes(12).toString('hex');
  const body =
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="input"\r\n' +
    'Content-Type: application/json\r\n\r\n' +
    JSON.stringify(input) + '\r\n' +
    `--${boundary}--\r\n`;

  const res = await fetch(`${BASE}/v1/customer/disputes/${disputeId}/provide-evidence`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON reply */ }
  return { ok: res.ok, data };
}

function paypalErrorText(data) {
  return data.details?.[0]?.description || data.details?.[0]?.issue || data.message || 'PayPal rejected the request.';
}

// Build the evidence packet for one dispute
app.post('/api/disputes/:id/evidence', async (req, res) => {
  const id = req.params.id;
  if (!DISPUTE_ID.test(id)) return res.status(400).json({ error: 'Invalid dispute ID.' });
  try {
    const dispute = await getPayPalDispute(id);
    const packet = await buildEvidencePacket(dispute, orderForDispute(dispute));
    res.json(packet);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

// Send the seller's reply to PayPal. The endpoint depends on the dispute stage.
// Send the seller's response to PayPal. If PayPal asked for evidence, send evidence; otherwise send a message.
// Send the seller's response to PayPal: evidence if PayPal asked for it and we have shipping data, otherwise a message
app.post('/api/disputes/:id/submit', async (req, res) => {
  const id = req.params.id;
  const reply = String(req.body?.reply || '').trim();
  if (!DISPUTE_ID.test(id)) return res.status(400).json({ error: 'Invalid dispute ID.' });
  if (!reply) return res.status(400).json({ error: 'Write a reply before submitting.' });
  if (reply.length > 2000) return res.status(400).json({ error: 'The reply is too long. Keep it under 2,000 characters.' });

  try {
    const dispute = await getPayPalDispute(id);

    const actionable =
      dispute.status === 'WAITING_FOR_SELLER_RESPONSE' ||
      (dispute.dispute_life_cycle_stage === 'INQUIRY' &&
        ['OPEN', 'WAITING_FOR_BUYER_RESPONSE'].includes(dispute.status));
    if (!actionable) {
      return res.status(400).json({ error: 'This dispute is not waiting for your response.' });
    }

    const canProvideEvidence = (dispute.links || []).some(l => l.rel === 'provide_evidence');
    const requested = (dispute.evidences || []).find(e => e.source === 'REQUESTED_FROM_SELLER');
    const wantsTracking = requested?.evidence_type === 'PROOF_OF_FULFILLMENT';
    const { tracking } = buildMockContext(orderForDispute(dispute), dispute);

    // Evidence path: only when PayPal asked for proof of fulfillment AND we have shipping data for it
    if (canProvideEvidence && wantsTracking && tracking) {
      const evidence = {
        evidence_type: 'PROOF_OF_FULFILLMENT',
        notes: reply,
        evidence_info: {
          tracking_info: [{ carrier_name: tracking.carrier, tracking_number: tracking.number }],
        },
      };
      const r = await paypalProvideEvidence(id, { evidences: [evidence] });
      if (!r.ok) {
        console.error('provide-evidence error:', JSON.stringify(r.data));
        return res.status(502).json({ error: `PayPal: ${paypalErrorText(r.data)}` });
      }
      return res.json({ message: 'Your evidence was sent to PayPal.' });
    }

    // Inquiry stage: message the buyer
    if (dispute.dispute_life_cycle_stage === 'INQUIRY') {
      const r = await paypalPost(`/v1/customer/disputes/${id}/send-message`, { json: { message: reply } });
      if (!r.ok) {
        console.error('send-message error:', JSON.stringify(r.data));
        return res.status(502).json({ error: `PayPal: ${paypalErrorText(r.data)}` });
      }
      const noRecord = canProvideEvidence && wantsTracking && !tracking;
      return res.json({
        message: noRecord
          ? 'Your reply was sent to the buyer. No shipping record was found for this dispute, so no tracking evidence was attached.'
          : 'Your reply was sent to the buyer through PayPal.',
      });
    }

    res.status(400).json({ error: 'PayPal is not accepting a response for this dispute right now.' });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: err.message });
  }
});

// Unknown /api routes return JSON, so the pages never get an HTML error page
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => console.log(`Running on ${APP_URL} (AI step enabled)`));