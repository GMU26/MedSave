
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

const allowedOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : false,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
  fileFilter: (req, file, callback) => {
    const allowed = [
      "application/pdf",
      "image/jpeg",
      "image/png"
    ];

    if (!allowed.includes(file.mimetype)) {
      return callback(
        new Error("Upload a PDF, JPG, or PNG file.")
      );
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

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/analyze", (req, res) => {
  upload.single("bill")(req, res, async (err) => {
    if (err) return handleError(err, res);

    try {
      if (!req.file) {
        return res.status(400).json({
          error: "Please upload a medical bill."
        });
      }

      if (!process.env.GEMINI_API_KEY) {
        return res.status(503).json({
          error: "Gemini AI is not configured yet."
        });
      }

      const ai = new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY
      });

      const instructions = `
You are MedSave, a medical billing information assistant.

Review the uploaded medical bill and provide:

1. A plain-language summary.
2. Provider name, bill date, currency and total, if readable.
3. Readable itemized charges and amounts.
4. Possible duplicate charges or arithmetic inconsistencies,
   only when supported by the document.
5. Charges or descriptions that need clarification.
6. Questions the patient can ask their provider or insurer.
7. Any unreadable or missing information.

Do not invent missing information.
Do not accuse a provider of fraud or declare an error
without evidence.
Repeated charges are not automatically errors.
Do not diagnose conditions or determine medical necessity.
Do not promise savings or insurance reimbursement.
Separate observed facts from possible concerns.
Do not repeat patient names, addresses, phone numbers,
insurance IDs or other personal identifiers.
Use clear headings and plain language.
`;

      const base64 = req.file.buffer.toString("base64");

      const response = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL || "gemini-flash-latest",
        contents: [
          {
            role: "user",
            parts: [
              { text: instructions },
              {
                inlineData: {
                  mimeType: req.file.mimetype,
                  data: base64
                }
              }
            ]
          }
        ],
        config: {
          maxOutputTokens: 1800
        }
      });

      const review = response.text;

      if (!review) {
        return res.status(502).json({
          error: "Gemini did not return a review. Please try again."
        });
      }

      return res.json({
        success: true,
        review,
        disclaimer:
          "This is an AI-assisted review, not proof of a billing error. Confirm concerns with your provider or insurer."
      });
    } catch (error) {
      console.error("Gemini analysis failed:", error.message);

      return res.status(500).json({
        error: "The bill could not be analyzed. Please try again later."
      });
    }
  });
});

function handleError(err, res) {
  if (err instanceof multer.MulterError) {
    const status =
      err.code === "LIMIT_FILE_SIZE" ? 413 : 400;

    return res.status(status).json({
      error: status === 413
        ? "The file exceeds the 10 MB limit."
        : "The upload could not be processed."
    });
  }

  if (err.message === "Upload a PDF, JPG, or PNG file.") {
    return res.status(400).json({ error: err.message });
  }

  console.error("Upload error:", err.message);

  return res.status(500).json({
    error: "The upload could not be processed."
  });
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MedSave API listening on port ${PORT}`);
});
