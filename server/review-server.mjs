import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import express from "express";
import dotenv from "dotenv";
import mammoth from "mammoth";
import OpenAI from "openai";
import knowledgeBaseJson from "../src/data/policyKnowledgeBase.generated.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const sourceAssetsRoot = path.join(projectRoot, "sources");
const distRoot = path.join(projectRoot, "dist");
const DEFAULT_REVIEW_MODEL = "gpt-4o-mini";
const DEFAULT_EXTRACTION_MODEL = "gpt-4o-mini";
const AI_TRACKED_DOCUMENTS = [
  "المخططات المعمارية",
  "المخطط الإنشائي",
  "الموقع العام",
  "المخطط الكهربائي",
  "مخطط الأمن والسلامة",
  "المخططات الميكانيكية",
  "نظام البناء المعتمد من إدارة الرخص",
];

export function loadEnvironment(root = projectRoot) {
  dotenv.config({ path: path.resolve(root, ".env"), override: false });
  dotenv.config({ path: path.resolve(root, ".env.local"), override: false });
}

function loadKnowledgeBase(root = projectRoot) {
  return knowledgeBaseJson;
}

function normalizeArabic(value) {
  return String(value)
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSnippet(sourceText, searchTerms, radius = 140) {
  for (const term of searchTerms) {
    const index = sourceText.indexOf(term);
    if (index >= 0) {
      const start = Math.max(0, index - radius);
      const end = Math.min(sourceText.length, index + term.length + radius);
      return {
        matchedText: term,
        excerpt: sourceText.slice(start, end).replace(/\s+/g, " ").trim(),
      };
    }
  }

  const normalizedSource = normalizeArabic(sourceText);
  for (const term of searchTerms) {
    const normalizedTerm = normalizeArabic(term);
    const index = normalizedSource.indexOf(normalizedTerm);
    if (index >= 0) {
      const start = Math.max(0, index - radius);
      const end = Math.min(
        normalizedSource.length,
        index + normalizedTerm.length + radius,
      );
      return {
        matchedText: term,
        excerpt: normalizedSource.slice(start, end).trim(),
      };
    }
  }

  return null;
}

function compactAttachments(attachments) {
  return attachments.map((attachment) => ({
    name: attachment.name,
    sourceType: attachment.sourceType,
    detectedDocuments: attachment.detectedDocuments,
    notes: attachment.notes,
    extractedText: String(attachment.extractedText || "").slice(0, 3500),
  }));
}

function buildKnowledgeContext(
  knowledgeBase,
  policyId,
  matchedDocuments,
  missingDocuments,
  workflow,
) {
  const record = knowledgeBase.policies?.[policyId];
  const supplementalSources = Array.isArray(knowledgeBase.supplementalSources)
    ? knowledgeBase.supplementalSources
    : [];
  if (!record) {
    return {
      sourcePath: supplementalSources[0]?.sourcePath ?? "",
      citations: [],
    };
  }

  const citations = [
    {
      label: "ملخص السياسة",
      sourcePath: record.sourcePath,
      excerpt: record.summarySnippet,
      relevance: "المرجع الرئيسي للسياسة المختارة.",
    },
  ];

  const supplementalSearchTerms = [
    record.titleLine,
    ...matchedDocuments,
    ...missingDocuments,
    ...workflow.map((step) => step.action),
  ].filter(Boolean);
  for (const supplementalSource of supplementalSources) {
    const match = extractSnippet(
      supplementalSource.text,
      supplementalSearchTerms.slice(0, 12),
    );
    if (match) {
      citations.push({
        label: `مرجع تكميلي: ${supplementalSource.sourceFileName}`,
        sourcePath: supplementalSource.sourcePath,
        excerpt: match.excerpt,
        relevance: "مرجع عام إضافي يدعم تفسير الاشتراطات الواردة في السياسة.",
      });
    }
  }

  for (const label of [...matchedDocuments, ...missingDocuments].slice(0, 8)) {
    const match = extractSnippet(record.text, [label]);
    if (match) {
      citations.push({
        label,
        sourcePath: record.sourcePath,
        excerpt: match.excerpt,
        relevance: matchedDocuments.includes(label)
          ? "مستند تم اكتشافه في الملف المرفوع ويحتاج تقييم كفايته."
          : "مستند مطلوب لم يتم اكتشافه في الملفات المرفوعة.",
      });
    }
  }

  for (const step of workflow.slice(0, 4)) {
    const match = extractSnippet(record.text, [
      step.action,
      `${step.actor} ${step.action}`,
      step.actor,
    ]);
    if (match) {
      citations.push({
        label: `${step.actor}: ${step.action}`,
        sourcePath: record.sourcePath,
        excerpt: match.excerpt,
        relevance: "خطوة إجرائية يجب أن يراعيها قرار الاعتماد.",
      });
    }
  }

  return { sourcePath: record.sourcePath, citations };
}

function buildClient(apiKey) {
  return apiKey ? new OpenAI({ apiKey }) : null;
}

function getAllowedOrigins() {
  const configuredOrigins = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return new Set(configuredOrigins);
}

function isAllowedOrigin(requestOrigin, allowedOrigins) {
  if (!requestOrigin) {
    return false;
  }

  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(requestOrigin)) {
    return true;
  }

  return allowedOrigins.has(requestOrigin);
}

