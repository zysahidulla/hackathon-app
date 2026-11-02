require('dotenv').config();

const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
console.log('key loaded:', !!process.env.GEMINI_API_KEY, '| model:', model);

(async () => {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': process.env.GEMINI_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Reply with the word OK.' }] }],
        }),
        signal: AbortSignal.timeout(30000),
      }
    );
    console.log('HTTP status:', res.status);
    console.log(await res.text());
  } catch (err) {
    console.error('Request failed:', err.name, err.message);
  }
})();