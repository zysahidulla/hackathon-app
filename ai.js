const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const VALID = ['approve', 'review', 'hold'];

const SYSTEM_PROMPT = `You are a fraud-review assistant for a small online seller.
You receive one order and the risk rules it triggered. Write a short, plain-English
explanation for the seller and recommend an action.

Rules:
- Base your answer ONLY on the data provided. Do not invent facts about the buyer.
- Be calm and specific. Mention the signals that matter most.
- The seller makes the final decision, so phrase it as a recommendation.
- Reply with ONLY a JSON object in this exact shape:
{"explanation": "2-3 sentences", "recommendation": "approve" | "review" | "hold"}`;

// Used when there is no API key or the AI call fails, so the app never breaks.
function fallback(risk) {
  const recommendation =
    risk.level === 'HIGH' ? 'hold' : risk.level === 'MEDIUM' ? 'review' : 'approve';
  const explanation = risk.reasons.length
    ? `Flagged because: ${risk.reasons.join('; ')}.`
    : 'No risk signals were triggered for this order.';
  return { explanation, recommendation, source: 'rules' };
}

async function explainRisk(order, risk) {
  if (!process.env.GEMINI_API_KEY) return fallback(risk);

  const userMessage = JSON.stringify({
    order: {
      amountUSD: order.amount,
      buyerCountry: order.buyerCountry,
      shipCountry: order.shipCountry,
    },
    risk: { score: risk.score, level: risk.level, triggeredRules: risk.reasons },
  });

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-goog-api-key': process.env.GEMINI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: 1000,
        },
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));

    const text = (data.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || '')
      .join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    if (!parsed.explanation || !VALID.includes(parsed.recommendation)) {
      throw new Error('Unexpected AI response shape');
    }
    return {
      explanation: String(parsed.explanation),
      recommendation: parsed.recommendation,
      source: 'ai',
    };
  } catch (err) {
    console.error('AI explanation failed, using fallback:', err.message);
    return fallback(risk);
  }
}

module.exports = { explainRisk };