function normalizeText(value, maxLength = 4000) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);
}

function normalizeStringList(value, maxItems = 12) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(value.map((item) => String(item || "").trim()).filter(Boolean)),
  ).slice(0, maxItems);
}

function normalizeValidationStatus(value) {
  return value === "passed" || value === "warning" || value === "missing"
    ? value
    : "warning";
}

function normalizeSuggestedResponseActionType(value) {
  return value === "request-completion" ||
    value === "return-to-reviewer" ||
    value === "escalate-to-supervisor"
    ? value
    : "request-completion";
}

function normalizeDocumentValidations(
  value,
  allowedDocuments,
  fallbackValidations = [],
) {
  const fallbackByName = new Map(
    (Array.isArray(fallbackValidations) ? fallbackValidations : [])
      .filter((item) => item && typeof item.documentName === "string")
      .map((item) => [item.documentName, item]),
  );

  const parsedValidations = Array.isArray(value) ? value : [];
  const parsedByName = new Map();

  for (const item of parsedValidations) {
    if (!item || typeof item.documentName !== "string") {
      continue;
    }

    const mappedName = allowedDocuments.find(
      (documentName) =>
        normalizeArabic(documentName) === normalizeArabic(item.documentName),
    );
    if (!mappedName || parsedByName.has(mappedName)) {
      continue;
    }

    parsedByName.set(mappedName, {
      documentName: mappedName,
      status: normalizeValidationStatus(item.status),
      summary: normalizeText(item.summary, 320),
      details: normalizeStringList(item.details, 8),
      evidenceSnippets: normalizeStringList(item.evidenceSnippets, 3),
      source: "ai",
    });
  }

  return allowedDocuments.map((documentName) => {
    const parsedItem = parsedByName.get(documentName);
    if (parsedItem) {
      return parsedItem;
    }

    const fallbackItem = fallbackByName.get(documentName);
    if (fallbackItem) {
      return {
        documentName,
        status: normalizeValidationStatus(fallbackItem.status),
        summary: normalizeText(fallbackItem.summary, 320),
        details: normalizeStringList(fallbackItem.details, 8),
        evidenceSnippets: normalizeStringList(fallbackItem.evidenceSnippets, 3),
        source: fallbackItem.source === "ai" ? "ai" : "rule",
      };
    }

    return {
      documentName,
      status: "missing",
      summary: `لم يتمكن التحليل من تأكيد وجود ${documentName} داخل الملفات المرفوعة.`,
      details: ["تحتاج هذه الورقة إلى رفع أوضح أو مراجعة بشرية مباشرة."],
      evidenceSnippets: [],
      source: "rule",
    };
  });
}

