const crypto = require('crypto');

const MIN = 60 * 1000;

// Deterministic fake tracking number, so the same order always gets the same one
function trackingNumberFor(orderId) {
  const hash = crypto.createHash('sha1').update(String(orderId)).digest('hex');
  return String(parseInt(hash.slice(0, 10), 16)).padStart(12, '0').slice(-12);
}

/**
 * SIMULATED shipping and chat data. The PayPal sandbox provides neither.
 * Times are compressed to a few minutes after approval, because sandbox orders are minutes old.
 */
function buildMockContext(order /*, dispute */) {
  if (!order) return { tracking: null, chat: [] };

  const base = order.decidedAt || order.createdAt;
  const number = trackingNumberFor(order.id);

  const tracking = {
    carrier: 'FEDEX', // carrier code sent to PayPal
    carrierName: 'FedEx',
    number,
    delivered: true,
    deliveredAt: base + 3 * MIN,
    events: [
      { time: base + 1 * MIN, text: 'Package picked up by the carrier' },
      { time: base + 2 * MIN, text: 'Package in transit' },
      { time: base + 3 * MIN, text: `Delivered to the buyer's address in ${order.shipCountry}` },
    ],
  };

  const chat = [
    { time: order.createdAt + 15 * 1000, from: 'BUYER', text: 'Hi, can you confirm this will ship to my address?' },
    { time: base + 30 * 1000, from: 'SELLER', text: `Confirmed. Your order ships today, tracking number ${number}.` },
    { time: base + 4 * MIN, from: 'BUYER', text: 'Got the tracking update, thank you!' },
  ];

  return { tracking, chat };
}

module.exports = { buildMockContext };