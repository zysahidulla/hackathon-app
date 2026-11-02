require('dotenv').config();

const BASE = 'https://api-m.sandbox.paypal.com';

(async () => {
  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64');

  const tokenRes = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) return console.error('Auth failed:', JSON.stringify(tokenData));

  const res = await fetch(`${BASE}/v1/customer/disputes?page_size=10`, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const data = await res.json();
  if (!res.ok) return console.error('List disputes failed:', JSON.stringify(data));

  const items = data.items || [];
  console.log(`Found ${items.length} dispute(s)`);
  items.forEach(d =>
    console.log(`${d.dispute_id} | ${d.reason} | ${d.status} | ${d.dispute_amount?.value} ${d.dispute_amount?.currency_code}`)
  );

  // Show the full shape of the first dispute, if any
  if (items[0]) {
    const detail = await fetch(`${BASE}/v1/customer/disputes/${items[0].dispute_id}`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    console.log(JSON.stringify(await detail.json(), null, 2));
  }
})();