function normalizeSuggestedResponses(value, maxItems = 6) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        return {
          actionType: "request-completion",
          title: "طلب استكمال",
          text: normalizeText(item, 500),
          rationale: "",
          source: "ai",
        };
      }

      if (!item || typeof item !== "object") {
        return null;
      }

      const text = normalizeText(item.text, 500);
      if (!text) {
        return null;
      }

      return {
        actionType: normalizeSuggestedResponseActionType(item.actionType),
        title: normalizeText(item.title, 120) || "إجراء مقترح",
        text,
        rationale: normalizeText(item.rationale, 240),
        source: "ai",
      };
    })
    .filter(Boolean)
    .slice(0, maxItems);
}

function mapDetectedDocumentsToPolicy(value, requiredDocuments) {
  const candidates = normalizeStringList(value, requiredDocuments.length || 12);
  const normalizedPolicyDocuments = requiredDocuments.map((documentName) => ({
    original: documentName,
    normalized: normalizeArabic(documentName),
  }));

  const mapped = new Set();
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeArabic(candidate);
    const directMatch = normalizedPolicyDocuments.find(
      ({ normalized }) => normalized === normalizedCandidate,
    );
    if (directMatch) {
      mapped.add(directMatch.original);
      continue;
    }

    const fuzzyMatch = normalizedPolicyDocuments.find(
      ({ normalized }) =>
        normalized.includes(normalizedCandidate) ||
        normalizedCandidate.includes(normalized),
    );
    if (fuzzyMatch) {
      mapped.add(fuzzyMatch.original);
    }
  }

  return requiredDocuments.filter((documentName) => mapped.has(documentName));
}

function buildDetectionHints(requiredDocuments) {
  return requiredDocuments.map((documentName) => {
    if (documentName === "المخطط الكهربائي") {
      return {
        documentName,
        aliases: [
          "مخطط كهربائي",
          "مخطط كهرباء",
          "لوحة كهرباء",
          "لوحات كهربائية",
          "كهربائي",
        ],
      };
    }
    if (documentName === "الموقع العام") {
      return {
        documentName,
        aliases: [
          "موقع عام",
          "لوحة الموقع العام",
          "مخطط الموقع",
          "مخطط موقع عام",
          "site plan",
        ],
      };
    }
    if (documentName === "المخطط الإنشائي") {
      return {
        documentName,
        aliases: [
          "مخطط إنشائي",
          "مخطط انشائي",
          "إنشائي",
          "لوحة إنشائية",
          "لوحات إنشائية",
        ],
      };
    }
    if (documentName === "المخططات الميكانيكية") {
      return {
        documentName,
        aliases: [
          "مخططات ميكانيكية",
          "مخطط ميكانيكي",
          "ميكانيكي",
          "لوحات ميكانيكية",
        ],
      };
    }
    if (documentName === "مخطط الأمن والسلامة") {
      return {
        documentName,
        aliases: [
          "الأمن والسلامة",
          "السلامة",
          "مخطط سلامة",
          "خطة السلامة",
          "الدفاع المدني",
        ],
      };
    }
    if (documentName === "نظام البناء المعتمد من إدارة الرخص") {
      return {
        documentName,
        aliases: [
          "نظام البناء المعتمد",
          "نظام البناء",
          "ادارة الرخص",
          "إدارة الرخص",
        ],
      };
    }

    return { documentName, aliases: [] };
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolveSourcePath(sourceReference) {
  if (!sourceReference) {
    return null;
  }

  if (path.isAbsolute(sourceReference)) {
    return existsSync(sourceReference) ? sourceReference : null;
  }

  const resolvedPath = path.resolve(projectRoot, sourceReference);
  const normalizedSourcesRoot = `${sourceAssetsRoot}${path.sep}`;
  const normalizedResolvedPath = `${resolvedPath}${path.sep}`;

  if (
    resolvedPath !== sourceAssetsRoot &&
    !normalizedResolvedPath.startsWith(normalizedSourcesRoot)
  ) {
    return null;
  }

  return existsSync(resolvedPath) ? resolvedPath : null;
}

async function buildSourcePreview(sourceReference, resolvedPath) {
  const extension = path.extname(resolvedPath).toLowerCase();
  const fileName = path.basename(resolvedPath);

  if (extension === ".pdf") {
    return {
      kind: "pdf",
      fileName,
      url: `/api/source-file?path=${encodeURIComponent(sourceReference)}`,
    };
  }

  if (extension === ".docx") {
    const result = await mammoth.convertToHtml({ path: resolvedPath });
    return {
      kind: "html",
      fileName,
      html: `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>body{font-family:Tajawal,sans-serif;padding:24px;line-height:1.9;color:#14251f;background:#fff}p{margin:0 0 14px}table{width:100%;border-collapse:collapse;margin:16px 0}td,th{border:1px solid #d9e2dc;padding:8px;text-align:right}img{max-width:100%;height:auto}</style></head><body>${result.value}</body></html>`,
    };
  }

  if ([".txt", ".md", ".json"].includes(extension)) {
    const rawText = readFileSync(resolvedPath, "utf8");
    return {
      kind: "html",
      fileName,
      html: `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>body{font-family:Tajawal,sans-serif;padding:24px;line-height:1.8;color:#14251f;background:#fff}pre{white-space:pre-wrap;word-break:break-word;background:#f7faf3;border:1px solid #d9e2dc;border-radius:16px;padding:16px}</style></head><body><pre>${escapeHtml(rawText)}</pre></body></html>`,
    };
  }

  return {
    kind: "unsupported",
    fileName,
    message: "المعاينة المباشرة غير متاحة لهذا النوع من الملفات حالياً.",
  };
}

function parseModelJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    const firstBrace = content.indexOf("{");
    const lastBrace = content.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(content.slice(firstBrace, lastBrace + 1));
    }
    throw new Error("The model response was not valid JSON.");
  }
}

