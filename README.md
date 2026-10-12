# MedSave — combined feature update

This package preserves the existing MedSave landing page and Gemini-backed bill review, and adds: insurance cost estimation, user-supplied benchmark comparison, a dispute/clarification letter generator, print-to-PDF for reviews, and opt-in local browser report history. Pricing remains informational because payment checkout is not configured.

## Important scope notes

- The price comparison feature does **not** include a verified UAE price database. It compares values and a source/date entered by the user.
- The insurance calculator is a simplified estimate; actual plan rules and insurer adjudication may differ.
- History is saved only in the current browser using localStorage. It is not encrypted, is not a secure account system, and does not sync across devices. Do not use it for real patient records until privacy controls are designed and reviewed.
- PDF export uses the browser print dialog: choose “Save as PDF”.
- Pricing cards are not connected to payment processing. Do not advertise subscriptions as purchasable until checkout and entitlement checks exist.
- The bill review uses Gemini. Review the AI provider's data handling, hosting logs, retention, applicable UAE privacy obligations, and consent before using real medical documents. Use fictional bills while testing.

## Deploy frontend to GitHub Pages

1. Back up the current repository first.
2. Replace the repository's `index.html` with this package's `index.html`.
3. Commit and push to the branch/folder configured for GitHub Pages.
4. Open `https://gmu26.github.io/MedSave/` and test on desktop and mobile.

## Deploy backend to Render

1. Put `server.js`, `package.json`, and `.env.example` in the backend repository (do not put a real `.env` or API key in GitHub).
2. Build command: `npm install`
3. Start command: `npm start`
4. Add Render environment variables: `GEMINI_API_KEY` (secret), `GEMINI_MODEL=gemini-2.5-flash`, `FRONTEND_ORIGIN=https://gmu26.github.io`.
5. Deploy and verify `/health` returns `{"status":"ok"}` and `/` reports the API online.
6. Test `/api/analyze` with a fictional sample bill only.

## Before public launch

Add real authentication and a protected database only if cloud history is needed; encrypt stored documents; implement deletion/retention controls; add rate limiting and abuse protection; add a real verified price-data source; and integrate a payment provider with server-side subscription enforcement. Conduct a security/privacy review first.
