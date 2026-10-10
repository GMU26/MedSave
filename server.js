
import express from "express";
import cors from "cors";
import helmet from "helmet";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

app.disable("x-powered-by");
app.use(helmet());

const allowedOrigins = (process.env.FRONTEND_ORIGIN || "https://gmu26.github.io")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
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
    callback(null, true);
  }
});

app.get("/", (req, res) => {
  res.json({
    name: "MedSave API",
    status: "online",
    message: "Medical bill review service is running."
  });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

const EMPTY_AUDIT = {
  currency: null,
  totals: {
    totalBilled: null,
    insurancePaid: null,
    adjustments: null,
    patientBalance: null,
    lineItemSubtotal: null
  },
  lineItemsComplete: false,
  lineItems: [],
  findings: [],
  questions: []
};

function validNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function cleanAudit(input) {
  if (!input || typeof input !== "object") return structuredClone(EMPTY_AUDIT);

  const totalsInput = input.totals || {};
  const lineItems = Array.isArray(input.lineItems)
    ? input.lineItems.slice(0, 150).map((item) => ({
        description: String(item?.description || "Unclear description").slice(0, 250),
        amount: validNumber(item?.amount) ? item.amount : null,
        quantity: validNumber(item?.quantity) ? item.quantity : null
      }))
    : [];

  const findings = Array.isArray(input.findings)
    ? input.findings.slice(0, 30).map((item) => ({
        type: String(item?.type || "review").slice(0, 60),
        severity: ["low", "medium", "high"].includes(item?.severity)
          ? item.severity
          : "low",
        title: String(item?.title || "Item to review").slice(0, 180),
        evidence: String(item?.evidence || "Evidence is limited.").slice(0, 600),
        explanation: String(item?.explanation || "").slice(0, 800),
        suggestedQuestion: String(item?.suggestedQuestion || "").slice(0, 500)
      }))
    : [];

  return {
    currency: typeof input.currency === "string"
      ? input.currency.slice(0, 10)
      : null,
    totals: {
      totalBilled: validNumber(totalsInput.totalBilled) ? totalsInput.totalBilled : null,
      insurancePaid: validNumber(totalsInput.insurancePaid) ? totalsInput.insurancePaid : null,
      adjustments: validNumber(totalsInput.adjustments) ? totalsInput.adjustments : null,
      patientBalance: validNumber(totalsInput.patientBalance) ? totalsInput.patientBalance : null,
      lineItemSubtotal: validNumber(totalsInput.lineItemSubtotal) ? totalsInput.lineItemSubtotal : null
    },
    lineItemsComplete: input.lineItemsComplete === true,
    lineItems,
    findings,
    questions: Array.isArray(input.questions)
      ? input.questions.slice(0, 15).map((q) => String(q).slice(0, 500))
      : []
  };
}

function addDeterministicChecks(audit) {
  const findings = [...audit.findings];
  const seen = new Map();

  // Flag matching descriptions and amounts as candidates, not confirmed errors.
  for (const item of audit.lineItems) {
    if (!validNumber(item.amount)) continue;

    const description = item.description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

    if (!description) continue;

    const key = `${description}|${item.amount.toFixed(2)}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }

  for (const [key, count] of seen.entries()) {
    if (count > 1) {
      const [description, amount] = key.split("|");
      findings.push({
        type: "possible_duplicate",
        severity: "medium",
        title: "Repeated charge to verify",
        evidence: `"${description}" appears ${count} times with the same amount (${amount}).`,
        explanation: "Repeated entries can be legitimate, such as separate visits or units. The matching entries alone do not establish a billing error.",
        suggestedQuestion: "Could you confirm why this same-described charge appears multiple times and provide the corresponding service dates or item details?"
      });
    }
  }

  // Only compare totals when the AI says the extracted list is complete.
  const amountsComplete =
    audit.lineItemsComplete &&
    audit.lineItems.length > 0 &&
    audit.lineItems.every((item) => validNumber(item.amount));

  if (amountsComplete && validNumber(audit.totals.lineItemSubtotal)) {
    const extractedSum = audit.lineItems.reduce((sum, item) => sum + item.amount, 0);
    const difference = Math.round(
      (extractedSum - audit.totals.lineItemSubtotal) * 100
    ) / 100;

    if (Math.abs(difference) > 0.02) {
      findings.push({
        type: "arithmetic_check",
        severity: "medium",
        title: "Line items do not match the stated subtotal",
        evidence: `Extracted line items total ${extractedSum.toFixed(2)}, while the stated subtotal is ${audit.totals.lineItemSubtotal.toFixed(2)}. Difference: ${difference.toFixed(2)}.`,
        explanation: "This is a reconciliation difference to investigate, not proof of an error. Taxes, discounts, missing items, rounding, or text extraction mistakes may explain it.",
        suggestedQuestion: "Could you provide an itemized breakdown showing how the line items reconcile with the stated subtotal?"
      });
    }
  }

  audit.findings = findings.slice(0, 40);
  return audit;
}

app.post("/api/analyze", (req, res) => {
  upload.single("bill")(req, res, async (uploadError) => {
    if (uploadError) return handleError(uploadError, res);

    if (!req.file) {
      return res.status(400).json({ error: "Please upload a medical bill." });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(503).json({ error: "Gemini AI is not configured yet." });
    }

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

      const instructions = `
You are MedSave, a careful medical billing explainer. Analyze the uploaded document.

Return ONLY valid JSON with this exact structure:
{
  "isMedicalBill": true,
  "documentType": "medical bill",
  "review": "A complete Markdown review",
  "audit": {
    "currency": "AED or another visible currency code, otherwise null",
    "totals": {
      "totalBilled": null,
      "insurancePaid": null,
      "adjustments": null,
      "patientBalance": null,
      "lineItemSubtotal": null
    },
    "lineItemsComplete": false,
    "lineItems": [
      { "description": "visible charge description", "amount": 0, "quantity": null }
    ],
    "findings": [
      {
        "type": "unclear_charge",
        "severity": "low",
        "title": "Short finding title",
        "evidence": "What is visibly written in the document",
        "explanation": "Why the item may need clarification",
        "suggestedQuestion": "A polite question to ask the provider"
      }
    ],
    "questions": ["Specific question to ask"]
  }
}

Rules:
- Use null for unknown or unreadable amounts. Never invent values.
- Amounts must be JSON numbers, not formatted strings.
- lineItemsComplete may be true ONLY if all visible line items have been captured with their amounts.
- Include repeated charges as separate line items when visible.
- Only add findings supported by visible evidence. Repeated charges are not automatically errors.
- Never claim fraud, a definite error, medical necessity, or guaranteed savings.
- Keep personal identifiers such as patient names, addresses, phone numbers, patient IDs and insurance IDs out of the response.
- If this is not a medical bill or cannot be read, set isMedicalBill to false, explain this in review, and return an empty audit with null totals and empty arrays.
- Do not assume the patient has insurance.
- The review Markdown must contain these headings:
  ## 1. Bill at a glance
  ## 2. What each charge means
  ## 3. How the total adds up
  ## 4. Items worth checking
  ## 5. Questions to ask
  ## 6. What to do next
  ## 7. Important limitations
- Explain uncertainties and remind the user to confirm concerns with the provider or insurer.
`;

      const response = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
        contents: [{
          role: "user",
          parts: [
            { text: instructions },
            {
              inlineData: {
                mimeType: req.file.mimetype,
                data: req.file.buffer.toString("base64")
              }
            }
          ]
        }],
        config: {
          maxOutputTokens: 6500,
          responseMimeType: "application/json"
        }
      });

      const raw = response.text;
      if (!raw) {
        return res.status(502).json({ error: "AI did not return a review. Please try again." });
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        console.error("AI returned invalid JSON.");
        return res.status(502).json({
          error: "The analysis response could not be processed. Please try again."
        });
      }

      if (typeof parsed.review !== "string" || !parsed.review.trim()) {
        return res.status(502).json({ error: "AI did not return a readable review. Please try again." });
      }

      const isMedicalBill = parsed.isMedicalBill === true;
      let audit = isMedicalBill
        ? addDeterministicChecks(cleanAudit(parsed.audit))
        : structuredClone(EMPTY_AUDIT);

      return res.json({
        success: true,
        isMedicalBill,
        documentType: String(parsed.documentType || "unknown").slice(0, 100),
        review: parsed.review,
        audit,
        disclaimer: "AI-assisted information only. Findings are items to verify, not proof of billing errors. Confirm concerns with your provider or insurer."
      });
    } catch (error) {
      console.error("Gemini analysis failed:", error.message);
      return res.status(500).json({
        error: "The bill could not be analyzed. Please try again later."
      });
    }
  });
});

function handleError(error, res) {
  if (error instanceof multer.MulterError) {
    const tooLarge = error.code === "LIMIT_FILE_SIZE";
    return res.status(tooLarge ? 413 : 400).json({
      error: tooLarge
        ? "The file exceeds the 10 MB limit."
        : "The upload could not be processed."
    });
  }

  if (error.message === "Upload a PDF, JPG, or PNG file.") {
    return res.status(400).json({ error: error.message });
  }

  console.error("Request rejected:", error.message);
  return res.status(
    error.message === "Origin not allowed by CORS" ? 403 : 500
  ).json({
    error: error.message === "Origin not allowed by CORS"
      ? "This website is not allowed to use the MedSave API."
      : "The upload could not be processed."
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MedSave API listening on port ${PORT}`);
});
