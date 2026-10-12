import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const RATE_CACHE_TTL_MS = 60 * 60 * 1000;
const rateCache = new Map();
const SUPPORTED_CURRENCIES = new Set(["AED", "USD", "INR", "EUR", "GBP", "SAR"]);

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setTimeout(REQUEST_TIMEOUT_MS, () => { if (!res.headersSent) res.status(408).json({ error: "The request took too long. Please try again with a clearer or smaller document." }); });
  next();
});
app.use(helmet());

const allowedOrigins = (process.env.FRONTEND_ORIGIN || "https://gmu26.github.io")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Allow non-browser health checks with no Origin header; browser requests
    // must match an explicitly configured GitHub Pages origin.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed by CORS"));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter(req, file, callback) {
    const allowed = ["application/pdf", "image/jpeg", "image/png"];
    if (!allowed.includes(file.mimetype)) {
      return callback(new Error("Upload a PDF, JPG, or PNG file."));
    }
    return callback(null, true);
  }
});

app.get("/", (req, res) => {
  res.json({ name: "MedSave API", status: "online", message: "Medical bill review service is running." });
});
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Latest available reference exchange rates. Cached briefly to avoid excess upstream requests.
app.get("/api/rates", async (req, res) => {
  const base = String(req.query.base || "AED").toUpperCase();
  if (!SUPPORTED_CURRENCIES.has(base)) {
    return res.status(400).json({ error: "Unsupported base currency. Choose AED, USD, INR, EUR, GBP, or SAR." });
  }
  const cached = rateCache.get(base);
  if (cached && Date.now() - cached.fetchedAt < RATE_CACHE_TTL_MS) {
    return res.json({ ...cached.data, cached: true });
  }
  try {
    const upstream = await fetch(`https://open.er-api.com/v6/latest/${base}`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(10000)
    });
    if (!upstream.ok) throw new Error(`Exchange-rate provider returned HTTP ${upstream.status}`);
    const data = await upstream.json();
    if (data.result !== "success" || !data.rates || typeof data.rates.USD !== "number") {
      throw new Error("Exchange-rate provider returned an invalid response");
    }
    const payload = {
      base_code: data.base_code || base,
      rates: data.rates,
      date: data.time_last_update_utc || data.time_last_update_unix || null,
      provider: "ExchangeRate-API open endpoint",
      cached: false
    };
    rateCache.set(base, { fetchedAt: Date.now(), data: payload });
    return res.json(payload);
  } catch (error) {
    console.error("Exchange-rate lookup failed:", error.message);
    if (cached) return res.json({ ...cached.data, cached: true, stale: true });
    return res.status(502).json({ error: "Live exchange rates are temporarily unavailable. Please try again shortly." });
  }
});