function normalizeConfidence(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(numericValue)));
}

function deriveConfidence(parsedConfidence, submission, ruleReview) {
  const baseConfidence = normalizeConfidence(parsedConfidence);
  const criticalFields = [
    submission?.applicantName,
    submission?.officeName,
    submission?.district,
    submission?.plotNumber,
    String(submission?.projectDescription || "").trim().length >= 20
      ? "ok"
      : "",
    Array.isArray(submission?.uploadedAttachments) &&
    submission.uploadedAttachments.length > 0
      ? "ok"
      : "",
  ];

  const criticalCompleteness =
    criticalFields.filter(Boolean).length / criticalFields.length;
  const matchedCount = Array.isArray(ruleReview?.matchedDocuments)
    ? ruleReview.matchedDocuments.length
    : 0;
  const missingCount = Array.isArray(ruleReview?.missingDocuments)
    ? ruleReview.missingDocuments.length
    : 0;
  const documentCoverage =
    matchedCount + missingCount > 0
      ? matchedCount / (matchedCount + missingCount)
      : 0;
  const evidenceCount = Array.isArray(ruleReview?.evidence)
    ? ruleReview.evidence.length
    : 0;
  const evidenceScore = Math.min(1, evidenceCount / 6);
  const ruleScore = Number.isFinite(Number(ruleReview?.score))
    ? Math.max(0, Math.min(100, Number(ruleReview.score)))
    : 0;

  const confidenceCeiling = Math.round(
    criticalCompleteness * 45 +
      documentCoverage * 30 +
      evidenceScore * 10 +
      (ruleScore / 100) * 15,
  );

  if (criticalCompleteness < 0.5) {
    return Math.min(baseConfidence, Math.max(5, confidenceCeiling));
  }

  if (baseConfidence === 0) {
    return confidenceCeiling;
  }

  return Math.min(baseConfidence, confidenceCeiling);
}

async function requestStructuredJson({ client, model, messages }) {
  const completion = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    temperature: 0.2,
    messages,
  });

  return {
    model,
    parsed: parseModelJson(completion.choices[0]?.message?.content || "{}"),
  };
}

