import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import express from "express";
import dotenv from "dotenv";
import mammoth from "mammoth";
import OpenAI from "openai";
import knowledgeBaseJson from "../src/data/policyKnowledgeBase.generated.json" with { type: "json" };
import notesForCheckJson from "../src/data/notesForCheck.generated.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(projectRoot, "..");
const sourceAssetsRoot = path.join(projectRoot, "sources");
const distRoot = path.join(projectRoot, "dist");
const DEFAULT_REVIEW_MODEL = "gpt-4o-mini";
const DEFAULT_EXTRACTION_MODEL = "gpt-4o-mini";
const DEFAULT_CAD_CLASSIFIER_MODEL = "gpt-4o-mini";
const DEFAULT_CROSS_MODEL_FALLBACKS = ["gpt-4.1-mini", "gpt-4.1-nano"];
const RATE_LIMIT_RETRY_PADDING_MS = 180;
const DEFAULT_RATE_LIMIT_RETRY_DELAY_MS = 900;
const MAX_RATE_LIMIT_TOTAL_WAIT_MS = 12 * 60 * 1000;
const MAX_RATE_LIMIT_TOTAL_ATTEMPTS = 80;
const AI_TRACKED_DOCUMENTS = [
  "المخططات المعمارية",
  "المخطط الإنشائي",
  "الموقع العام",
  "المخطط الكهربائي",
  "مخطط الأمن والسلامة",
  "المخططات الميكانيكية",
  "نظام البناء المعتمد من إدارة الرخص",
];

const CHECKLIST_DOCUMENT_CATALOG = {
  "صورة بطاقة الأحوال المدنية": "1",
  "صورة الصك": "2",
  "تقرير مساحي في القطاع مع منسوب": "3",
  "صورة جزئية من المخطط التنظيمي": "4",
  اقرارات: "7",
  "إيصال سداد الرسوم": "8",
  "نموذج تدقيق نظام اشتراطات": "9",
  "شهادة الإشغال": "15",
  "صورة جزئية للموقع (كروكي)": "16",
  "إقرار المالك بتنفيذ لائحة الضوابط 9": "21",
  "تعهد المكتب الهندسي المشرف": "22",
  "صورة رخصة البناء": "24",
  "محضر تجزئة": "26",
  "شهادة تحمل": "30",
  "صورة من الوكالة الشرعية": "31",
  "صورة لواجهة المبنى": "34",
  "السجل التجاري": "37",
  "تقرير فني": "44",
  "مخططات الدفاع المدني": "46",
  "المخططات المعمارية": "48",
  "موافقة التربية والتعليم": "60",
  "تعهد المخلفات": "63",
  "عقد اشراف": "64",
  "تقرير دراسة التربة": "69",
  "الرفع المساحي من مكتب هندسي": "70",
  "خطاب توجيه": "76",
  "خطاب موافقة الزراعة": "77",
  "ملاحظات بلدية": "78",
  "الموقع العام": "79",
  "محضر لجنة فنية": "80",
  "المخطط المقترح بعد التعديل": "82",
  "تعهد تنفيذ العزل الحراري": "83",
  "مخطط الوضع القائم": "84",
  "صورة الرخصة القديمة": "86",
  "المخطط المعتمد": "87",
  "خطاب الدفاع المدني": "88",
  "وثيقة التأمين": "98",
  "عقد تفويض المالك للمقاول المنفذ للمشروع": "100",
  "المخطط الكهربائي": "102",
  "المخطط الإنشائي": "103",
  "رخصة هدم": "106",
  "مخططات كفاءة الطاقة": "107",
  "المخططات الميكانيكية": "108",
  "صورة من الطبيعة": "117",
  "عقد الإيجار": "118",
  "شهادة تسجيل وقف": "125",
  "تعهد إغلاق فتحات الخزان": "133",
  "نموذج الواجهات": "135",
};

const modelRateLimitAvailability = new Map();

const CHAT_JSON_VISION_MODEL_PATTERNS = [
  /^gpt-test/i,
  /^gpt-4o(?:-|$)/i,
  /^gpt-4\.1(?:-|$)/i,
  /^gpt-5(?:[.-]|$)/i,
  /^o4-mini(?:-|$)?/i,
];

const CLEARLY_UNSUPPORTED_MODEL_PATTERNS = [
  {
    pattern: /^gpt-image/i,
    reason:
      "هذا نموذج مخصص لتوليد أو تحرير الصور، وليس لمهام JSON النصية أو البصرية في هذا الخادم.",
  },
  {
    pattern: /tts/i,
    reason: "هذا نموذج تحويل نص إلى صوت، ولا يصلح لطلبات JSON الحالية.",
  },
  {
    pattern: /transcribe/i,
    reason: "هذا نموذج تفريغ صوتي، ولا يصلح لطلبات JSON الحالية.",
  },
  {
    pattern: /realtime/i,
    reason: "هذا نموذج وقت حقيقي، وليس الخيار المناسب لنقطة النهاية الحالية.",
  },
  {
    pattern: /embedding/i,
    reason: "هذا نموذج embeddings، ولا يعيد بنية JSON المطلوبة هنا.",
  },
  {
    pattern: /moderation/i,
    reason:
      "هذا نموذج moderation، وليس للمراجعة أو الاستخراج أو الرؤية متعددة الوسائط.",
  },
];

const TASK_MODEL_ROUTING = {
  attachmentValidation: {
    needsTextJson: true,
    needsVisionJson: false,
    strategy: "cheapest-compatible",
    roleOrder: ["extractionModel", "reviewModel", "fallbackModels"],
  },
  attachmentExtractionStandard: {
    needsTextJson: true,
    needsVisionJson: true,
    strategy: "capability-first",
    roleOrder: [
      "extractionModel",
      "cadClassifierModel",
      "reviewModel",
      "fallbackModels",
      "cadCriticalModel",
    ],
  },
  attachmentExtractionCadCritical: {
    needsTextJson: true,
    needsVisionJson: true,
    strategy: "capability-first",
    roleOrder: [
      "cadCriticalModel",
      "reviewModel",
      "extractionModel",
      "fallbackModels",
      "cadClassifierModel",
    ],
  },
  cadPageClassification: {
    needsTextJson: true,
    needsVisionJson: true,
    strategy: "cheapest-compatible",
    roleOrder: [
      "cadClassifierModel",
      "extractionModel",
      "reviewModel",
      "fallbackModels",
      "cadCriticalModel",
    ],
  },
  llmReview: {
    needsTextJson: true,
    needsVisionJson: false,
    strategy: "pinned-primary",
    roleOrder: ["reviewModel", "extractionModel", "fallbackModels"],
  },
};

function getEnvironmentCandidates(root = projectRoot) {
  const currentWorkingDirectory = process.cwd();
  const configuredEnvPath = String(
    process.env.AI_ACCELERATOR_ENV_PATH || "",
  ).trim();

  return [
    path.resolve(root, ".env"),
    path.resolve(root, ".env.local"),
    path.resolve(currentWorkingDirectory, ".env"),
    path.resolve(currentWorkingDirectory, ".env.local"),
    path.resolve(workspaceRoot, "accelerator/.env"),
    path.resolve(workspaceRoot, "accelerator/.env.local"),
    configuredEnvPath,
  ].filter(Boolean);
}

function getModelCapability(modelName) {
  const normalizedModelName = String(modelName || "").trim();

  if (!normalizedModelName) {
    return {
      model: normalizedModelName,
      supportsTextJson: false,
      supportsVisionJson: false,
      reason: "اسم النموذج غير محدد.",
    };
  }

  const unsupportedMatch = CLEARLY_UNSUPPORTED_MODEL_PATTERNS.find(
    ({ pattern }) => pattern.test(normalizedModelName),
  );
  if (unsupportedMatch) {
    return {
      model: normalizedModelName,
      supportsTextJson: false,
      supportsVisionJson: false,
      reason: unsupportedMatch.reason,
    };
  }

  const supportsChatJsonVision = CHAT_JSON_VISION_MODEL_PATTERNS.some(
    (pattern) => pattern.test(normalizedModelName),
  );
  if (supportsChatJsonVision) {
    return {
      model: normalizedModelName,
      supportsTextJson: true,
      supportsVisionJson: true,
      reason: "يدعم مهام النص وJSON والرؤية المطلوبة في هذا الخادم.",
    };
  }

  return {
    model: normalizedModelName,
    supportsTextJson: false,
    supportsVisionJson: false,
    reason:
      "هذا النموذج ليس ضمن العائلات التي تم التحقق منها لهذا الخادم. استخدم gpt-4o* أو gpt-4.1* أو gpt-5* أو o4-mini، أو عرّف نموذج اختبار داخلي.",
  };
}

function getModelHeuristics(modelName) {
  const normalizedModelName = String(modelName || "")
    .trim()
    .toLowerCase();

  if (!normalizedModelName) {
    return {
      costRank: null,
      capabilityRank: null,
    };
  }

  if (/nano/.test(normalizedModelName)) {
    return {
      costRank: 0,
      capabilityRank: 0,
    };
  }

  if (/mini/.test(normalizedModelName)) {
    return {
      costRank: /^o4-mini(?:-|$)?/i.test(normalizedModelName) ? 2 : 1,
      capabilityRank: /^gpt-5/i.test(normalizedModelName) ? 4 : 1,
    };
  }

  if (/^gpt-4o(?:-|$)/i.test(normalizedModelName)) {
    return {
      costRank: 3,
      capabilityRank: 2,
    };
  }

  if (/^gpt-4\.1(?:-|$)/i.test(normalizedModelName)) {
    return {
      costRank: 4,
      capabilityRank: 3,
    };
  }

  if (/^gpt-5(?:-|$)/i.test(normalizedModelName)) {
    return {
      costRank: 5,
      capabilityRank: 5,
    };
  }

  return {
    costRank: null,
    capabilityRank: null,
  };
}

function collectTaskModelEntries(taskConfig, modelAssignments) {
  const entries = [];

  taskConfig.roleOrder.forEach((roleName) => {
    const modelValues = splitModelList(modelAssignments[roleName]);

    modelValues.forEach((modelName) => {
      const normalizedModelName = String(modelName || "").trim();
      if (!normalizedModelName) {
        return;
      }

      entries.push({
        model: normalizedModelName,
        role: roleName,
        sourceOrder: entries.length,
      });
    });
  });

  return Array.from(
    new Map(entries.map((entry) => [entry.model, entry])).values(),
  );
}

function compareByKnownCost(leftEntry, rightEntry) {
  const leftHeuristics = getModelHeuristics(leftEntry.model);
  const rightHeuristics = getModelHeuristics(rightEntry.model);

  if (
    Number.isFinite(leftHeuristics.costRank) &&
    Number.isFinite(rightHeuristics.costRank) &&
    leftHeuristics.costRank !== rightHeuristics.costRank
  ) {
    return leftHeuristics.costRank - rightHeuristics.costRank;
  }

  return leftEntry.sourceOrder - rightEntry.sourceOrder;
}

function compareByCapabilityThenCost(leftEntry, rightEntry) {
  const leftHeuristics = getModelHeuristics(leftEntry.model);
  const rightHeuristics = getModelHeuristics(rightEntry.model);

  if (
    Number.isFinite(leftHeuristics.capabilityRank) &&
    Number.isFinite(rightHeuristics.capabilityRank) &&
    leftHeuristics.capabilityRank !== rightHeuristics.capabilityRank
  ) {
    return rightHeuristics.capabilityRank - leftHeuristics.capabilityRank;
  }

  return compareByKnownCost(leftEntry, rightEntry);
}