app.post("/api/analyze", (req, res) => {
  upload.single("bill")(req, res, async (uploadError) => {
    if (uploadError) return handleError(uploadError, res);
    if (!req.file) return res.status(400).json({ error: "Please upload a medical bill." });
    if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: "Gemini AI is not configured yet." });

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const instructions = `
You are MedSave, a careful medical billing explainer. Review the uploaded document and help an ordinary person understand it in simple, clear English.

Use these headings in this exact order:

## 1. Bill at a glance
Summarize the document in 2-4 sentences. Include provider, bill date, currency, total billed, insurance payment, adjustments and patient balance only when readable. Never assume total billed equals amount owed.

## 2. What each charge means
Explain every readable line item in a Markdown table with columns: Charge as written | Amount | Plain-English explanation | What to clarify. Explain unfamiliar billing terms. Do not guess at vague descriptions or silently omit readable charges.

## 3. How the total adds up
Explain subtotals, taxes, fees, payments, discounts, adjustments and remaining balance when shown. Check arithmetic where possible and show figures used. If figures do not reconcile or information is missing, state exactly what could not be verified.

## 4. Items worth checking
List possible duplicates, unclear fees, inconsistent amounts or descriptions worth asking about only when supported by the document. For each, say what was observed, why it may need clarification and what evidence is missing. Repeated charges are not automatically errors. Do not claim fraud or a confirmed billing mistake without evidence.

## 5. Questions to ask
Give specific, polite questions relevant to observed charges, balances, codes, adjustments or claim decisions. Do not assume the patient has insurance.

## 6. What to do next
Give a short practical checklist based on the bill.

## 7. Important limitations
State what was unreadable, missing or uncertain. Explain that the provider or insurer must confirm disputed charges.

Rules: Never invent amounts, codes, services, dates or provider details. Separate visible facts from possible concerns. Do not diagnose or determine medical necessity. Do not promise savings or reimbursement. Do not repeat patient names, addresses, phone numbers, patient IDs, insurance IDs or other personal identifiers. If this is not a medical bill or cannot be read, say so clearly instead of fabricating a review. Keep the answer clear and detailed but avoid repeating points.
`;
      const configuredModel = (process.env.GEMINI_MODEL || "gemini-3.8-flash").trim();
      const modelsToTry = [...new Set([configuredModel, "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash"])];
      let response = null;
      let lastModelError = null;
      for (const model of modelsToTry) {
        try {
          response = await ai.models.generateContent({
            model,
            contents: [{
              role: "user",
              parts: [
                { text: instructions },
                { inlineData: { mimeType: req.file.mimetype, data: req.file.buffer.toString("base64") } }
              ]
            }],
            config: { maxOutputTokens: 3500 }
          });
          console.log(`MedSave bill review completed using model: ${model}`);
          break;
        } catch (modelError) {
          lastModelError = modelError;
          const message = String(modelError?.message || "");
          const modelUnavailable = /model.*(not found|not supported|does not exist|unknown)|not found.*model|404|unsupported model/i.test(message);
          console.error(`Gemini model ${model} failed:`, message);
          if (!modelUnavailable) throw modelError;
        }
      }
      if (!response) throw lastModelError || new Error("No supported Gemini model was available.");

      const review = response.text;
      if (!review) return res.status(502).json({ error: "Gemini did not return a review. Please try again." });
      return res.json({
        success: true,
        review,
        disclaimer: "This is an AI-assisted explanation, not proof of a billing error. Confirm concerns with your provider or insurer."
      });
    } catch (error) {
      const message = String(error?.message || "");
      console.error("Gemini analysis failed:", message);
      if (/api key|unauthenticated|permission denied|invalid.*credential/i.test(message)) {
        return res.status(503).json({ error: "MedSave's Gemini API key is missing or invalid. The site owner must update GEMINI_API_KEY in Render environment settings." });
      }
      if (/quota|resource exhausted|rate limit|billing/i.test(message)) {
        return res.status(503).json({ error: "The AI service has reached its current quota or rate limit. Please try again later." });
      }
      if (/model.*(not found|not supported|does not exist|unknown)|not found.*model|404|unsupported model/i.test(message)) {
        return res.status(503).json({ error: "No configured Gemini model is available to this API key. In Render, set GEMINI_MODEL to gemini-3.8-flash or remove the variable, then redeploy." });
      }
      return res.status(502).json({ error: "Gemini could not analyze this file. Check that the document is a readable PDF, JPG, or PNG, then try again. If it continues, check the Render logs for the underlying Gemini error." });
    }
  });
});

function handleError(error, res) {
  if (error instanceof multer.MulterError) {
    const tooLarge = error.code === "LIMIT_FILE_SIZE";
    return res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? "The file exceeds the 10 MB limit." : "The upload could not be processed."
    });
  }
  if (error.message === "Upload a PDF, JPG, or PNG file.") {
    return res.status(400).json({ error: error.message });
  }
  console.error("Request rejected:", error.message);
  return res.status(error.message === "Origin not allowed by CORS" ? 403 : 500).json({
    error: error.message === "Origin not allowed by CORS" ? "This website is not allowed to use the MedSave API." : "The upload could not be processed."
  });
}

app.listen(PORT, "0.0.0.0", () => console.log(`MedSave API listening on port ${PORT}`));