export function createReviewApp({
  knowledgeBase = loadKnowledgeBase(projectRoot),
  client = buildClient(process.env.OPENAI_API_KEY),
  reviewModel = process.env.OPENAI_UI_REVIEW_MODEL ||
    process.env.OPENAI_MODEL ||
    DEFAULT_REVIEW_MODEL,
  extractionModel = process.env.OPENAI_UI_EXTRACTION_MODEL ||
    process.env.OPENAI_MODEL ||
    DEFAULT_EXTRACTION_MODEL,
  fallbackModel = process.env.OPENAI_FALLBACK_MODEL || "",
} = {}) {
  const app = express();
  const allowedOrigins = getAllowedOrigins();

  app.use((req, res, next) => {
    const requestOrigin = req.headers.origin;
    if (requestOrigin && isAllowedOrigin(requestOrigin, allowedOrigins)) {
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }

    if (req.method === "OPTIONS") {
      return res.sendStatus(204);
    }

    next();
  });

  app.use(express.json({ limit: "25mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      model: reviewModel,
      reviewModel,
      extractionModel,
      hasApiKey: Boolean(client),
    });
  });

  app.get("/api/source-file", (req, res) => {
    const sourceReference =
      typeof req.query.path === "string" ? req.query.path : "";
    const sourcePath = resolveSourcePath(sourceReference);
    if (!sourceReference || !sourcePath) {
      return res
        .status(400)
        .json({ error: "A valid source path is required." });
    }

    if (path.extname(sourcePath).toLowerCase() !== ".pdf") {
      return res.status(400).json({ error: "Only PDF preview is supported." });
    }

    if (!existsSync(sourcePath)) {
      return res
        .status(404)
        .json({ error: "The requested source file was not found." });
    }

    const fileStat = statSync(sourcePath);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", String(fileStat.size));
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${path.basename(sourcePath)}"`,
    );
    createReadStream(sourcePath).pipe(res);
  });

  app.get("/api/source-preview", async (req, res) => {
    const sourceReference =
      typeof req.query.path === "string" ? req.query.path : "";
    const sourcePath = resolveSourcePath(sourceReference);
    if (!sourceReference || !sourcePath) {
      return res
        .status(404)
        .json({ error: "The requested source file was not found." });
    }

    try {
      const preview = await buildSourcePreview(sourceReference, sourcePath);
      return res.json(preview);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to build source preview.";
      return res.status(500).json({ error: message });
    }
  });

  app.post("/api/extract-attachment", async (req, res) => {
    if (!client) {
      return res.status(503).json({
        error:
          "OPENAI_API_KEY is not configured for the standalone review server.",
      });
    }

    const {
      fileName,
      mimeType,
      localExtractedText,
      requiredDocuments,
      pageImages,
    } = req.body ?? {};
    if (
      !fileName ||
      !Array.isArray(requiredDocuments) ||
      requiredDocuments.length === 0 ||
      !Array.isArray(pageImages) ||
      pageImages.length === 0
    ) {
      return res.status(400).json({
        error: "Missing fileName, requiredDocuments, or pageImages payload.",
      });
    }

    const sanitizedImages = pageImages
      .map((pageImage) => ({
        pageNumber: Number(pageImage?.pageNumber),
        dataUrl:
          typeof pageImage?.dataUrl === "string" ? pageImage.dataUrl : "",
      }))
      .filter(
        (pageImage) =>
          Number.isFinite(pageImage.pageNumber) &&
          /^data:image\/(png|jpeg|jpg|webp);base64,/i.test(pageImage.dataUrl),
      )
      .slice(0, 10);

    if (sanitizedImages.length === 0) {
      return res
        .status(400)
        .json({ error: "At least one valid page image is required." });
    }

    const systemPrompt = [
      "You extract visible document titles and key labels from uploaded engineering permit attachments for Riyadh Municipality.",
      "Respond only with valid JSON.",
      "Use the local extracted text as weak prior context, but correct it using the page images when the OCR is incomplete.",
      "Be conservative and do not claim a required document is present unless the page image or visible labels support it.",
      "Write all user-facing strings in Arabic.",
      "Keep extractedText concise and focused on document names, headings, stamps, and visible sheet titles.",
      "Pay special attention to sheet title blocks and repeated discipline labels such as electrical, structural, mechanical, site plan, safety, and approved building regulation sheets.",
    ].join(" ");

    const normalizedRequiredDocuments = normalizeStringList(
      requiredDocuments,
      40,
    );

    const userPayload = {
      instruction:
        "استخرج النصوص والعناوين الظاهرة التي تساعد على التعرف على نوع المستندات داخل الملف الهندسي. راجع كل صفحة مرفقة بصرياً، وركز على خانة عنوان اللوحة، اسم التخصص، الأختام، ورؤوس الجداول. ثم حدد المستندات المطلوبة التي تظهر بوضوح أو بدلالة قوية في الصفحات. إذا ظهر عنوان قريب من اسم المستند المطلوب فارجعه باسم المستند المطلوب نفسه.",
      outputSchema: {
        extractedText: "string",
        detectedDocuments: "string[] subset of requiredDocuments",
        notes: "string[]",
        confidence: "number 0-100",
      },
      file: {
        fileName,
        mimeType: typeof mimeType === "string" ? mimeType : "",
        localExtractedText: normalizeText(localExtractedText, 5000),
        requiredDocuments: normalizedRequiredDocuments,
        detectionHints: buildDetectionHints(normalizedRequiredDocuments),
      },
      pages: sanitizedImages.map(({ pageNumber }) => ({ pageNumber })),
    };

    const messages = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: JSON.stringify(userPayload) },
          ...sanitizedImages.flatMap(({ pageNumber, dataUrl }) => [
            { type: "text", text: `الصفحة ${pageNumber}` },
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
          ]),
        ],
      },
    ];

    try {
      let completion;
      try {
        completion = await requestStructuredJson({
          client,
          model: extractionModel,
          messages,
        });
      } catch (primaryError) {
        if (!fallbackModel || fallbackModel === extractionModel) {
          throw primaryError;
        }

        completion = await requestStructuredJson({
          client,
          model: fallbackModel,
          messages,
        });
      }

      const { model, parsed } = completion;
      return res.json({
        model,
        confidence: normalizeConfidence(parsed.confidence),
        extractedText: normalizeText(parsed.extractedText, 5000),
        detectedDocuments: mapDetectedDocumentsToPolicy(
          parsed.detectedDocuments,
          normalizedRequiredDocuments,
        ),
        notes: normalizeStringList(parsed.notes, 8),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Attachment extraction failed";
      console.error("extract-attachment failed", {
        extractionModel,
        fallbackModel,
        message,
      });
      return res.status(500).json({ error: message });
    }
  });

  app.post("/api/llm-review", async (req, res) => {
    if (!client) {
      return res.status(503).json({
        error:
          "OPENAI_API_KEY is not configured for the standalone review server.",
      });
    }

    const { policy, submission, ruleReview } = req.body ?? {};
    if (!policy || !submission || !ruleReview) {
      return res
        .status(400)
        .json({ error: "Missing policy, submission, or ruleReview payload." });
    }

    const knowledgeContext = buildKnowledgeContext(
      knowledgeBase,
      policy.id,
      ruleReview.matchedDocuments ?? [],
      ruleReview.missingDocuments ?? [],
      policy.workflow ?? [],
    );
    const trackedDocuments = AI_TRACKED_DOCUMENTS.filter(
      (documentName) =>
        Array.isArray(policy.requiredDocuments) &&
        policy.requiredDocuments.includes(documentName),
    );

    const systemPrompt = [
      "You are an expert municipal engineering license reviewer for Riyadh Municipality.",
      "Respond only with valid JSON.",
      "Base the review strictly on the provided policy knowledge context, workflow evidence, uploaded attachment text, and rule-based review.",
      "Treat the rule-based review as the primary baseline and provide supplemental reasoning, nuance, and risk assessment on top of it.",
      "Do not override deterministic missing-document findings unless the uploaded text clearly supports a correction.",
      "When tracked engineering sheets are requested, evaluate each one directly from the uploaded sheet text and detected sheet titles as the source evidence.",
      "For each tracked sheet, state whether it is missing, present but still needs human review, or sufficiently evidenced by the uploaded sheet content.",
      "For each tracked sheet validation, include one to three short evidence snippets copied or closely paraphrased from the uploaded sheet text.",
      "Suggested responses must be short operational replies that a municipal reviewer can send back to the engineering office, each tagged with an action type.",
      "Write all user-facing strings in Arabic.",
      "Do not invent regulations that are not supported by the provided source excerpts.",
      "Return a conservative recommendation for human approval support, not a legally binding final decision.",
    ].join(" ");

    const userPayload = {
      instruction:
        "قدم مراجعة عربية غنية للمعاملة. حدد القرار، لخص السبب، اذكر أوجه القوة والقصور، اقترح إجراءات عملية، واستشهد فقط بالأدلة المتاحة.",
      outputSchema: {
        model: "string",
        decision: "approve-with-human-check | needs-more-info | reject-for-now",
        confidence: "number 0-100",
        summary: "string",
        reasoning: "string[]",
        missingItems: "string[]",
        risks: "string[]",
        suggestedActions: "string[]",
        documentValidations:
          "Array<{documentName:string, status: passed|warning|missing, summary:string, details:string[], evidenceSnippets:string[]}>",
        suggestedResponses:
          "Array<{actionType: request-completion|return-to-reviewer|escalate-to-supervisor, title:string, text:string, rationale:string}>",
        evidence:
          "Array<{label:string, sourcePath:string, excerpt:string, relevance:string}>",
      },
      policy: {
        id: policy.id,
        title: policy.title,
        references: policy.references,
        requiredDocuments: policy.requiredDocuments,
        workflow: policy.workflow,
        sourcePath: knowledgeContext.sourcePath,
        sourceCitations: knowledgeContext.citations,
      },
      submission: {
        applicantName: submission.applicantName,
        officeName: submission.officeName,
        district: submission.district,
        plotNumber: submission.plotNumber,
        projectDescription: submission.projectDescription,
        comments: submission.comments,
        attachments: compactAttachments(submission.uploadedAttachments ?? []),
      },
      trackedDocuments: trackedDocuments.map((documentName) => ({
        documentName,
        relatedAttachments: compactAttachments(
          (submission.uploadedAttachments ?? []).filter(
            (attachment) =>
              Array.isArray(attachment.detectedDocuments) &&
              attachment.detectedDocuments.includes(documentName),
          ),
        ),
      })),
      ruleReview,
    };

    try {
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPayload) },
      ];

      let completion;
      try {
        completion = await requestStructuredJson({
          client,
          model: reviewModel,
          messages,
        });
      } catch (primaryError) {
        if (!fallbackModel || fallbackModel === reviewModel) {
          throw primaryError;
        }

        completion = await requestStructuredJson({
          client,
          model: fallbackModel,
          messages,
        });
      }

      const { model, parsed } = completion;
      return res.json({
        model,
        generatedAt: new Date().toISOString(),
        decision: parsed.decision,
        confidence: deriveConfidence(parsed.confidence, submission, ruleReview),
        summary: parsed.summary,
        reasoning: parsed.reasoning ?? [],
        missingItems: parsed.missingItems ?? [],
        risks: parsed.risks ?? [],
        suggestedActions: parsed.suggestedActions ?? [],
        documentValidations: normalizeDocumentValidations(
          parsed.documentValidations,
          trackedDocuments,
          ruleReview.documentValidations,
        ),
        suggestedResponses: normalizeSuggestedResponses(
          parsed.suggestedResponses,
        ),
        evidence: Array.isArray(parsed.evidence)
          ? parsed.evidence
          : knowledgeContext.citations,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "LLM review failed";
      console.error("llm-review failed", {
        reviewModel,
        fallbackModel,
        message,
      });
      return res.status(500).json({ error: message });
    }
  });

  if (existsSync(path.join(distRoot, "index.html"))) {
    app.use(express.static(distRoot));
    app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
      res.sendFile(path.join(distRoot, "index.html"));
    });
  }

  return app;
}

export function startReviewServer(port = Number(process.env.PORT) || 8787) {
  loadEnvironment(projectRoot);
  const app = createReviewApp();
  return app.listen(port, () => {
    console.log(
      `LLM review server listening on http://127.0.0.1:${port} using review model ${process.env.OPENAI_UI_REVIEW_MODEL || process.env.OPENAI_MODEL || DEFAULT_REVIEW_MODEL} and extraction model ${process.env.OPENAI_UI_EXTRACTION_MODEL || process.env.OPENAI_MODEL || DEFAULT_EXTRACTION_MODEL}`,
    );
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  startReviewServer(Number(process.env.PORT) || 8787);
}