function buildTaskModelPlan(taskName, modelAssignments) {
  const taskConfig = TASK_MODEL_ROUTING[taskName];
  if (!taskConfig) {
    throw new Error(`Unknown AI task routing profile: ${taskName}`);
  }

  const compatibleEntries = collectTaskModelEntries(
    taskConfig,
    modelAssignments,
  ).filter((entry) => {
    const capability = getModelCapability(entry.model);
    return (
      (!taskConfig.needsTextJson || capability.supportsTextJson) &&
      (!taskConfig.needsVisionJson || capability.supportsVisionJson)
    );
  });

  const primaryEntries = compatibleEntries.filter(
    (entry) => entry.role !== "fallbackModels",
  );
  const fallbackEntries = compatibleEntries.filter(
    (entry) => entry.role === "fallbackModels",
  );

  const sortEntries = (entries) => {
    if (taskConfig.strategy === "capability-first") {
      return [...entries].sort(compareByCapabilityThenCost);
    }

    return [...entries].sort(compareByKnownCost);
  };

  let sortedPrimaryEntries = sortEntries(primaryEntries);
  if (taskConfig.strategy === "pinned-primary" && primaryEntries.length > 0) {
    const [pinnedPrimaryEntry, ...remainingEntries] = primaryEntries;
    sortedPrimaryEntries = [
      pinnedPrimaryEntry,
      ...sortEntries(remainingEntries),
    ];
  }

  const [selectedPrimaryEntry, ...remainingPrimaryEntries] =
    sortedPrimaryEntries;
  const primaryModel =
    selectedPrimaryEntry?.model ||
    fallbackEntries[0]?.model ||
    modelAssignments.reviewModel;
  const fallbackModels = collectCandidateModels(
    "",
    [
      ...fallbackEntries.map((entry) => entry.model),
      ...remainingPrimaryEntries.map((entry) => entry.model),
    ].filter((modelName) => modelName && modelName !== primaryModel),
  );

  return {
    model: primaryModel,
    primaryModel,
    fallbackModels,
  };
}

function validateModelAssignments({
  reviewModel,
  extractionModel,
  cadClassifierModel,
  cadCriticalModel,
  fallbackModels,
}) {
  const validationChecks = [
    {
      role: "reviewModel",
      model: reviewModel,
      needsTextJson: true,
      needsVisionJson: false,
    },
    {
      role: "extractionModel",
      model: extractionModel,
      needsTextJson: true,
      needsVisionJson: true,
    },
    {
      role: "cadClassifierModel",
      model: cadClassifierModel,
      needsTextJson: true,
      needsVisionJson: true,
    },
    {
      role: "cadCriticalModel",
      model: cadCriticalModel,
      needsTextJson: true,
      needsVisionJson: true,
    },
    ...fallbackModels.map((modelName, index) => ({
      role: `fallbackModels[${index}]`,
      model: modelName,
      needsTextJson: true,
      needsVisionJson: true,
    })),
  ];

  const failures = validationChecks
    .map((check) => {
      const capability = getModelCapability(check.model);
      const missingRequirements = [
        check.needsTextJson && !capability.supportsTextJson
          ? "text+json"
          : null,
        check.needsVisionJson && !capability.supportsVisionJson
          ? "vision+json"
          : null,
      ].filter(Boolean);

      if (missingRequirements.length === 0) {
        return null;
      }

      return `${check.role}=${check.model} يفتقد ${missingRequirements.join(" و ")}. ${capability.reason}`;
    })
    .filter(Boolean);

  if (failures.length > 0) {
    throw new Error(
      `فشل التحقق من توافق النماذج المعرّفة لهذا الخادم: ${failures.join(" ")}`,
    );
  }
}

export function loadEnvironment(root = projectRoot) {
  const attemptedPaths = new Set();

  getEnvironmentCandidates(root).forEach((candidatePath) => {
    const resolvedPath = path.resolve(candidatePath);
    if (attemptedPaths.has(resolvedPath) || !existsSync(resolvedPath)) {
      return;
    }

    attemptedPaths.add(resolvedPath);
    dotenv.config({ path: resolvedPath, override: false });
  });
}

function loadKnowledgeBase(root = projectRoot) {
  return knowledgeBaseJson;
}

function loadNotesForCheckContext() {
  const checklistItems = Array.isArray(notesForCheckJson.checklistItems)
    ? notesForCheckJson.checklistItems
    : [];

  return {
    sourcePath: notesForCheckJson.sourcePath || "src/data/notesForCheck.generated.json",
    fileName: notesForCheckJson.fileName || "notesForCheck.generated.json",
    checklistItems,
  };
}

function classifyNotesForCheckItemKind(sectionName, itemText) {
  const normalizedSection = normalizeArabic(sectionName || "");
  const normalizedItem = normalizeArabic(itemText || "");

  if (
    normalizedSection.includes("مطابقات") ||
    normalizedItem.startsWith("مطابقة ")
  ) {
    return "consistency";
  }

  return "architectural";
}

function normalizeNotesForCheckEntry(entry) {
  if (typeof entry === "string") {
    const text = normalizeText(entry, 220);
    if (!text) {
      return null;
    }

    return {
      sheetName: "Checklist",
      rowNumber: 0,
      section: "Checklist",
      kind: classifyNotesForCheckItemKind("", text),
      text,
    };
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const text = normalizeText(entry.text, 220);
  if (!text) {
    return null;
  }

  const section =
    normalizeText(entry.section || entry.sheetName, 120) || "Checklist";
  return {
    sheetName: normalizeText(entry.sheetName, 120) || "Checklist",
    rowNumber: Number(entry.rowNumber) || 0,
    section,
    kind:
      entry.kind === "consistency" || entry.kind === "architectural"
        ? entry.kind
        : classifyNotesForCheckItemKind(section, text),
    text,
  };
}

function partitionNotesForCheckItems(checklistItems) {
  const normalizedEntries = (
    Array.isArray(checklistItems) ? checklistItems : []
  )
    .map((item) => normalizeNotesForCheckEntry(item))
    .filter(Boolean);

  return {
    allEntries: normalizedEntries,
    architecturalItems: normalizedEntries
      .filter((item) => item.kind === "architectural")
      .map((item) => item.text),
    consistencyItems: normalizedEntries
      .filter((item) => item.kind === "consistency")
      .map((item) => item.text),
  };
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
    detectedDocumentsDetailed: attachment.detectedDocuments.map(
      (documentName) => ({
        number: CHECKLIST_DOCUMENT_CATALOG[documentName] || "",
        title: documentName,
      }),
    ),
    notes: attachment.notes,
    extractedText: String(attachment.extractedText || "").slice(0, 3500),
  }));
}

