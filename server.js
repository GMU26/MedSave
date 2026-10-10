
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const multer = require("multer");
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_FILE_SIZE = 10 * 1024 * 1024;

app.disable("x-powered-by");
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN || false,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));
app.use(express.json({ limit: "20kb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1
  },
  fileFilter: (req, file, callback) => {
    const allowed = [
      "application/pdf",
      "image/jpeg",
      "image/png"
    ];

    if (!allowed.includes(file.mimetype)) {
      return callback(new Error("Upload a PDF, JPG, or PNG file."));
    }

    callback(null, true);
  }
});

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("AI service is not configured.");
  }

  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

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

app.post("/api/analyze", (req, res, next) => {
  upload.single("bill")(req, res, async (err) => {
    if (err) return next(err);

    try {
      if (!req.file) {
        return res.status(400).json({
          error: "Please upload a medical bill."
        });
      }

      if (!process.env.OPENAI_API_KEY) {
        return res.status(503).json({
          error: "AI analysis is not configured yet."
        });
      }

      const client = getOpenAI();
      const mime = req.file.mimetype;
      let content;

      if (mime === "application/pdf") {
        const base64 = req.file.buffer.toString("base64");

        content = [
          {
            type: "file",
            file: {
              filename: "medical-bill.pdf",
              file_data: `data:application/pdf;base64,${base64}`
            }
          },
          {
            type: "text",
            text: "Review this medical bill using the instructions below."
          }
        ];
      } else {
        const base64 = req.file.buffer.toString("base64");

        content = [
          {
            type: "image_url",
            image_url: {
              url: `data:${mime};base64,${base64}`,
              detail: "high"
            }
          },
          {
            type: "text",
            text: "Review this medical bill using the instructions below."
          }
        ];
      }

      const instructions = `
You are MedSave, a medical billing information assistant.

Read the provided bill and return a clear, cautious review.

Include:
1. A plain-language summary of the bill.
2. The provider's name, bill date, currency, and total, if readable.
3. An itemized list of readable charges and amounts.
4. Possible duplicate charges or arithmetic inconsistencies, if supported by the document.
5. Charges or descriptions that need clarification.
6. Specific questions the patient can ask the provider or insurer.
7. Any information that is unreadable or missing.

Do not invent missing information.
Do not declare that a provider committed fraud or definitely overcharged.
Do not treat repeated charges as errors without evidence.
Do not provide a diagnosis or determine medical necessity.
Do not promise savings or claim an insurer must pay.
Distinguish observed facts from possible concerns.
The document may contain sensitive personal information. Do not repeat
patient identifiers, addresses, phone numbers, or insurance IDs.
Return your answer in clear Markdown.
`;

      const response = await client.responses.create({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        instructions,
        input: [
          {
            role: "user",
            content
          }
        ],
        max_output_tokens: 1800
      });

      res.json({
        success: true,
        review: response.output_text || "No review was returned.",
        disclaimer:
          "This is an AI-assisted review, not proof of a billing error. Confirm concerns with your provider or insurer."
      });
    } catch (error) {
      console.error("Analysis failed:", error.message);

      res.status(500).json({
        error: "The bill could not be analyzed. Please try again later."
      });
    }
  });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;

    return res.status(status).json({
      error: err.code === "LIMIT_FILE_SIZE"
        ? "The file exceeds the 10 MB limit."
        : "The upload could not be processed."
    });
  }

  if (err.message === "Upload a PDF, JPG, or PNG file.") {
    return res.status(400).json({ error: err.message });
  }

  console.error("Request error:", err.message);
  res.status(500).json({ error: "An unexpected server error occurred." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`MedSave API listening on port ${PORT}`);
});
