import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 90_000;

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
      const response = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
        contents: [{
          role: "user",
          parts: [
            { text: instructions },
            { inlineData: { mimeType: req.file.mimetype, data: req.file.buffer.toString("base64") } }
          ]
        }],
        config: { maxOutputTokens: 3500 }
      });

      const review = response.text;
      if (!review) return res.status(502).json({ error: "Gemini did not return a review. Please try again." });
      return res.json({
        success: true,
        review,
        disclaimer: "This is an AI-assisted explanation, not proof of a billing error. Confirm concerns with your provider or insurer."
      });
    } catch (error) {
      console.error("Gemini analysis failed:", error.message);
      return res.status(500).json({ error: "The bill could not be analyzed. Please try again later." });
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