function resolveSelectedProjectType(policy, submission) {
  const projectTypeGroups = Array.isArray(policy?.projectTypes)
    ? policy.projectTypes
    : [];
  const selectedGroup = projectTypeGroups.find(
    (group) => group.id === submission?.projectTypeGroupId,
  );
  const selectedSubtype = selectedGroup?.subtypes?.find(
    (subtype) => subtype.id === submission?.projectSubtypeId,
  );

  return {
    selectedGroup,
    selectedSubtype,
    availableGroups: projectTypeGroups.map((group) => ({
      id: group.id,
      title: group.title,
      subtypes: Array.isArray(group.subtypes)
        ? group.subtypes.map((subtype) => ({
            id: subtype.id,
            title: subtype.title,
          }))
        : [],
    })),
  };
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

function normalizeAttachmentValidationStatus(value) {
  return value === "passed" || value === "warning" || value === "missing"
    ? value
    : "warning";
}

function normalizeAttachmentChecklistStatus(value) {
  return value === "Compliant" ||
    value === "Non-Compliant" ||
    value === "Not Found"
    ? value
    : "Not Found";
}

function isArchitecturalPlansDocumentCandidate(value) {
  const normalizedValue = normalizeArabic(String(value || ""));
  return (
    normalizedValue.includes(normalizeArabic("المخططات المعمارية")) ||
    normalizedValue.includes(normalizeArabic("مخططات معمارية")) ||
    normalizedValue.includes(normalizeArabic("مخطط معماري"))
  );
}

function normalizeCadPageRelevance(value) {
  return value === "critical" || value === "supporting" || value === "ignore"
    ? value
    : "ignore";
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

function normalizeValueFromSet(value, allowedValues, fallbackValue) {
  return allowedValues.includes(value) ? value : fallbackValue;
}

function normalizeConfidenceLevel(value, confidence = 0) {
  if (value === "High" || value === "Medium" || value === "Low") {
    return value;
  }

  if (confidence >= 75) return "High";
  if (confidence >= 45) return "Medium";
  return "Low";
}

function normalizeIndicDigits(value) {
  return String(value || "").replace(/[٠-٩]/g, (digit) =>
    String(digit.charCodeAt(0) - 1632),
  );
}

function normalizeComparableValue(value) {
  return normalizeArabic(normalizeIndicDigits(value || ""));
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanExtractedFieldValue(value) {
  return normalizeText(
    String(value || "")
      .replace(/^[\s:;،,.\-|]+/u, "")
      .replace(/[\s|]+$/u, ""),
    120,
  );
}

function buildFieldValueRegex(aliases) {
  const aliasPattern = aliases.map((alias) => escapeRegex(alias)).join("|");
  return new RegExp(
    `(?:${aliasPattern})\\s*(?:رقم\\s*)?(?::|：|#|-)?\\s*([^\\n\\r|]{1,100})`,
    "iu",
  );
}

function extractFieldValueFromText(text, aliases) {
  const normalizedText = normalizeIndicDigits(text || "");
  const directMatch = normalizedText.match(buildFieldValueRegex(aliases));
  if (directMatch?.[1]) {
    return cleanExtractedFieldValue(directMatch[1]);
  }

  const lines = normalizedText.split(/\r?\n/);
  for (const line of lines) {
    const normalizedLine = normalizeArabic(line);
    const matchedAlias = aliases.find((alias) =>
      normalizedLine.includes(normalizeArabic(alias)),
    );
    if (!matchedAlias) {
      continue;
    }

    const fallbackMatch = line.match(buildFieldValueRegex([matchedAlias]));
    if (fallbackMatch?.[1]) {
      return cleanExtractedFieldValue(fallbackMatch[1]);
    }

    return cleanExtractedFieldValue(line);
  }

  return "";
}

const DATA_CONSISTENCY_FIELDS = [
  {
    field: "Plot Number",
    aliases: [
      "plot number",
      "plot no",
      "رقم القطعة",
      "رقم قطعه",
      "رقم الارض",
      "رقم الأرض",
      "رقم القسيمة",
    ],
    submissionFallbackKey: "plotNumber",
  },
  {
    field: "Beneficiary Name",
    aliases: [
      "beneficiary name",
      "owner name",
      "applicant name",
      "اسم المستفيد",
      "اسم المالك",
      "المالك",
    ],
    submissionFallbackKey: "applicantName",
  },
  {
    field: "Engineering Office",
    aliases: [
      "engineering office",
      "consultant office",
      "office name",
      "المكتب الهندسي",
      "اسم المكتب",
      "الاستشاري",
    ],
    submissionFallbackKey: "officeName",
  },
  {
    field: "Plan Number",
    aliases: [
      "plan number",
      "plan no",
      "رقم المخطط",
      "المخطط رقم",
      "رقم المخطط التنظيمي",
    ],
  },
  {
    field: "Deed Number",
    aliases: [
      "deed number",
      "deed no",
      "sak number",
      "رقم الصك",
      "الصك رقم",
      "رقم سند الملكية",
    ],
  },
];

function buildExpectedDataConsistencyFields(context) {
  const workbookFields = Array.isArray(context.consistencyCheckItems)
    ? context.consistencyCheckItems
        .map((field) => normalizeText(field, 220))
        .filter(Boolean)
        .map((field) => ({
          field,
          aliases: [],
          workbookDriven: true,
        }))
    : [];

  return [
    ...DATA_CONSISTENCY_FIELDS,
    ...workbookFields.filter(
      (fieldConfig) =>
        !DATA_CONSISTENCY_FIELDS.some(
          (baseField) =>
            normalizeArabic(baseField.field) ===
            normalizeArabic(fieldConfig.field),
        ),
    ),
  ];
}

function findValueInAttachments(attachments, aliases) {
  for (const attachment of attachments) {
    const value = extractFieldValueFromText(attachment.extractedText, aliases);
    if (value) {
      return {
        value,
        sourceRef: attachment.name,
      };
    }
  }

  return null;
}

function buildDataConsistencyRowsFromAttachments(context) {
  const attachments = Array.isArray(context.attachments)
    ? context.attachments
    : [];
  const sakAttachments = attachments.filter((attachment) => {
    const detectedDocuments = Array.isArray(attachment.detectedDocuments)
      ? attachment.detectedDocuments
      : [];
    return (
      attachment.requiredDocument === "صورة الصك" ||
      detectedDocuments.includes("صورة الصك") ||
      normalizeArabic(attachment.name).includes(normalizeArabic("صك"))
    );
  });
  const nonSakAttachments = attachments.filter(
    (attachment) => !sakAttachments.includes(attachment),
  );

  return buildExpectedDataConsistencyFields(context).map((fieldConfig) => {
    if (
      !Array.isArray(fieldConfig.aliases) ||
      fieldConfig.aliases.length === 0
    ) {
      return {
        field: fieldConfig.field,
        sak: "Missing",
        otherDocs: "Missing",
        status: "Missing",
        sourceRefs: [context.notesForCheckPath].filter(Boolean).slice(0, 4),
      };
    }

    const sakMatch = findValueInAttachments(
      sakAttachments,
      fieldConfig.aliases,
    );
    const otherMatch = findValueInAttachments(
      nonSakAttachments,
      fieldConfig.aliases,
    );
    const submissionValue = fieldConfig.submissionFallbackKey
      ? normalizeText(
          context.submission?.[fieldConfig.submissionFallbackKey],
          120,
        )
      : "";
    const otherValue = otherMatch?.value || submissionValue || "Missing";
    const sakValue = sakMatch?.value || "Missing";
    const status =
      sakValue === "Missing" || otherValue === "Missing"
        ? "Missing"
        : normalizeComparableValue(sakValue) ===
            normalizeComparableValue(otherValue)
          ? "Match"
          : "Mismatch";

    return {
      field: fieldConfig.field,
      sak: sakValue,
      otherDocs: otherValue,
      status,
      sourceRefs: [sakMatch?.sourceRef, otherMatch?.sourceRef]
        .filter(Boolean)
        .slice(0, 4),
    };
  });
}

function buildAttachmentAccuracyFallback(context) {
  const attachments = Array.isArray(context.attachments)
    ? context.attachments
    : [];
  const requiredDocuments = Array.isArray(context.requiredDocuments)
    ? context.requiredDocuments
    : [];
  const accuracyNotes = [];
  const mislinkedAttachments = attachments.filter((attachment) => {
    if (!attachment.requiredDocument) {
      return false;
    }

    return !attachment.detectedDocuments.includes(attachment.requiredDocument);
  });
  const unrelatedAttachments = attachments.filter(
    (attachment) =>
      !attachment.requiredDocument &&
      (!Array.isArray(attachment.detectedDocuments) ||
        attachment.detectedDocuments.length === 0),
  );
  const offPolicyAttachments = attachments.filter(
    (attachment) =>
      Array.isArray(attachment.detectedDocuments) &&
      attachment.detectedDocuments.some(
        (documentName) => !requiredDocuments.includes(documentName),
      ),
  );

  mislinkedAttachments.forEach((attachment) => {
    accuracyNotes.push(
      `الملف ${attachment.name} مرفوع تحت ${attachment.requiredDocument} لكن التحليل لم يؤكد مطابقته لهذا المتطلب.`,
    );
  });
  unrelatedAttachments.forEach((attachment) => {
    accuracyNotes.push(
      `الملف ${attachment.name} لم يرتبط بمتطلب واضح وقد يكون غير ذي صلة أو غير مقروء بشكل كاف.`,
    );
  });
  offPolicyAttachments.forEach((attachment) => {
    accuracyNotes.push(
      `الملف ${attachment.name} يحتوي على مؤشرات لمستندات خارج قائمة المتطلبات الحالية.`,
    );
  });

  if (context.missingDocuments.length > 0) {
    accuracyNotes.push(
      `لا يمكن اعتبار الربط كاملاً لأن بعض المرفقات المطلوبة ما زالت ناقصة: ${context.missingDocuments.join("، ")}.`,
    );
  }

  const hasAnyValidAttachment = attachments.some(
    (attachment) =>
      Array.isArray(attachment.detectedDocuments) &&
      attachment.detectedDocuments.some((documentName) =>
        requiredDocuments.includes(documentName),
      ),
  );

  const status =
    accuracyNotes.length === 0
      ? "Valid"
      : hasAnyValidAttachment
        ? "Partially Valid"
        : "Invalid";

  return {
    status,
    notes:
      accuracyNotes.length > 0
        ? accuracyNotes.slice(0, 12)
        : [
            "المرفقات الحالية مرتبطة منطقياً بالصك ونوع المشروع والمتطلبات المطلوبة.",
          ],
  };
}

function buildChecklistEvidenceSources(context) {
  const attachmentSources = (
    Array.isArray(context.attachments) ? context.attachments : []
  ).map((attachment) => ({
    sourceRef:
      normalizeText(attachment?.name, 220) ||
      normalizeText(attachment?.requiredDocument, 220) ||
      "ملف مرفوع",
    text: normalizeText(
      [
        attachment?.name,
        attachment?.requiredDocument,
        ...(Array.isArray(attachment?.detectedDocuments)
          ? attachment.detectedDocuments
          : []),
        ...(Array.isArray(attachment?.notes) ? attachment.notes : []),
        attachment?.extractedText,
      ]
        .filter(Boolean)
        .join("\n"),
      12000,
    ),
  }));

  const inlineSourceText = normalizeText(
    [
      context.fileName,
      context.expectedDocument,
      ...(Array.isArray(context.detectedDocuments)
        ? context.detectedDocuments
        : []),
      ...(Array.isArray(context.notes) ? context.notes : []),
      context.extractedText,
    ]
      .filter(Boolean)
      .join("\n"),
    12000,
  );

  if (inlineSourceText) {
    attachmentSources.push({
      sourceRef: normalizeText(context.fileName, 220) || "الملف الحالي",
      text: inlineSourceText,
    });
  }

  return attachmentSources.filter((source) => source.text);
}

function buildArchitecturalEvidenceText(context) {
  return normalizeArabic(
    [
      context.fileName,
      context.expectedDocument,
      ...(Array.isArray(context.detectedDocuments)
        ? context.detectedDocuments
        : []),
      ...(Array.isArray(context.notes) ? context.notes : []),
      context.extractedText,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function hasPositiveArchitecturalTerm(evidenceText, terms) {
  const normalizedEvidence = normalizeArabic(evidenceText);
  const negationWindowPattern =
    /(لا يوجد|لا توجد|غير موجود|غير واضحة|لم يتم|لم تُرصد|لم ترصد|بدون|من دون|لا يظهر|لا تظهر|لا تذكر|لا يتم)$/;

  return (Array.isArray(terms) ? terms : []).some((term) => {
    const normalizedTerm = normalizeArabic(term);
    if (!normalizedTerm || !normalizedEvidence.includes(normalizedTerm)) {
      return false;
    }

    let searchIndex = normalizedEvidence.indexOf(normalizedTerm);
    while (searchIndex >= 0) {
      const prefix = normalizedEvidence.slice(
        Math.max(0, searchIndex - 28),
        searchIndex,
      );
      if (!negationWindowPattern.test(prefix)) {
        return true;
      }

      searchIndex = normalizedEvidence.indexOf(
        normalizedTerm,
        searchIndex + normalizedTerm.length,
      );
    }

    return false;
  });
}

function hasArchitecturalSemanticEvidence(itemText, context) {
  const normalizedItem = normalizeArabic(itemText);
  const evidenceText = buildArchitecturalEvidenceText(context);
  if (!evidenceText) {
    return false;
  }

  if (normalizedItem === normalizeArabic("الارتدادات النظامية")) {
    return [
      "الارتدادات النظامية",
      "الارتدادات",
      "الارتداد",
      "الارتادات",
      "setback",
      "setbacks",
      "جدول الارتدادات",
      "جدول الارتادات",
    ].some((term) => evidenceText.includes(normalizeArabic(term)));
  }

  if (normalizedItem === normalizeArabic("نسبة البناء")) {
    return [
      "نسبة البناء",
      "نسبة التغطية",
      "coverage ratio",
      "building ratio",
      "جدول المساحات",
      "جدول المسطحات",
      "المسطحات",
      "مسطحات البناء",
    ].some((term) => evidenceText.includes(normalizeArabic(term)));
  }

  if (normalizedItem === normalizeArabic("عدد الأدوار والارتفاع")) {
    return [
      "عدد الأدوار",
      "عدد الطوابق",
      "الدور الأرضي",
      "الدور الاول",
      "الدور الثاني",
      "الدور الثالث",
      "دور ارضي",
      "دور اول",
      "دور ثاني",
      "دور ثالث",
      "ground floor",
      "first floor",
      "first floor plan",
      "second floor",
      "third floor",
      "السطح",
      "section",
      "elevation",
      "منسوب",
      "مقطع",
      "ارتفاع",
    ].some((term) => evidenceText.includes(normalizeArabic(term)));
  }

  if (normalizedItem === normalizeArabic("مساحات الغرف والفراغات")) {
    return [
      "مساحات الغرف",
      "الفراغات الداخلية",
      "توزيع الغرف",
      "جدول الغرف",
      "جدول الفراغات",
      "room schedule",
      "room plan",
      "dimensions",
      "غرفة",
      "غرف",
      "صالة",
      "مجلس",
      "مطبخ",
      "حمام",
      "نوم",
      "فراغ",
    ].some((term) => evidenceText.includes(normalizeArabic(term)));
  }

  if (normalizedItem === normalizeArabic("الاستخدام مطابق للتصنيف")) {
    return [
      "الاستخدام مطابق للتصنيف",
      "مطابقة الاستخدام",
      "توصيف الاستخدام",
      "نوع الاستخدام",
      "الاستخدام السكني",
      "الاستخدام التجاري",
      "usage",
      "occupancy",
      "فيلا",
      "سكني",
      "تجاري",
      "شقق",
      "مبنى سكني",
      "مبنى تجاري",
    ].some((term) => evidenceText.includes(normalizeArabic(term)));
  }

  if (normalizedItem === normalizeArabic("مواقف السيارات")) {
    return [
      "مواقف السيارات",
      "مواقف",
      "parking",
      "garage",
      "كراج",
      "مدخل سيارة",
      "منحدر سيارات",
      "مواقف مرسومة",
      "صف مواقف",
    ].some((term) => evidenceText.includes(normalizeArabic(term)));
  }

  if (normalizedItem.includes(normalizeArabic("متطلبات ذوي الإعاقة"))) {
    return hasPositiveArchitecturalTerm(evidenceText, [
      "ذوي الإعاقة",
      "ذوي الاعاقة",
      "كرسي متحرك",
      "wheelchair",
      "accessible ramp",
      "accessible parking",
      "disabled parking",
      "دورة مياه لذوي الإعاقة",
      "منحدر ذوي الإعاقة",
    ]);
  }

  return false;
}

function buildArchitecturalChecklistGuidance(items) {
  const guidanceByItem = new Map([
    [
      "الارتدادات النظامية",
      {
        aliases: [
          "الارتدادات النظامية",
          "الارتدادات",
          "الارتداد",
          "الارتادات",
          "setback",
          "setbacks",
          "جدول الارتدادات",
          "جدول الارتداد",
          "جدول الارتادات",
        ],
        hints: [
          "جدول الارتدادات",
          "جدول الارتادات",
          "الارتدادات النظامية",
          "setback line",
          "setback table",
        ],
      },
    ],
    [
      "نسبة البناء",
      {
        aliases: [
          "نسبة البناء",
          "نسبة التغطية",
          "coverage ratio",
          "building ratio",
          "جدول المساحات",
          "مسطحات البناء",
          "المسطحات",
          "جدول المسطحات",
        ],
        hints: [
          "جدول المساحات",
          "جدول المسطحات",
          "coverage ratio",
          "building ratio",
        ],
      },
    ],
    [
      "عدد الأدوار والارتفاع",
      {
        aliases: [
          "عدد الأدوار والارتفاع",
          "عدد الأدوار",
          "عدد الطوابق",
          "الارتفاع",
          "الارتفاعات",
          "المنسوب",
          "المناسيب",
          "دور أرضي",
          "دور أول",
          "دور ثاني",
          "دور ثالث",
          "مقطع",
          "section",
          "elevation",
        ],
        hints: [
          "عدد الأدوار",
          "الدور الأرضي",
          "الدور الأول",
          "مقطع",
          "elevation",
          "section",
        ],
      },
    ],
    [
      "مساحات الغرف والفراغات",
      {
        aliases: [
          "مساحات الغرف والفراغات",
          "مساحات الغرف",
          "الفراغات",
          "الفراغات الداخلية",
          "جدول الغرف",
          "جدول الفراغات",
          "جدول الفراغات الداخلية",
          "توزيع الغرف",
          "توزيع الفراغات",
          "room schedule",
          "room schedules",
          "room spaces",
          "room plan",
          "room plans",
          "schedule of rooms",
          "internal spaces",
          "dimensions",
          "space schedule",
        ],
        hints: [
          "جدول الغرف",
          "الفراغات الداخلية",
          "توزيع الغرف",
          "جدول الفراغات",
          "جدول الفراغات الداخلية",
          "room schedule",
          "dimensions",
        ],
      },
    ],
    [
      "الاستخدام مطابق للتصنيف",
      {
        aliases: [
          "الاستخدام مطابق للتصنيف",
          "مطابقة الاستخدام",
          "تصنيف الاستخدام",
          "الاستخدام",
          "الاستعمال",
          "توصيف الاستخدام",
          "نوع الاستخدام",
          "وصف الاستخدام",
          "occupancy",
          "usage",
          "السكني",
          "التجاري",
          "فيلا",
          "شقق",
          "مبنى سكني",
          "مبنى تجاري",
          "توصيف الاستخدام",
        ],
        hints: [
          "السكني",
          "التجاري",
          "التصنيف",
          "توصيف الاستخدام",
          "نوع الاستخدام",
          "occupancy",
        ],
      },
    ],
    [
      "مواقف السيارات",
      {
        aliases: [
          "مواقف السيارات",
          "مواقف",
          "موقف سيارة",
          "مواقف سيارات",
          "parking",
          "parking bay",
          "parking bays",
          "parking stall",
          "parking stalls",
          "car park",
          "car parking",
          "garage",
          "موقف",
          "مواقف مرسومة",
          "صف مواقف",
          "موقفين",
          "ثلاث مواقف",
          "مدخل سيارة",
          "ramps",
          "ramp",
          "منحدر سيارات",
          "كراج",
        ],
        hints: ["مواقف مرسومة", "parking bay", "garage", "منحدر سيارات"],
      },
    ],
    [
      "متطلبات ذوي الإعاقة (إن وجد)",
      {
        aliases: [
          "متطلبات ذوي الإعاقة",
          "ذوي الإعاقة",
          "ذوي الاعاقة",
          "إعاقة",
          "اعاقة",
          "كرسي متحرك",
          "wheelchair",
          "منحدر ذوي الإعاقة",
          "منحدر ذوي الاعاقة",
          "رامب ذوي الإعاقة",
          "رامب ذوي الاعاقة",
          "accessible ramp",
          "دورة مياه لذوي الإعاقة",
          "دورة مياه لذوي الاعاقة",
          "حمام ذوي الإعاقة",
          "حمام ذوي الاعاقة",
          "disabled parking",
          "accessible parking",
        ],
        hints: ["منحدر ذوي الإعاقة", "wheelchair", "accessible ramp"],
      },
    ],
  ]);

  return (Array.isArray(items) ? items : []).map((item) => ({
    item,
    aliases: guidanceByItem.get(item)?.aliases || [item],
    hints: guidanceByItem.get(item)?.hints || [item],
  }));
}

function findArchitecturalChecklistKey(value, guidance) {
  const normalizedValue = normalizeArabic(String(value || ""));
  if (!normalizedValue) {
    return "";
  }

  for (const entry of Array.isArray(guidance) ? guidance : []) {
    const aliasMatch = (Array.isArray(entry.aliases) ? entry.aliases : []).some(
      (alias) => {
        const normalizedAlias = normalizeArabic(String(alias || ""));
        return (
          normalizedAlias &&
          (normalizedValue === normalizedAlias ||
            normalizedValue.includes(normalizedAlias) ||
            normalizedAlias.includes(normalizedValue))
        );
      },
    );

    if (aliasMatch) {
      return entry.item;
    }
  }

  return "";
}

function buildArchitecturalChecklistFallback(itemText, context) {
  const normalizedItem = normalizeArabic(itemText);
  const normalizedSetbacks = normalizeArabic("الارتدادات النظامية");
  const normalizedBuildingRatio = normalizeArabic("نسبة البناء");
  const normalizedFloorHeight = normalizeArabic("عدد الأدوار والارتفاع");
  const normalizedRoomSpaces = normalizeArabic("مساحات الغرف والفراغات");
  const normalizedParking = normalizeArabic("مواقف السيارات");
  const normalizedUsage = normalizeArabic("الاستخدام مطابق للتصنيف");
  const normalizedAccessibility = normalizeArabic("متطلبات ذوي الإعاقة");

  let evidenceTerms = [];
  let matchedComment = "";

  if (normalizedItem === normalizedSetbacks) {
    evidenceTerms = [
      "الارتدادات النظامية",
      "الارتدادات",
      "الارتداد",
      "setback",
      "setbacks",
    ].map((term) => normalizeArabic(term));
  } else if (normalizedItem === normalizedBuildingRatio) {
    evidenceTerms = [
      "نسبة البناء",
      "نسبه البناء",
      "جدول المساحات",
      "جدول المساحه",
      "مسطحات البناء",
      "مساحات البناء",
      "building ratio",
      "coverage ratio",
    ].map((term) => normalizeArabic(term));
  } else if (normalizedItem === normalizedFloorHeight) {
    evidenceTerms = [
      "عدد الأدوار",
      "عدد الادوار",
      "عدد الطوابق",
      "الأدوار",
      "الادوار",
      "الطوابق",
      "الدور الأرضي",
      "الدور الارضي",
      "الدور الأول",
      "الدور الاول",
      "الدور الثاني",
      "الدور الثالث",
      "دور أرضي",
      "دور أول",
      "دور ثاني",
      "دور ثالث",
      "ارتفاع المبنى",
      "ارتفاع",
      "مناسيب",
      "منسوب",
      "section",
      "elevation",
      "مقطع",
      "floors",
      "storeys",
      "stories",
    ].map((term) => normalizeArabic(term));
  } else if (normalizedItem === normalizedRoomSpaces) {
    evidenceTerms = [
      "مساحات الغرف",
      "مساحات",
      "الفراغات الداخلية",
      "الفراغات",
      "توزيع الغرف",
      "توزيع الفراغات",
      "جدول الغرف",
      "جدول الفراغات",
      "جدول الفراغات الداخلية",
      "غرف النوم",
      "غرفة النوم",
      "صالة",
      "مجلس",
      "مطبخ",
      "دورة مياه",
      "حمام",
      "غرفة",
      "غرف",
      "الفراغات",
      "room schedule",
      "room schedules",
      "room spaces",
      "room plan",
      "room plans",
      "schedule of rooms",
      "internal spaces",
      "space schedule",
      "dimensions",
      "ابعاد",
    ].map((term) => normalizeArabic(term));
  } else if (normalizedItem === normalizedParking) {
    evidenceTerms = [
      "مواقف السيارات",
      "مواقف",
      "موقف سيارة",
      "مواقف سيارات",
      "parking",
      "parking bay",
      "parking bays",
      "parking stall",
      "parking stalls",
      "car park",
      "car parking",
      "garage",
      "موقف",
      "مواقف مرسومة",
      "صف مواقف",
      "موقفين",
      "ثلاث مواقف",
      "مدخل سيارة",
      "ramps",
      "ramp",
      "منحدر سيارات",
      "كراج",
    ].map((term) => normalizeArabic(term));
  } else if (normalizedItem === normalizedUsage) {
    evidenceTerms = [
      "الاستخدام مطابق للتصنيف",
      "مطابقة الاستخدام",
      "تصنيف الاستخدام",
      "الاستخدام",
      "التصنيف",
      "توصيف الاستخدام",
      "نوع الاستخدام",
      "وصف الاستخدام",
      "occupancy",
      "usage",
      "سكني",
      "تجاري",
      "فيلا",
      "شقق",
      "مبنى سكني",
      "مبنى تجاري",
      "استعمال",
      "السكني",
      "التجاري",
    ].map((term) => normalizeArabic(term));
  } else if (normalizedItem.includes(normalizedAccessibility)) {
    evidenceTerms = [
      "ذوي الإعاقة",
      "ذوي الاعاقة",
      "إعاقة",
      "اعاقة",
      "كرسي متحرك",
      "wheelchair",
      "منحدر ذوي الإعاقة",
      "منحدر ذوي الاعاقة",
      "رامب ذوي الإعاقة",
      "رامب ذوي الاعاقة",
      "accessible ramp",
      "دورة مياه لذوي الإعاقة",
      "دورة مياه لذوي الاعاقة",
      "حمام ذوي الإعاقة",
      "حمام ذوي الاعاقة",
      "disabled parking",
      "accessible parking",
    ].map((term) => normalizeArabic(term));
  } else {
    return null;
  }

  const evidenceSources = buildChecklistEvidenceSources(context).filter(
    (source) => {
      const normalizedSourceText = normalizeArabic(source.text);
      return evidenceTerms.some((term) => normalizedSourceText.includes(term));
    },
  );

  if (evidenceSources.length === 0) {
    return null;
  }

  const sourceRefs = Array.from(
    new Set(evidenceSources.map((source) => source.sourceRef).filter(Boolean)),
  ).slice(0, 4);
  const setbackEvidence = evidenceSources.some((source) => {
    const normalizedSourceText = normalizeArabic(source.text);
    return [
      normalizeArabic("الارتدادات النظامية"),
      normalizeArabic("الارتدادات"),
      normalizeArabic("الارتداد"),
      normalizeArabic("الارتادات"),
      normalizeArabic("setback"),
      normalizeArabic("setbacks"),
    ].some((term) => normalizedSourceText.includes(term));
  });
  const areaScheduleEvidence = evidenceSources.some((source) =>
    normalizeArabic(source.text).includes(normalizeArabic("جدول المساحات")),
  );
  const parkingLayoutEvidence = evidenceSources.some((source) => {
    const normalizedSourceText = normalizeArabic(source.text);
    return [
      normalizeArabic("parking"),
      normalizeArabic("parking bay"),
      normalizeArabic("parking stall"),
      normalizeArabic("مواقف"),
      normalizeArabic("موقف سيارة"),
      normalizeArabic("كراج"),
      normalizeArabic("مدخل سيارة"),
    ].some((term) => normalizedSourceText.includes(term));
  });
  const accessibilityEvidence = evidenceSources.some((source) => {
    return hasPositiveArchitecturalTerm(source.text, [
      "ذوي الإعاقة",
      "ذوي الاعاقة",
      "كرسي متحرك",
      "wheelchair",
      "accessible",
      "منحدر ذوي الإعاقة",
      "منحدر ذوي الاعاقة",
      "دورة مياه لذوي الإعاقة",
      "دورة مياه لذوي الاعاقة",
      "accessible ramp",
      "disabled parking",
      "accessible parking",
    ]);
  });

  if (normalizedItem === normalizedSetbacks) {
    matchedComment = setbackEvidence
      ? "تظهر الارتدادات النظامية بوضوح في اللوحات المتاحة."
      : "تم رصد مؤشر صريح على الارتدادات النظامية داخل الملف أو الملفات الحالية.";
  } else if (normalizedItem === normalizedBuildingRatio) {
    matchedComment = areaScheduleEvidence
      ? "تم رصد جدول المساحات ويُستخدم كمرجع مباشر للتحقق من نسبة البناء في الملف أو الملفات الحالية."
      : "تم رصد مؤشر صريح على نسبة البناء داخل الملف أو الملفات الحالية.";
  } else if (normalizedItem === normalizedFloorHeight) {
    matchedComment = "تم رصد عدد الأدوار أو الارتفاع أو مؤشرات مثل منسوب أو مقطع بشكل صريح داخل الملف أو الملفات الحالية.";
  } else if (normalizedItem === normalizedRoomSpaces) {
    matchedComment = "تم رصد مساحات الغرف والفراغات أو جدول الغرف أو توصيف قريب للفراغات بشكل صريح داخل الملف أو الملفات الحالية.";
  } else if (normalizedItem === normalizedParking) {
    matchedComment = parkingLayoutEvidence
      ? "تم رصد توزيع أو رموز مواقف سيارات داخل المخطط ويُعتمد ذلك كدليل على تحقق بند مواقف السيارات حتى لو لم يظهر العنوان نصاً."
      : "تم رصد مؤشر صريح على مواقف السيارات داخل الملف أو الملفات الحالية.";
  } else if (normalizedItem === normalizedUsage) {
    matchedComment = "تم رصد الاستخدام أو توصيف الاستخدام أو نوعه بشكل صريح داخل الملف أو الملفات الحالية.";
  } else {
    matchedComment = accessibilityEvidence
      ? "تم رصد متطلبات واضحة لذوي الإعاقة داخل المخطط، لذلك يمكن ذكر هذا البند لأنه ظاهر في الملف الحالي."
      : "تم رصد مؤشر صريح على متطلبات ذوي الإعاقة داخل الملف أو الملفات الحالية.";
  }

  return {
    item: itemText,
    status: "Compliant",
    comment: matchedComment,
    sourceRefs,
  };
}

function buildChecklistRows(parsedRows, context) {
  const rowsByItem = new Map();
  const guidance = buildArchitecturalChecklistGuidance(
    context.notesForCheckItems,
  );

  (Array.isArray(parsedRows) ? parsedRows : []).forEach((row) => {
    const itemText = normalizeText(row?.item, 220);
    if (!itemText) {
      return;
    }

    const canonicalItem =
      findArchitecturalChecklistKey(itemText, guidance) || itemText;

    rowsByItem.set(normalizeArabic(canonicalItem), {
      item: canonicalItem,
      status: normalizeAttachmentChecklistStatus(row?.status),
      comment:
        normalizeText(row?.comment, 320) ||
        "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
    });
  });

  return (
    Array.isArray(context.notesForCheckItems) ? context.notesForCheckItems : []
  ).map((itemText) => {
    const matched = rowsByItem.get(normalizeArabic(itemText));
    const fallback = buildArchitecturalChecklistFallback(itemText, context);
    const strongEvidence = hasArchitecturalSemanticEvidence(itemText, context);

    if (
      matched &&
      normalizeArabic(itemText).includes(
        normalizeArabic("متطلبات ذوي الإعاقة"),
      ) &&
      !strongEvidence
    ) {
      return {
        item: itemText,
        status: "Not Found",
        comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
        sourceRefs: [context.notesForCheckPath].filter(Boolean),
      };
    }

    if (matched && matched.status !== "Not Found") {
      return {
        ...matched,
        sourceRefs: [context.notesForCheckPath].filter(Boolean),
      };
    }

    if (strongEvidence) {
      return {
        item: itemText,
        status: "Compliant",
        comment:
          normalizeText(fallback?.comment, 320) ||
          "تم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
        sourceRefs: fallback?.sourceRefs ?? [context.notesForCheckPath].filter(Boolean),
      };
    }

    if (fallback) {
      return {
        item: fallback.item,
        status: "Compliant",
        comment:
          normalizeText(fallback.comment, 320) ||
          "تم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
        sourceRefs: fallback.sourceRefs,
      };
    }

    return {
      item: itemText,
      status: "Not Found",
      comment: "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
      sourceRefs: [context.notesForCheckPath].filter(Boolean),
    };
  });
}

function buildArchitecturalValidationSummary(checklistResults) {
  const results = Array.isArray(checklistResults) ? checklistResults : [];
  const compliantCount = results.filter(
    (row) => row.status === "Compliant",
  ).length;
  const notFoundCount = results.filter((row) => row.status === "Not Found").length;

  if (compliantCount === 0) {
    return "تم التعرف على المخططات المعمارية، لكن النص المستخرج لا يكفي لإثبات البنود التفصيلية المطلوبة.";
  }

  return `تم التعرف على المخططات المعمارية، وظهر ${compliantCount} بنداً بدليل صريح بينما بقي ${notFoundCount} بنداً غير مثبت من النص المستخرج.`;
}

function buildArchitecturalValidationFeedback(checklistResults) {
  const results = Array.isArray(checklistResults) ? checklistResults : [];
  const feedback = [];

  const titleFeedback =
    "تم التعرف على المخططات المعمارية بشكل واضح من الملف المرفوع.";
  feedback.push(titleFeedback);

  const highSignalRows = results.filter((row) => row.status === "Compliant");
  if (highSignalRows.length > 0) {
    feedback.push(
      `البنود المثبتة صراحة: ${highSignalRows
        .slice(0, 4)
        .map((row) => row.item)
        .join("، ")}.`,
    );
  }

  const missingRows = results.filter((row) => row.status !== "Compliant");
  if (missingRows.length > 0) {
    feedback.push(
      `البنود غير المثبتة بوضوح: ${missingRows
        .slice(0, 4)
        .map((row) => row.item)
        .join("، ")}.`,
    );
  }

  return feedback.slice(0, 6);
}

function buildRequirementsComplianceStatus(checklistRows, context) {
  const hasArchitecturalAttachment = (
    Array.isArray(context.attachments) ? context.attachments : []
  ).some(
    (attachment) =>
      Array.isArray(attachment.detectedDocuments) &&
      attachment.detectedDocuments.includes("المخططات المعمارية"),
  );

  if (!hasArchitecturalAttachment) {
    return "Not Compliant";
  }

  return checklistRows.every((row) => row.status === "Compliant")
    ? "Compliant"
    : "Not Compliant";
}

function buildFinalSummaryFallback(context, derivedReport) {
  const derivedMissingDocuments = derivedReport.attachmentsStatus.rows
    .filter((row) => row.status === "Missing")
    .map((row) => row.attachment);
  const missingDocumentsText =
    derivedMissingDocuments.length > 0
      ? `مفقود (${derivedMissingDocuments.join("، ")})`
      : "مكتمل";
  const dataConsistencyState = derivedReport.dataConsistencyCheck.every(
    (row) => row.status === "Match",
  )
    ? "متطابق"
    : derivedReport.dataConsistencyCheck.some(
          (row) => row.status === "Mismatch",
        )
      ? "غير متطابق"
      : "مفقود";

  return {
    attachments: missingDocumentsText,
    dataConsistency: dataConsistencyState,
    architecturalCompliance:
      derivedReport.architecturalCompliance.requirementsCompliance ===
      "Compliant"
        ? "متوافق"
        : "غير متوافق",
    keyIssues: Array.from(
      new Set([
        ...context.missingDocuments.map(
          (documentName) => `${documentName}: هذا المرفق مفقود ويجب استكماله.`,
        ),
        ...derivedMissingDocuments.map(
          (documentName) => `${documentName}: هذا المرفق مفقود ويجب استكماله.`,
        ),
        ...derivedReport.attachmentAccuracy.notes,
        ...derivedReport.architecturalCompliance.violations,
      ]),
    ).slice(0, 12),
  };
}

function normalizeComplianceReport(parsedReport, context) {
  const report =
    parsedReport && typeof parsedReport === "object" ? parsedReport : {};
  const fallbackProjectType =
    context.projectSubtypeTitle || context.projectTypeGroupTitle || "غير محدد";

  const attachmentRows = Array.isArray(report.attachmentsStatus?.rows)
    ? report.attachmentsStatus.rows
    : [];
  const attachmentDocumentSet = new Set(
    (Array.isArray(context.attachments) ? context.attachments : []).flatMap(
      (attachment) => {
        const detected = Array.isArray(attachment.detectedDocuments)
          ? attachment.detectedDocuments
          : [];
        return attachment.requiredDocument
          ? [...detected, attachment.requiredDocument]
          : detected;
      },
    ),
  );
  const normalizedAttachmentRows = context.requiredDocuments.map(
    (documentName) => {
      const matchedRow = attachmentRows.find(
        (row) =>
          row &&
          typeof row.attachment === "string" &&
          normalizeArabic(row.attachment) === normalizeArabic(documentName),
      );
      const ruleMatched = context.matchedDocuments.includes(documentName);
      const ruleMissing =
        context.missingDocuments.includes(documentName) ||
        (!ruleMatched && !attachmentDocumentSet.has(documentName));

      return {
        attachment: documentName,
        status: normalizeValueFromSet(
          matchedRow?.status,
          ["Present", "Missing", "Invalid / Unclear"],
          ruleMatched
            ? "Present"
            : ruleMissing
              ? "Missing"
              : "Invalid / Unclear",
        ),
        notes:
          normalizeText(matchedRow?.notes, 320) ||
          (ruleMissing
            ? "هذا المرفق مفقود ويجب استكماله."
            : ruleMatched
              ? "تم رصد هذا المرفق ضمن الملفات المرفوعة."
              : "تعذر التحقق من هذا المرفق بوضوح من الملفات المرفوعة."),
        sourceRefs: normalizeStringList(matchedRow?.sourceRefs, 4),
      };
    },
  );

  const normalizedConsistencyRows = buildExpectedDataConsistencyFields(
    context,
  ).map((fieldConfig) => {
    const matchedRow = Array.isArray(report.dataConsistencyCheck)
      ? report.dataConsistencyCheck.find(
          (row) =>
            row &&
            typeof row.field === "string" &&
            normalizeArabic(row.field) === normalizeArabic(fieldConfig.field),
        )
      : null;
    const fallbackRow = buildDataConsistencyRowsFromAttachments(context).find(
      (row) =>
        normalizeArabic(row.field) === normalizeArabic(fieldConfig.field),
    );

    return {
      field: fieldConfig.field,
      sak: normalizeText(matchedRow?.sak, 160) || fallbackRow?.sak || "مفقود",
      otherDocs:
        normalizeText(matchedRow?.otherDocs, 160) ||
        fallbackRow?.otherDocs ||
        "مفقود",
      status: normalizeValueFromSet(
        matchedRow?.status,
        ["Match", "Mismatch", "Missing"],
        fallbackRow?.status || "Missing",
      ),
      sourceRefs:
        normalizeStringList(matchedRow?.sourceRefs, 4).length > 0
          ? normalizeStringList(matchedRow?.sourceRefs, 4)
          : fallbackRow?.sourceRefs || [],
    };
  });

  const normalizedChecklistRows = buildChecklistRows(
    report.architecturalCompliance?.notesForCheck,
    context,
  );

  const attachmentAccuracyFallback = buildAttachmentAccuracyFallback(context);
  const normalizedAttachmentAccuracy = {
    status: normalizeValueFromSet(
      report.attachmentAccuracy?.status,
      ["Valid", "Invalid", "Partially Valid"],
      attachmentAccuracyFallback.status,
    ),
    notes: (() => {
      const parsedNotes = normalizeStringList(
        report.attachmentAccuracy?.notes,
        12,
      );
      return parsedNotes.length > 0
        ? parsedNotes
        : attachmentAccuracyFallback.notes;
    })(),
  };

  const normalizedArchitecturalCompliance = {
    requirementsCompliance: normalizeValueFromSet(
      report.architecturalCompliance?.requirementsCompliance,
      ["Compliant", "Not Compliant"],
      buildRequirementsComplianceStatus(normalizedChecklistRows, context),
    ),
    notesForCheck: normalizedChecklistRows,
    violations: (() => {
      const parsedViolations = normalizeStringList(
        report.architecturalCompliance?.violations,
        24,
      );
      if (parsedViolations.length > 0) {
        return parsedViolations;
      }

      const derivedViolations = normalizedChecklistRows
        .filter((row) => row.status !== "Compliant")
        .map(
          (row) =>
            `${row.item}: ${row.comment || "البند غير مطابق أو غير موجود بوضوح في الملفات الحالية."}`,
        );

      return derivedViolations.slice(0, 24);
    })(),
  };

  const overallStatus = normalizedAttachmentRows.every(
    (row) => row.status === "Present",
  )
    ? "مكتمل"
    : "غير مكتمل";

  const derivedReport = {
    projectInformation: {
      projectType:
        normalizeText(report.projectInformation?.projectType, 120) ||
        fallbackProjectType,
      confidenceLevel: normalizeConfidenceLevel(
        report.projectInformation?.confidenceLevel,
        context.confidence,
      ),
    },
    attachmentsStatus: {
      overallStatus: normalizeValueFromSet(
        report.attachmentsStatus?.overallStatus,
        ["Complete", "Incomplete"],
        overallStatus,
      ),
      rows: normalizedAttachmentRows,
    },
    dataConsistencyCheck: normalizedConsistencyRows,
    attachmentAccuracy: normalizedAttachmentAccuracy,
    architecturalCompliance: normalizedArchitecturalCompliance,
  };

  const finalSummaryFallback = buildFinalSummaryFallback(
    context,
    derivedReport,
  );

  return {
    ...derivedReport,
    finalSummary: {
      attachments:
        normalizeText(report.finalSummary?.attachments, 220) ||
        finalSummaryFallback.attachments,
      dataConsistency:
        normalizeText(report.finalSummary?.dataConsistency, 220) ||
        finalSummaryFallback.dataConsistency,
      architecturalCompliance:
        normalizeText(report.finalSummary?.architecturalCompliance, 220) ||
        finalSummaryFallback.architecturalCompliance,
      keyIssues: (() => {
        const parsedIssues = normalizeStringList(
          report.finalSummary?.keyIssues,
          12,
        );
        return parsedIssues.length > 0
          ? parsedIssues
          : finalSummaryFallback.keyIssues;
      })(),
    },
  };
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
  const text = String(content || "").trim();
  if (!text) {
    throw new Error("The model response was not valid JSON.");
  }

  const attempts = [];
  attempts.push(text);

  const fencedMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fencedMatch?.[1]) {
    attempts.push(fencedMatch[1].trim());
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    attempts.push(text.slice(firstBrace, lastBrace + 1).trim());
  }

  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    attempts.push(text.slice(firstBracket, lastBracket + 1).trim());
  }

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }

  const scanForJson = (openChar, closeChar) => {
    const openPositions = [];
    let inString = false;
    let escaped = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === openChar) {
        openPositions.push(index);
        continue;
      }

      if (char === closeChar && openPositions.length > 0) {
        const start = openPositions.pop();
        if (openPositions.length === 0 && start !== undefined) {
          return text.slice(start, index + 1);
        }
      }
    }

    return "";
  };

  const scannedObject = scanForJson("{", "}");
  if (scannedObject) {
    try {
      return JSON.parse(scannedObject);
    } catch {
      // Fall through to the final error.
    }
  }

  const scannedArray = scanForJson("[", "]");
  if (scannedArray) {
    try {
      return JSON.parse(scannedArray);
    } catch {
      // Fall through to the final error.
    }
  }

  throw new Error("The model response was not valid JSON.");
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

async function requestStructuredJson({
  client,
  model,
  messages,
  fallbackModels = [],
}) {
  const candidateModels = collectCandidateModels(model, fallbackModels);
  let lastError;
  const blockedModels = new Set();

  const startedAt = Date.now();
  let attemptCount = 0;

  while (attemptCount < MAX_RATE_LIMIT_TOTAL_ATTEMPTS) {
    const candidateModel = selectCandidateModel(candidateModels, blockedModels);
    if (!candidateModel) {
      break;
    }

    const remainingWaitBudgetMs =
      MAX_RATE_LIMIT_TOTAL_WAIT_MS - (Date.now() - startedAt);
    if (remainingWaitBudgetMs <= 0) {
      break;
    }

    const waitForModelMs = getModelWaitTime(candidateModel);
    if (waitForModelMs > 0) {
      await wait(Math.min(waitForModelMs, remainingWaitBudgetMs));
      if (Date.now() - startedAt >= MAX_RATE_LIMIT_TOTAL_WAIT_MS) {
        break;
      }
    }

    attemptCount += 1;

    try {
      const completion = await client.chat.completions.create({
        model: candidateModel,
        response_format: { type: "json_object" },
        temperature: 0.2,
        messages,
      });

      clearModelRateLimit(candidateModel);

      return {
        model: candidateModel,
        parsed: parseModelJson(completion.choices[0]?.message?.content || "{}"),
      };
    } catch (error) {
      lastError = error;
      if (shouldSkipModelAfterError(error)) {
        blockedModels.add(candidateModel);
        continue;
      }

      if (!isRateLimitError(error)) {
        throw error;
      }

      const retryDelayMs = getRateLimitRetryDelayMs(error, attemptCount - 1);
      markModelRateLimited(candidateModel, retryDelayMs);
    }
  }

  if (isRateLimitError(lastError)) {
    throw new Error(
      buildRateLimitExhaustedMessage(candidateModels, startedAt, lastError),
    );
  }

  throw lastError;
}

function collectCandidateModels(primaryModel, fallbackModels = []) {
  const values = [primaryModel, ...splitModelList(fallbackModels)];
  return Array.from(
    new Set(values.map((value) => String(value || "").trim()).filter(Boolean)),
  );
}

function buildAutomaticFallbackModels(primaryModel, additionalModels = []) {
  const normalizedPrimaryModel = String(primaryModel || "").trim();
  const familyFallbacks = [];

  if (/gpt-4o-mini/i.test(normalizedPrimaryModel)) {
    familyFallbacks.push("gpt-4.1-mini", "gpt-4.1-nano");
  } else if (/gpt-4\.1-mini/i.test(normalizedPrimaryModel)) {
    familyFallbacks.push("gpt-4o-mini", "gpt-4.1-nano");
  } else if (/gpt-4\.1/i.test(normalizedPrimaryModel)) {
    familyFallbacks.push("gpt-4.1-mini", "gpt-4o-mini", "gpt-4.1-nano");
  } else {
    familyFallbacks.push(...DEFAULT_CROSS_MODEL_FALLBACKS, "gpt-4o-mini");
  }

  return collectCandidateModels(
    "",
    [...familyFallbacks, ...splitModelList(additionalModels)].filter(
      (modelName) => modelName && modelName !== normalizedPrimaryModel,
    ),
  );
}

function splitModelList(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => splitModelList(item));
  }

  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getModelWaitTime(modelName) {
  const nextAvailableAt = Number(
    modelRateLimitAvailability.get(modelName) || 0,
  );
  if (!Number.isFinite(nextAvailableAt) || nextAvailableAt <= Date.now()) {
    return 0;
  }

  return nextAvailableAt - Date.now();
}

function selectCandidateModel(candidateModels, blockedModels = new Set()) {
  return [...candidateModels]
    .filter((modelName) => !blockedModels.has(modelName))
    .sort((left, right) => getModelWaitTime(left) - getModelWaitTime(right))[0];
}

function shouldSkipModelAfterError(error) {
  const status = Number(error?.status);
  const message = String(error?.message || "");

  if (status === 404) {
    return true;
  }

  if (status === 400 || status === 403) {
    return /model|not found|does not exist|unsupported|access|permission/i.test(
      message,
    );
  }

  return false;
}

function markModelRateLimited(modelName, delayMs) {
  modelRateLimitAvailability.set(
    modelName,
    Date.now() + Math.max(DEFAULT_RATE_LIMIT_RETRY_DELAY_MS, delayMs),
  );
}

function clearModelRateLimit(modelName) {
  modelRateLimitAvailability.delete(modelName);
}

function buildRateLimitExhaustedMessage(candidateModels, startedAt, lastError) {
  const elapsedSeconds = Math.max(
    1,
    Math.round((Date.now() - startedAt) / 1000),
  );
  const originalMessage =
    lastError instanceof Error && lastError.message
      ? ` آخر رسالة: ${lastError.message}`
      : "";

  return `استمر الخادم بمحاولة التنفيذ على نماذج الذكاء الاصطناعي (${candidateModels.join("، ")}) لمدة ${elapsedSeconds} ثانية لكنه بقي ضمن حد المعدل.${originalMessage}`;
}

function isRateLimitError(error) {
  return (
    Number(error?.status) === 429 ||
    /rate limit/i.test(String(error?.message || ""))
  );
}

function getRateLimitRetryDelayMs(error, attemptIndex = 0) {
  const retryAfterHeader = Number(
    error?.headers?.["retry-after-ms"] || error?.headers?.["retry-after"] || 0,
  );
  if (Number.isFinite(retryAfterHeader) && retryAfterHeader > 0) {
    return Math.ceil(retryAfterHeader) + RATE_LIMIT_RETRY_PADDING_MS;
  }

  const message = String(error?.message || "");
  const millisecondsMatch = message.match(/try again in\s+(\d+)ms/i);
  if (millisecondsMatch) {
    return Number(millisecondsMatch[1]) + RATE_LIMIT_RETRY_PADDING_MS;
  }

  const secondsMatch = message.match(/try again in\s+(\d+(?:\.\d+)?)s/i);
  if (secondsMatch) {
    return (
      Math.ceil(Number(secondsMatch[1]) * 1000) + RATE_LIMIT_RETRY_PADDING_MS
    );
  }

  return DEFAULT_RATE_LIMIT_RETRY_DELAY_MS * (attemptIndex + 1);
}

function wait(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, delayMs));
  });
}

