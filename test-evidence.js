require('dotenv').config();
const { buildEvidencePacket } = require('./evidence');

const now = Date.now();
const dispute = {
  dispute_id: 'PP-R-TEST-0001',
  reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  status: 'WAITING_FOR_SELLER_RESPONSE',
  dispute_life_cycle_stage: 'INQUIRY',
  dispute_amount: { currency_code: 'USD', value: '30.00' },
  create_time: new Date(now).toISOString(),
  messages: [{ posted_by: 'BUYER', time_posted: new Date(now).toISOString(), content: 'I have not received my order.' }],
};
const order = {
  id: 'TESTORDER1', amount: 30, buyerCountry: 'PH', shipCountry: 'PH',
  createdAt: now - 20 * 60000, decidedAt: now - 18 * 60000,
  status: 'approved', paypalStatus: 'COMPLETED', captureId: 'CAP123',
  risk: { score: 0, level: 'LOW', reasons: [] },
};

buildEvidencePacket(dispute, order).then(p => console.log(JSON.stringify(p, null, 2)));