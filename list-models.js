require('dotenv').config();

(async () => {
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', {
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY },
  });
  const data = await res.json();
  if (!res.ok) return console.error('Error:', JSON.stringify(data));

  data.models
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .forEach(m => console.log(m.name.replace('models/', '')));
})();