export function createReviewApp(options = {}) {
  loadEnvironment(projectRoot);

  const {
    knowledgeBase = loadKnowledgeBase(projectRoot),
    notesForCheckContext = loadNotesForCheckContext(),
    client = buildClient(process.env.OPENAI_API_KEY),
    reviewModel = process.env.OPENAI_UI_REVIEW_MODEL ||
      process.env.OPENAI_MODEL ||
      DEFAULT_REVIEW_MODEL,
    extractionModel = process.env.OPENAI_UI_EXTRACTION_MODEL ||
      process.env.OPENAI_MODEL ||
      DEFAULT_EXTRACTION_MODEL,
    cadClassifierModel = process.env.OPENAI_UI_CAD_CLASSIFIER_MODEL ||
      process.env.OPENAI_UI_EXTRACTION_MODEL ||
      DEFAULT_CAD_CLASSIFIER_MODEL,
    cadCriticalModel = process.env.OPENAI_UI_CAD_CRITICAL_MODEL ||
      process.env.OPENAI_UI_REVIEW_MODEL ||
      reviewModel,
    fallbackModel = process.env.OPENAI_UI_FALLBACK_MODEL ||
      process.env.OPENAI_FALLBACK_MODEL ||
      process.env.OPENAI_UI_EXTRACTION_MODEL ||
      process.env.OPENAI_UI_REVIEW_MODEL ||
      DEFAULT_EXTRACTION_MODEL,
    fallbackModels: configuredFallbackModels = options.fallbackModels ||
      process.env.OPENAI_UI_FALLBACK_MODELS ||
      [],
  } = options;

  const fallbackModels = collectCandidateModels(
    "",
    splitModelList(configuredFallbackModels).length > 0
      ? configuredFallbackModels
      : fallbackModel &&
          ![
            reviewModel,
            extractionModel,
            cadClassifierModel,
            cadCriticalModel,
          ].includes(fallbackModel)
        ? [fallbackModel]
        : buildAutomaticFallbackModels(reviewModel, [
            fallbackModel,
            extractionModel,
            cadClassifierModel,
            cadCriticalModel,
          ]),
  );

  const modelAssignments = {
    reviewModel,
    extractionModel,
    cadClassifierModel,
    cadCriticalModel,
    fallbackModels,
  };

  validateModelAssignments({
    reviewModel,
    extractionModel,
    cadClassifierModel,
    cadCriticalModel,
    fallbackModels,
  });

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

  app.post("/api/classify-cad-pages", async (req, res) => {
    if (!client) {
      return res.status(503).json({
        error:
          "OPENAI_API_KEY is not configured for the standalone review server.",
      });
    }

    const {
      fileName,
      mimeType,
      requiredDocuments,
      pageImages,
      localPageTexts,
    } = req.body ?? {};
    if (
      !fileName ||
      !Array.isArray(requiredDocuments) ||
      requiredDocuments.length === 0 ||
      !Array.isArray(pageImages) ||
      pageImages.length === 0
    ) {
      return res.status(400).json({
        error:
          "Missing fileName, requiredDocuments, or pageImages payload for CAD classification.",
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
      .slice(0, 16);

    const normalizedRequiredDocuments = normalizeStringList(
      requiredDocuments,
      40,
    );
    const pageTextsByNumber = new Map(
      (Array.isArray(localPageTexts) ? localPageTexts : [])
        .map((item) => ({
          pageNumber: Number(item?.pageNumber),
          text: normalizeText(item?.text, 900),
        }))
        .filter((item) => Number.isFinite(item.pageNumber)),
    );

    const systemPrompt = [
      "You classify CAD and engineering drawing pages for Riyadh Municipality using the cheapest possible first-pass vision review.",
      "Respond only with valid JSON.",
      "Your job is page triage, not final compliance review.",
      "For each page, return critical only if it is likely to contain a title block, discipline label, checklist-relevant sheet, site plan, structural plan, architectural plan, electrical plan, mechanical plan, safety plan, or official project/deed sheet.",
      "Return supporting for pages that may help context but are less central.",
      "Return ignore for decorative, repeated, blank, or low-signal pages.",
      "Be conservative and optimize for reducing downstream cost without dropping obviously important pages.",
      "Write all user-facing strings in Arabic.",
    ].join(" ");

    const userPayload = {
      instruction:
        "صنف الصفحات إلى critical أو supporting أو ignore بهدف اختيار أقل عدد ممكن من الصفحات التي تستحق التحليل الأقوى لاحقاً. ركز على الصفحات التي يظهر فيها عنوان لوحة، تخصص هندسي، بيانات مشروع، بيانات مالك، أو أي دلالة قوية على مستند مطلوب.",
      outputSchema: {
        pages:
          "Array<{pageNumber:number, relevance:critical|supporting|ignore, reason:string, detectedDocuments:string[]}>",
      },
      file: {
        fileName,
        mimeType: typeof mimeType === "string" ? mimeType : "",
        requiredDocuments: normalizedRequiredDocuments,
        detectionHints: buildDetectionHints(normalizedRequiredDocuments),
      },
      pages: sanitizedImages.map(({ pageNumber }) => ({
        pageNumber,
        localText: pageTextsByNumber.get(pageNumber) || "",
      })),
    };

    const messages = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: JSON.stringify(userPayload) },
          ...sanitizedImages.flatMap(({ pageNumber, dataUrl }) => [
            { type: "text", text: `الصفحة ${pageNumber}` },
            { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
          ]),
        ],
      },
    ];

    try {
      const completion = await requestStructuredJson({
        client,
        ...buildTaskModelPlan("cadPageClassification", modelAssignments),
        messages,
      });

      const { model, parsed } = completion;
      return res.json({
        model,
        pages: Array.isArray(parsed.pages)
          ? parsed.pages
              .map((item) => ({
                pageNumber: Number(item?.pageNumber),
                relevance: normalizeCadPageRelevance(item?.relevance),
                reason: normalizeText(item?.reason, 180),
                detectedDocuments: mapDetectedDocumentsToPolicy(
                  item?.detectedDocuments,
                  normalizedRequiredDocuments,
                ),
              }))
              .filter((item) => Number.isFinite(item.pageNumber))
          : [],
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "CAD page classification failed";
      console.error("classify-cad-pages failed", {
        taskModelPlan: buildTaskModelPlan(
          "cadPageClassification",
          modelAssignments,
        ),
        message,
      });
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
      extractionMode,
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
      "If architectural-plan pages visually show parking bays, car slots, garage areas, ramps, a parking layout, or a clearly drawn parking area, mention that evidence in extractedText or notes even when the sheet does not explicitly say parking.",
      "When parking is visible on a page, include the page number and describe the visual cues directly, such as parking bays, stall rows, aisle arrows, car symbols, or parking area labels, even if the title block is unrelated.",
      "If a page title or table title says جدول الارتدادات, جدول الارتادات, setbacks, or setback table, preserve it as explicit setbacks evidence for the architectural review and include the page number.",
      "If a sheet shows a table of areas, coverage values, المسطحات, numeric area calculations, or anything that looks like جدول المساحات, preserve it as explicit نسبة البناء evidence even when the OCR title is incomplete.",
      "If a sheet shows room names, space labels, room partitions, or a floor plan with visible room layout such as صالة, مجلس, مطبخ, غرف, حمام, or نوم, preserve it as explicit مساحات الغرف والفراغات evidence even if the exact table title is not visible.",
      "If a sheet shows a project use label such as فيلا, سكني, تجاري, الاستخدام السكني, الاستخدام التجاري, or a title near توصيف الاستخدام or نوع الاستخدام, preserve it as explicit الاستخدام مطابق للتصنيف evidence even if the sheet title is abbreviated.",
      "Mention accessibility requirements only when they are clearly shown in the plan, such as wheelchair routes, accessible ramps, accessible toilets, accessibility labels, or dedicated disabled parking. Do not infer them from generic circulation unless the evidence is explicit.",
      "Pay special attention to sheet title blocks and repeated discipline labels such as electrical, structural, mechanical, site plan, safety, and approved building regulation sheets.",
    ].join(" ");

    const normalizedRequiredDocuments = normalizeStringList(
      requiredDocuments,
      40,
    );

    const userPayload = {
      instruction:
        "استخرج النصوص والعناوين الظاهرة التي تساعد على التعرف على نوع المستندات داخل الملف الهندسي. راجع كل صفحة مرفقة بصرياً، وركز على خانة عنوان اللوحة، اسم التخصص، الأختام، ورؤوس الجداول. ثم حدد المستندات المطلوبة التي تظهر بوضوح أو بدلالة قوية في الصفحات. إذا ظهر عنوان قريب من اسم المستند المطلوب فارجعه باسم المستند المطلوب نفسه. وإذا ظهرت عناوين مثل جدول الارتدادات أو جدول الارتادات أو setbacks في أي صفحة، فاعتبرها دليلاً صريحاً على الارتدادات النظامية وأشر إلى رقم الصفحة بوضوح. وإذا أظهرت اللوحة عنواناً أو قيماً أو جدولاً قريباً من جدول المساحات أو المسطحات أو نسبة التغطية أو أي جدول حسابات مساحات، فاعتبر ذلك دليلاً صريحاً على نسبة البناء وأشر إلى رقم الصفحة بوضوح. وإذا أظهرت اللوحة المعمارية مواقف سيارات مرسومة بصرياً أو صفوف مواقف أو كراج أو منحدر سيارات أو منطقة مواقف واضحة حتى دون عنوان نصي واضح، فاذكر ذلك صراحة داخل extractedText أو notes مع رقم الصفحة لأنه دليل مهم لبند مواقف السيارات. وإذا أظهرت اللوحة مساحة الغرف أو توزيع الفراغات أو أسماء الفراغات المعمارية أو مخطط الدور الأرضي/الأول مع صالة ومجلس ومطبخ وغرف نوم أو أي تخطيط داخلي واضح، فاعتبره دليلاً صريحاً على مساحات الغرف والفراغات وأشر إلى رقم الصفحة بوضوح. وإذا أظهر الملف توصيف استخدام مثل فيلا أو سكني أو تجاري أو استخدام سكني أو استخدام تجاري، فاعتبره دليلاً صريحاً على الاستخدام مطابق للتصنيف وأشر إلى رقم الصفحة بوضوح. أما متطلبات ذوي الإعاقة (إن وجد) فلا تذكرها إلا إذا ظهرت بوضوح مثل منحدر مخصص أو مسار كرسي متحرك أو دورة مياه مخصصة أو وسم صريح لذلك داخل المخطط.",
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

    const taskModelPlan = buildTaskModelPlan(
      extractionMode === "cad-critical"
        ? "attachmentExtractionCadCritical"
        : "attachmentExtractionStandard",
      modelAssignments,
    );

    try {
      const completion = await requestStructuredJson({
        client,
        ...taskModelPlan,
        messages,
      });

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
        taskModelPlan,
        message,
      });
      return res.status(500).json({ error: message });
    }
  });

  app.post("/api/validate-attachment", async (req, res) => {
    if (!client) {
      return res.status(503).json({
        error:
          "OPENAI_API_KEY is not configured for the standalone review server.",
      });
    }

    const {
      fileName,
      mimeType,
      sourceType,
      requiredDocuments,
      expectedDocument,
      extractedText,
      detectedDocuments,
      notes,
    } = req.body ?? {};

    if (
      !fileName ||
      !Array.isArray(requiredDocuments) ||
      requiredDocuments.length === 0
    ) {
      return res.status(400).json({
        error: "Missing fileName or requiredDocuments payload.",
      });
    }

    const normalizedRequiredDocuments = normalizeStringList(
      requiredDocuments,
      40,
    );
    const normalizedExpectedDocument = normalizeText(expectedDocument, 160);
    const normalizedDetectedDocuments = mapDetectedDocumentsToPolicy(
      detectedDocuments,
      normalizedRequiredDocuments,
    );
    const normalizedNotes = normalizeStringList(notes, 8);
    const structuredNotesForCheck = partitionNotesForCheckItems(
      notesForCheckContext.checklistItems,
    );
    const architecturalChecklistItems =
      structuredNotesForCheck.architecturalItems;
    const architecturalChecklistGuidance = buildArchitecturalChecklistGuidance(
      architecturalChecklistItems,
    );
    const isArchitecturalPlansValidation =
      isArchitecturalPlansDocumentCandidate(normalizedExpectedDocument) ||
      normalizedRequiredDocuments.some((documentName) =>
        isArchitecturalPlansDocumentCandidate(documentName),
      ) ||
      normalizedDetectedDocuments.some((documentName) =>
        isArchitecturalPlansDocumentCandidate(documentName),
      );

    const systemPrompt = [
      "You validate one uploaded engineering permit attachment for Riyadh Municipality.",
      "Respond only with valid JSON.",
      "Your task is to judge whether this single file matches the expected required attachment and give direct feedback for that file.",
      "Use only these statuses: passed, warning, missing.",
      "passed means the file clearly matches the expected attachment.",
      "warning means the file may be relevant but still has ambiguity, weak evidence, or quality issues.",
      "missing means the file does not appear to match the expected attachment or has no usable evidence.",
      "If the expected attachment is the architectural plans sheet, evaluate every checklist point provided in the payload and return one result row for each checklist concept using the canonical item text when possible.",
      "The payload also includes architecturalChecklistGuidance. Treat it as a semantic map of close sheet titles, table names, and drawing labels, not as a strict list of exact-string matches.",
      "When a table title or extracted note points to a specific item, use that clue directly. For example, treat جدول المساحات as strong evidence for نسبة البناء and treat جدول الارتدادات, جدول الارتادات, or a setbacks table as strong evidence for الارتدادات النظامية.",
      "Treat room schedule titles such as جدول الغرف, جدول الفراغات, جدول الفراغات الداخلية, room schedule, room plan, and schedule of rooms as strong evidence for مساحات الغرف والفراغات.",
      "Treat usage labels such as توصيف الاستخدام, نوع الاستخدام, الاستخدام السكني, الاستخدام التجاري, occupancy, and usage as strong evidence for الاستخدام مطابق للتصنيف.",
      "Also treat floor-plan cues like دور أرضي, دور أول, دور ثاني, منسوب, مقطع, elevation, and section as valid evidence for عدد الأدوار والارتفاع when they clearly indicate the number of floors or the building height.",
      "Treat room labels and room schedule cues like غرفة, صالة, مجلس, مطبخ, جدول الغرف, and dimensions as valid evidence for مساحات الغرف والفراغات when they describe the internal room layout.",
      "Treat usage cues like سكني, تجاري, فيلا, شقق, مبنى سكني, مبنى تجاري, and استعمال as valid evidence for الاستخدام مطابق للتصنيف when they clearly indicate the project use.",
      "For the parking checklist item, accept parking evidence reflected in extractedText or notes even if the sheet title does not explicitly mention parking, especially when the source describes drawn parking bays, garage areas, ramps, parking areas, aisle arrows, car symbols, or visual parking layout. Page-numbered notes are especially helpful when the parking layout appears on a later sheet like page 15.",
      "For the accessibility checklist item, mention it only when there is explicit evidence in the extractedText or notes, such as wheelchair paths, accessibility labels, accessible toilets, accessible ramps, or dedicated disabled parking. If it is not clearly shown, leave it as Not Found.",
      "Be strict and concise. Do not guess.",
      "Write all user-facing strings in Arabic.",
    ].join(" ");

    const userPayload = {
      instruction: isArchitecturalPlansValidation
        ? "قيّم هذا الملف الواحد فقط. هل يطابق المتطلب المطلوب؟ ثم افحص جميع بنود checklist الخاصة بالمخططات المعمارية الواردة في الحمولة وأخرج status وsummary وfeedback مع checklistResults بحيث يحتوي كل بند على item وstatus وcomment بشكل مباشر وقابل للعرض تحت خانة الرفع. استخدم الإشارات الجدولية وقراءات اللوحات داخل الملف بذكاء: جدول المساحات دليل قوي على نسبة البناء، وجدول الارتدادات أو جدول الارتادات أو جدول مشابه دليل قوي على الارتدادات النظامية، بينما دور أرضي/دور أول/دور ثاني أو مقطع أو منسوب أو elevation أو section قد تثبت عدد الأدوار والارتفاع، وتوزيع الغرف أو جدول الغرف أو جدول الفراغات أو جدول الفراغات الداخلية أو room schedule أو room plan أو schedule of rooms قد تثبت مساحات الغرف والفراغات، وكلمات مثل سكني أو تجاري أو فيلا أو شقق أو استعمال أو occupancy أو usage أو توصيف الاستخدام أو نوع الاستخدام قد تثبت الاستخدام مطابق للتصنيف. في بند مواقف السيارات اعتبر الوصف الذي يذكر مواقف مرسومة أو صفوف مواقف أو كراج أو منحدر سيارات دليلاً صالحاً حتى لو لم يظهر اسم البند نصاً داخل اللوحة. أما بند متطلبات ذوي الإعاقة (إن وجد) فلا تذكره إلا إذا ظهر صراحة في النص أو الملاحظات المستخرجة مثل منحدر مخصص أو مسار كرسي متحرك أو دورة مياه مخصصة أو وسم واضح لذلك."
        : "قيّم هذا الملف الواحد فقط. هل يطابق المتطلب المطلوب؟ أخرج status وsummary وfeedback بشكل مباشر وقابل للعرض تحت خانة الرفع.",
      outputSchema: {
        status: "passed | warning | missing",
        summary: "string",
        feedback: "string[]",
        confidence: "number 0-100",
        ...(isArchitecturalPlansValidation
          ? {
              checklistResults:
                "Array<{item:string, status:Compliant|Non-Compliant|Not Found, comment:string}>",
            }
          : {}),
      },
      file: {
        fileName,
        mimeType: typeof mimeType === "string" ? mimeType : "",
        sourceType: typeof sourceType === "string" ? sourceType : "",
        expectedDocument: normalizedExpectedDocument,
        requiredDocuments: normalizedRequiredDocuments,
        detectedDocuments: normalizedDetectedDocuments,
        notes: normalizedNotes,
        extractedText: normalizeText(extractedText, 6000),
      },
      architecturalChecklistItems: isArchitecturalPlansValidation
        ? architecturalChecklistItems
        : [],
      architecturalChecklistGuidance: isArchitecturalPlansValidation
        ? architecturalChecklistGuidance
        : [],
    };

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(userPayload) },
    ];

    try {
      const completion = await requestStructuredJson({
        client,
        ...buildTaskModelPlan("attachmentValidation", modelAssignments),
        messages,
      });

      const { model, parsed } = completion;
      const modelSummary = normalizeText(parsed.summary, 280);
      const modelFeedback = normalizeStringList(parsed.feedback, 6);
      const checklistResults = isArchitecturalPlansValidation
        ? buildChecklistRows(parsed.checklistResults, {
            notesForCheckItems: architecturalChecklistItems,
            notesForCheckPath: notesForCheckContext.sourcePath,
            fileName,
            expectedDocument: normalizedExpectedDocument,
            detectedDocuments: normalizedDetectedDocuments,
            notes: normalizedNotes,
            extractedText: normalizeText(extractedText, 6000),
          }).map((row) => ({
            item: row.item,
            status: normalizeAttachmentChecklistStatus(row.status),
            comment:
              normalizeText(row.comment, 320) ||
              "لم يتم العثور على دليل صريح لهذا البند داخل الملف الحالي.",
          }))
        : [];
      const hasVerifiedArchitecturalEvidence =
        checklistResults.some((row) => row.status === "Compliant");
      const responseSummary = isArchitecturalPlansValidation
        ? hasVerifiedArchitecturalEvidence
          ? modelSummary
          : buildArchitecturalValidationSummary(checklistResults)
        : modelSummary;
      const responseFeedback = isArchitecturalPlansValidation
        ? hasVerifiedArchitecturalEvidence
          ? modelFeedback
          : buildArchitecturalValidationFeedback(checklistResults)
        : modelFeedback;

      if (!responseSummary || responseFeedback.length === 0) {
        return res.status(502).json({
          error:
            "AI validation response was incomplete. The model did not return usable feedback for this file.",
        });
      }

      return res.json({
        model,
        status: normalizeAttachmentValidationStatus(parsed.status),
        summary: responseSummary,
        feedback: responseFeedback,
        confidence: normalizeConfidence(parsed.confidence),
        ...(checklistResults.length > 0 ? { checklistResults } : {}),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Attachment validation failed";
      console.error("validate-attachment failed", {
        taskModelPlan: buildTaskModelPlan(
          "attachmentValidation",
          modelAssignments,
        ),
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
    const projectTypeContext = resolveSelectedProjectType(policy, submission);
    const effectiveRequiredDocuments = projectTypeContext.selectedSubtype
      ?.requiredDocuments?.length
      ? projectTypeContext.selectedSubtype.requiredDocuments
      : policy.requiredDocuments;
    const trackedDocuments = AI_TRACKED_DOCUMENTS.filter(
      (documentName) =>
        Array.isArray(effectiveRequiredDocuments) &&
        effectiveRequiredDocuments.includes(documentName),
    );
    const structuredNotesForCheck = partitionNotesForCheckItems(
      notesForCheckContext.checklistItems,
    );
    const notesForCheckItems = structuredNotesForCheck.architecturalItems;
    const consistencyCheckItems = structuredNotesForCheck.consistencyItems;

    const systemPrompt = [
      "You are an expert municipal engineering license reviewer for Riyadh Municipality.",
      "Respond only with valid JSON.",
      "Be strict, deterministic, and evidence-based.",
      "Never skip any step in the validation pipeline.",
      "Do not assume missing data. Explicitly mark it as Missing.",
      "If uncertainty exists, mark it as Unable to Verify. Do not guess.",
      "Always reference which file or section your conclusion is based on whenever sourceRefs are requested.",
      "Base the review strictly on the provided policy knowledge context, workflow evidence, uploaded attachment text, rule-based review, and the Notes for Check workbook items.",
      "Treat the rule-based review as the primary baseline and provide supplemental reasoning, nuance, and risk assessment on top of it.",
      "Do not override deterministic missing-document findings unless the uploaded text clearly supports a correction.",
      "When tracked engineering sheets are requested, evaluate each one directly from the uploaded sheet text and detected sheet titles as the source evidence.",
      "For each tracked sheet validation, include one to three short evidence snippets copied or closely paraphrased from the uploaded sheet text.",
      "For architectural compliance, use the Unified Requirements source plus the Notes for Check workbook as validation sources.",
      "When the architectural plans attachment is present, complianceReport.architecturalCompliance.notesForCheck must include one row for every architectural Notes for Check item using the exact item text provided in the payload.",
      "When the architectural plans attachment is present, complianceReport.dataConsistencyCheck must also include one row for every workbook-driven consistency item using the exact field text provided in the payload, in addition to the baseline identity consistency rows.",
      "The complianceReport object must follow the requested step-by-step structure exactly and must cover project type detection, attachment completeness, deed and beneficiary data consistency, attachment accuracy, requirements compliance, Notes for Check validation, violations, and final summary.",
      "Inside complianceReport, use only these exact status values: Present, Missing, Invalid / Unclear, Match, Mismatch, Missing, Valid, Invalid, Partially Valid, Compliant, Non-Compliant, Not Found, Complete, Incomplete.",
      "Suggested responses must be short operational replies that a municipal reviewer can send back to the engineering office, each tagged with an action type.",
      "If a project type and subtype are provided, interpret the policy in light of that exact classification and prefer source-grounded subtype-specific requirements over generic assumptions.",
      "If project type options are provided but no selection was made, mention the missing classification as a review limitation instead of inventing one.",
      "Write all user-facing strings in Arabic.",
      "Do not invent regulations that are not supported by the provided source excerpts.",
      "Return a conservative recommendation for human approval support, not a legally binding final decision.",
    ].join(" ");

    const userPayload = {
      instruction:
        "حلل الملفات، تحقق منها، ثم أخرج تقرير امتثال منظم وفق الخطوات التالية دون تخطي أي خطوة: 1) تحديد نوع المشروع وتحديد المرفقات المطلوبة. 2) فحص اكتمال المرفقات وتصنيف كل مرفق Present أو Missing أو Invalid / Unclear. 3) التحقق من اتساق بيانات المستفيد والصك عبر Plot Number وBeneficiary Name وEngineering Office وPlan Number وDeed Number. 4) التحقق من دقة المرفقات ومدى ارتباطها الفعلي بالصك ونوع المشروع. 5) مراجعة الامتثال المعماري بالاعتماد على ملف الاشتراطات الموحد وملف Notes for Check والمخططات المعمارية، مع فحص جميع عناصر Notes for Check وإخراج المخالفات بوضوح. 6) إصدار ملخص نهائي قرار-جاهز واضح ومباشر.",
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
        complianceReport: {
          projectInformation: {
            projectType: "string",
            confidenceLevel: "High | Medium | Low",
          },
          attachmentsStatus: {
            overallStatus: "Complete | Incomplete",
            rows: "Array<{attachment:string, status:Present|Missing|Invalid / Unclear, notes:string, sourceRefs:string[]}>",
          },
          dataConsistencyCheck:
            "Array<{field:string, sak:string, otherDocs:string, status:Match|Mismatch|Missing, sourceRefs:string[]}>",
          attachmentAccuracy: {
            status: "Valid | Invalid | Partially Valid",
            notes: "string[]",
          },
          architecturalCompliance: {
            requirementsCompliance: "Compliant | Not Compliant",
            notesForCheck:
              "Array<{item:string, status:Compliant|Non-Compliant|Not Found, comment:string, sourceRefs:string[]}>",
            violations: "string[]",
          },
          finalSummary: {
            attachments: "string",
            dataConsistency: "string",
            architecturalCompliance: "string",
            keyIssues: "string[]",
          },
        },
      },
      policy: {
        id: policy.id,
        title: policy.title,
        references: policy.references,
        requiredDocuments: effectiveRequiredDocuments,
        requiredDocumentsDetailed: effectiveRequiredDocuments.map(
          (documentName) => ({
            number: CHECKLIST_DOCUMENT_CATALOG[documentName] || "",
            title: documentName,
          }),
        ),
        workflow: policy.workflow,
        projectTypes: projectTypeContext.availableGroups,
        sourcePath: knowledgeContext.sourcePath,
        sourceCitations: knowledgeContext.citations,
      },
      architecturalValidationSources: {
        unifiedRequirementsSourcePath: knowledgeContext.sourcePath,
        notesForCheckSourcePath: notesForCheckContext.sourcePath,
        notesForCheckFileName: notesForCheckContext.fileName,
        notesForCheckItems,
        consistencyCheckItems,
        structuredWorkbookRows: structuredNotesForCheck.allEntries.map(
          (item) => ({
            section: item.section,
            item: item.text,
            kind: item.kind,
            rowNumber: item.rowNumber,
          }),
        ),
      },
      submission: {
        applicantName: submission.applicantName,
        officeName: submission.officeName,
        district: submission.district,
        plotNumber: submission.plotNumber,
        projectTypeGroupId: submission.projectTypeGroupId,
        projectSubtypeId: submission.projectSubtypeId,
        projectTypeGroupTitle: projectTypeContext.selectedGroup?.title ?? "",
        projectSubtypeTitle: projectTypeContext.selectedSubtype?.title ?? "",
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

      const completion = await requestStructuredJson({
        client,
        ...buildTaskModelPlan("llmReview", modelAssignments),
        messages,
      });

      const { model, parsed } = completion;
      const derivedConfidence = deriveConfidence(
        parsed.confidence,
        submission,
        ruleReview,
      );
      return res.json({
        model,
        generatedAt: new Date().toISOString(),
        decision: parsed.decision,
        confidence: derivedConfidence,
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
        complianceReport: normalizeComplianceReport(parsed.complianceReport, {
          requiredDocuments: effectiveRequiredDocuments,
          attachments: submission.uploadedAttachments ?? [],
          submission,
          matchedDocuments: Array.isArray(ruleReview.matchedDocuments)
            ? ruleReview.matchedDocuments
            : [],
          missingDocuments: Array.isArray(ruleReview.missingDocuments)
            ? ruleReview.missingDocuments
            : [],
          projectTypeGroupTitle: projectTypeContext.selectedGroup?.title ?? "",
          projectSubtypeTitle: projectTypeContext.selectedSubtype?.title ?? "",
          notesForCheckItems,
          consistencyCheckItems,
          notesForCheckPath: notesForCheckContext.sourcePath,
          confidence: derivedConfidence,
        }),
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
    if (!process.env.OPENAI_API_KEY) {
      console.warn(
        "OPENAI_API_KEY is still missing after env loading. Checked project .env files, cwd .env files, and accelerator/.env.",
      );
    }
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  startReviewServer(Number(process.env.PORT) || 8787);
}
