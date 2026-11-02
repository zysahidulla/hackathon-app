# Seller Shield

**AI-assisted fraud screening and dispute support for small online sellers, built on the PayPal sandbox.**

Seller Shield was built for the PayPal AI Hackathon on Devpost. It helps a small seller decide which orders to trust before shipping, and (in the dispute workflow) helps them respond when a buyer opens a dispute. A person always makes the final call: the AI recommends, the seller approves, and only then does money move.

> Seller Shield is an independent hackathon project. It is not made by or affiliated with PayPal. It runs only against the PayPal **sandbox** (test money, test accounts).

**Team:** [Your name] and [Teammate's name]

---

## The problem

Small sellers do not have a fraud team. They have to guess which orders are risky, and when a buyer opens a dispute they have to gather order details, tracking, and messages by hand under a deadline. Both are slow, stressful, and easy to get wrong.

## What it does

### 1. Order screening (fraud and scam detection)

- Creates a real order in the PayPal sandbox through the Orders API.
- Scores each order from 0 to 100 using transparent rules (see [Risk rules](#risk-rules)) and shows a risk meter and the exact rules that fired.
- Sends the order and the triggered rules to Google Gemini, which writes a short plain-English explanation and recommends **approve**, **review**, or **hold**.
- The seller reviews the queue and clicks **Approve order** or **Hold order**.
- Approving an order captures the payment through the PayPal Orders API (once the buyer has approved it on PayPal).
- The system only learns what "normal" looks like from the seller's seed history and orders the seller has approved, so suspicious orders cannot teach it that they are normal.

### 2. Dispute evidence builder

[TEAMMATE: describe the dispute workflow here once it is built. Suggested points: how a test dispute is created or simulated in the sandbox, which Disputes API calls are used (get dispute, provide evidence), what the AI-generated evidence packet contains (summary, timeline, key facts, draft reply), and how the seller reviews and submits it. Delete this paragraph when done.]

---

## What is real and what is simulated

The PayPal sandbox does not provide real buyer locations, order history, shipping tracking, or buyer-seller chat. We are upfront about what that means:

| Part | Status |
|---|---|
| PayPal authentication, order creation, buyer approval, and payment capture | **Real** (PayPal sandbox APIs) |
| AI explanations and recommendations | **Real** (Google Gemini API) |
| Buyer country and ship-to country | **Simulated** (entered in the form) |
| Past sales used as the seller's "normal" history | **Simulated** (4 seed orders in `server.js`) |
| Distance between countries | **Approximate** (country-center coordinates, not real addresses) |
| Dispute data, tracking info, and chat history | [TEAMMATE: state which parts are real sandbox data and which are simulated] |

Orders are stored in memory, so they reset when the server restarts.

---

## Risk rules

Each new order is compared against the seller's trusted history (seed orders plus approved orders). Points are added, then capped at 100.

| Rule | Points |
|---|---|
| Buyer country has never been seen in trusted history | +40 |
| New buyer country is more than 3,000 km from the closest trusted country | +15 |
| Amount is more than 3x the typical (median) trusted order | +30 |
| New buyer country combined with a large order | +10 |
| Buyer country differs from ship-to country | +20 |
| Three or more orders in the last 10 minutes | +20 |

**Levels:** 0 to 29 is low, 30 to 59 is medium, 60 and above is high.

The scoring is rule-based on purpose. The rules decide the score, so it is predictable and explainable, and the AI explains it and recommends an action. The rules are simple heuristics for a prototype, not a trained fraud model.

## How the AI is used

- **Model:** Google Gemini, configured with the `GEMINI_MODEL` environment variable (default `gemini-3.1-flash-lite`).
- **Input:** only the order amount, the two countries, and the list of triggered rules.
- **Output:** a short explanation and a recommendation (`approve`, `review`, or `hold`).
- **Safeguards:** the prompt tells the model to use only the data provided and never to describe any country or nationality as high-risk or associated with fraud. The AI cannot approve, hold, or capture anything. If the AI call fails or times out (20 seconds), the app falls back to a rule-based summary and labels it as such.

---

## Tech stack

- Node.js and Express (backend)
- Plain HTML, CSS, and JavaScript (frontend, no build step)
- PayPal REST APIs in the sandbox: OAuth2, Orders v2 (create and capture) [TEAMMATE: add Disputes API if used]
- Google Gemini API (generateContent)

## Project structure

```
server.js            Express server, PayPal calls, risk scoring, order routes
ai.js                Gemini explanation with timeout and fallback
public/index.html    Orders dashboard
public/styles.css    Shared styles
.env.example         Names of the environment variables to set
LICENSE              MIT license
```

[TEAMMATE: add `evidence.js`, `public/disputes.html`, and any data files here.]

---

## Run it locally

**Requirements:** Node.js 18 or newer, a PayPal developer account (free), and a Gemini API key (free tier available).

### 1. Get the code and install

```bash
git clone [YOUR REPO URL]
cd [YOUR REPO FOLDER]
npm install
```

### 2. Get your keys

**PayPal sandbox credentials**
1. Log in to the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard) and switch to **Sandbox**.
2. Go to **Apps & Credentials**, create an app (type **Merchant**), and copy the **Client ID** and **Secret**.
3. Under **Testing Tools, Sandbox Accounts**, find your sandbox **Personal** (buyer) account. Open its **View/Edit Account** menu to see the email and password. You will use it to approve payments.
4. On your sandbox **Business** account, make sure **Negative Testing** is off, and turn off **Payment Review** if it is on (it can hold captured payments as pending).

**Gemini API key**
1. Create a key in [Google AI Studio](https://aistudio.google.com).
2. If the default model name is rejected for your account, list the models available to your key and set `GEMINI_MODEL` to one that works.

### 3. Configure the environment

Copy the example file and fill in your values:

```bash
# macOS / Linux
cp .env.example .env

# Windows (Command Prompt or PowerShell)
copy .env.example .env
```

`.env`:

```
PAYPAL_CLIENT_ID=your_sandbox_client_id
PAYPAL_CLIENT_SECRET=your_sandbox_secret
GEMINI_API_KEY=your_gemini_key
GEMINI_MODEL=gemini-3.1-flash-lite
```

`.env` is listed in `.gitignore`. Never commit it.

### 4. Start the server

```bash
node server.js
```

Open **http://localhost:3000**.

---

## Try it

1. **Typical order:** click **Typical order**, then **Create and score order**. Buyer in PH, shipping to PH, $30 should score low.
2. **Suspicious order:** click **Suspicious order**, then create it. A $500 order from NG shipping to PH should score high, with a meter, the rules that fired, and an AI explanation recommending a hold.
3. **Approve and capture:**
   1. Click **Approve order** on an order.
   2. Click **Open buyer approval** and log in with your sandbox Personal account to approve the payment on PayPal.
   3. Return to the dashboard and click **Retry capture**. The order shows "Payment captured".
   4. Optionally, log in to the sandbox Business account to see the payment in its activity.
4. **Learning from decisions:** approve a flagged order, then create the same order again. The score drops because that buyer country is now known, while the other signals still apply.

[TEAMMATE: add a short walkthrough of the dispute flow here.]

---

## Limitations

- Sandbox only. No real money moves.
- Buyer location, order history, and distance are simulated or approximate, as described above.
- Orders are held in memory and are lost when the server restarts.
- A sandbox order must be captured within about 3 hours of creation.
- The risk rules are hand-written heuristics and would need real data and tuning before any production use.
- The AI gives suggestions only. It can be wrong, and a human decision is required before payment capture.

## Troubleshooting

- **Orders show "(AI was unavailable)":** check the terminal for lines starting with `[ai]`. Common causes are a wrong `GEMINI_MODEL`, a missing key, or a rate limit.
- **Capture says it is waiting for the buyer:** open the buyer approval link, approve with the sandbox Personal account, then click **Retry capture**.
- **Capture status is pending:** turn off Payment Review on the sandbox Business account.
- **Port already in use:** another copy of the server is running. Stop it and start again.

## License

MIT. See [LICENSE](LICENSE).