import type {
  DocumentValidation,
  LicensePolicy,
  ReviewResult,
  SubmissionForm,
  SuggestedResponse,
} from "../types";
import {
  buildDocumentEvidence,
  buildPolicyEvidence,
  buildWorkflowEvidence,
} from "./policyEvidence";
import { getPolicyKnowledge } from "../data/policyKnowledgeBase";
import { translateDisplayText, type Locale } from "../utils/localization";

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

type TrackedValidationRule = {
  documentName: string;
  keywordGroups: string[][];
  successThreshold: number;
};

const trackedValidationRules: TrackedValidationRule[] = [
  {
    documentName: "المخططات المعمارية",
    keywordGroups: [
      ["مخطط معماري", "معماري"],
      ["مسقط", "مساقط"],
      ["واجهة", "واجهات"],
      ["قطاع", "قطاعات"],
    ],
    successThreshold: 3,
  },
  {
    documentName: "المخطط الإنشائي",
    keywordGroups: [
      ["مخطط إنشائي", "انشائي", "إنشائي"],
      ["قواعد", "الاساسات", "أساسات"],
      ["اعمدة", "أعمدة", "عمود"],
      ["كمرات", "جسور", "beam"],
    ],
    successThreshold: 3,
  },
  {
    documentName: "الموقع العام",
    keywordGroups: [
      ["الموقع العام", "موقع عام", "site plan"],
      ["حدود", "حدود الارض", "حدود الأرض"],
      ["ارتدادات", "ارتداد"],
      ["مواقف", "موقف سيارات"],
    ],
    successThreshold: 3,
  },
  {
    documentName: "المخطط الكهربائي",
    keywordGroups: [
      ["مخطط كهربائي", "كهربائي", "لوحة كهرباء"],
      ["لوحة", "لوحات"],
      ["احمال", "أحمال", "load"],
      ["إنارة", "اضاءة", "إضاءة"],
    ],
    successThreshold: 3,
  },
  {
    documentName: "مخطط الأمن والسلامة",
    keywordGroups: [
      ["الأمن والسلامة", "مخطط سلامة", "خطة السلامة"],
      ["مخارج", "مخرج طوارئ", "طوارئ"],
      ["طفايات", "إطفاء", "مكافحة الحريق"],
      ["إنذار", "alarm", "انذار"],
    ],
    successThreshold: 3,
  },
  {
    documentName: "المخططات الميكانيكية",
    keywordGroups: [
      ["مخطط ميكانيكي", "مخططات ميكانيكية", "ميكانيكي"],
      ["تكييف", "hvac"],
      ["تهوية", "ventilation"],
      ["مضخات", "مواسير", "pipe"],
    ],
    successThreshold: 3,
  },
  {
    documentName: "نظام البناء المعتمد من إدارة الرخص",
    keywordGroups: [
      ["نظام البناء المعتمد", "نظام البناء"],
      ["إدارة الرخص", "ادارة الرخص"],
      ["عدد الادوار", "عدد الأدوار", "الادوار"],
      ["نسبة البناء", "الارتفاع"],
    ],
    successThreshold: 3,
  },
];

function normalizeArabic(value: string): string {
  return value
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

function extractEvidenceSnippet(
  text: string,
  keywordOptions: string[],
): string | null {
  for (const keyword of keywordOptions) {
    const directIndex = text.indexOf(keyword);
    if (directIndex >= 0) {
      const start = Math.max(0, directIndex - 36);
      const end = Math.min(text.length, directIndex + keyword.length + 72);
      return text.slice(start, end).replace(/\s+/g, " ").trim();
    }

    const normalizedText = normalizeArabic(text);
    const normalizedKeyword = normalizeArabic(keyword);
    const normalizedIndex = normalizedText.indexOf(normalizedKeyword);
    if (normalizedIndex >= 0) {
      const start = Math.max(0, normalizedIndex - 36);
      const end = Math.min(
        normalizedText.length,
        normalizedIndex + normalizedKeyword.length + 72,
      );
      return normalizedText.slice(start, end).replace(/\s+/g, " ").trim();
    }
  }

  return null;
}

function collectValidationEvidence(
  attachments: SubmissionForm["uploadedAttachments"],
  keywordGroups: string[][],
  limit = 3,
): string[] {
  const snippets: string[] = [];

  for (const group of keywordGroups) {
    for (const attachment of attachments) {
      const snippet = extractEvidenceSnippet(
        `${attachment.name}\n${attachment.extractedText}`,
        group,
      );
      if (snippet && !snippets.includes(snippet)) {
        snippets.push(snippet);
      }
      if (snippets.length >= limit) {
        return snippets;
      }
    }
  }

  return snippets;
}

function validateTrackedDocument(
  form: SubmissionForm,
  documentName: string,
  keywordGroups: string[][],
  successThreshold: number,
): DocumentValidation {
  const relatedAttachments = form.uploadedAttachments.filter((attachment) =>
    attachment.detectedDocuments.includes(documentName),
  );

  if (relatedAttachments.length === 0) {
    return {
      documentName,
      status: "missing",
      summary: `لم يتم العثور على ${documentName} ضمن الملفات المرفوعة أو لم يتم ربطه آلياً بهذه المعاملة.`,
      details: [
        "يرجى رفع الملف أو إعادة الرفع بصيغة أوضح حتى يمكن التحقق من محتواه.",
      ],
      evidenceSnippets: [],
      source: "rule",
    };
  }

  const haystack = normalizeArabic(
    relatedAttachments
      .map((attachment) => `${attachment.name}\n${attachment.extractedText}`)
      .join("\n\n"),
  );
  const evidenceSnippets = collectValidationEvidence(
    relatedAttachments,
    keywordGroups,
  );
  const matchedGroups = keywordGroups.filter((group) =>
    group.some((keyword) => haystack.includes(normalizeArabic(keyword))),
  );
  const missingGroups = keywordGroups.filter(
    (group) =>
      !group.some((keyword) => haystack.includes(normalizeArabic(keyword))),
  );

  if (matchedGroups.length >= successThreshold) {
    return {
      documentName,
      status: "passed",
      summary: `تم رصد مؤشرات كافية داخل ${documentName} تدعم أن الملف يحتوي على العناصر المتوقعة للمراجعة.`,
      details: matchedGroups.map(
        (group) => `تم العثور على مؤشرات مرتبطة بـ ${group[0]}.`,
      ),
      evidenceSnippets,
      source: "rule",
    };
  }

  return {
    documentName,
    status: "warning",
    summary: `تم العثور على ${documentName} لكن الشواهد النصية داخله ما زالت غير كافية لتأكيد اكتمال عناصره الأساسية.`,
    details: [
      ...matchedGroups.map((group) => `ظهر في الملف ما يشير إلى ${group[0]}.`),
      ...missingGroups.map(
        (group) => `لم يظهر بوضوح ما يؤكد وجود ${group[0]}.`,
      ),
    ],
    evidenceSnippets,
    source: "rule",
  };
}

function buildSuggestedResponses(
  policy: LicensePolicy,
  validations: DocumentValidation[],
  missingDocuments: string[],
  status: ReviewResult["status"],
): SuggestedResponse[] {
  const responses: SuggestedResponse[] = [];
  const architectureValidation = validations.find(
    (item) => item.documentName === "المخططات المعمارية",
  );
  const structuralValidation = validations.find(
    (item) => item.documentName === "المخطط الإنشائي",
  );
  const siteValidation = validations.find(
    (item) => item.documentName === "الموقع العام",
  );
  const electricalValidation = validations.find(
    (item) => item.documentName === "المخطط الكهربائي",
  );
  const safetyValidation = validations.find(
    (item) => item.documentName === "مخطط الأمن والسلامة",
  );

  if (
    missingDocuments.includes("المخططات المعمارية") ||
    architectureValidation?.status === "warning"
  ) {
    responses.push({
      actionType: "request-completion",
      title: "طلب استكمال المخططات المعمارية",
      text: "يرجى تزويدنا بالمخططات المعمارية بصيغة أوضح تشمل المساقط والواجهات والقطاعات المعمارية، لأن الملف الحالي لا يكفي لتأكيد اكتمال المراجعة المعمارية.",
      rationale:
        "التحقق الحالي أظهر أن الملف المعماري موجود أو متوقع، لكن عناصره الأساسية غير مثبتة بشكل كاف.",
      source: "rule",
    });
  }

  if (
    missingDocuments.includes("المخطط الإنشائي") ||
    structuralValidation?.status === "warning"
  ) {
    responses.push({
      actionType: "request-completion",
      title: "طلب استكمال المخطط الإنشائي",
      text: "يرجى استكمال المخطط الإنشائي مع إظهار العناصر الأساسية مثل القواعد والأعمدة والكمرات أو ما يعادلها، حيث لم تتوفر مؤشرات كافية داخل الملف الحالي لاعتماد المراجعة الإنشائية.",
      rationale:
        "الشواهد الحالية لا تكفي لاعتماد المراجعة الإنشائية دون استكمال.",
      source: "rule",
    });
  }

  if (
    missingDocuments.includes("الموقع العام") ||
    siteValidation?.status === "warning"
  ) {
    responses.push({
      actionType: "request-completion",
      title: "طلب استكمال الموقع العام",
      text: "يرجى إعادة رفع الموقع العام بشكل يظهر حدود الأرض والارتدادات والمواقف والعلاقات المكانية الأساسية، لأن الملف الحالي لا يؤكد اكتمال بيانات الموقع العام.",
      rationale: "المراجعة الحالية لم تثبت جميع عناصر الموقع العام المطلوبة.",
      source: "rule",
    });
  }

  if (
    missingDocuments.includes("المخطط الكهربائي") ||
    electricalValidation?.status === "warning"
  ) {
    responses.push({
      actionType: "return-to-reviewer",
      title: "إعادة للمدقق الكهربائي",
      text: "يرجى استكمال المخطط الكهربائي مع بيان اللوحات والأحمال والإنارة بوضوح، إذ لم تظهر في الملف الحالي مؤشرات كافية لاعتماد المراجعة الكهربائية.",
      rationale:
        "من المناسب إعادة الملف لمدقق التخصص بعد استكمال البيانات الكهربائية.",
      source: "rule",
    });
  }

  if (
    missingDocuments.includes("مخطط الأمن والسلامة") ||
    safetyValidation?.status === "warning"
  ) {
    responses.push({
      actionType: "return-to-reviewer",
      title: "إعادة لمدقق السلامة",
      text: "يرجى تزويدنا بمخطط الأمن والسلامة بصورة أوضح تبين مخارج الطوارئ ووسائل الإنذار والإطفاء، لأن الشواهد الحالية لا تكفي لاعتماد السلامة.",
      rationale: "السلامة تحتاج تحقق تخصصي بعد اكتمال الشواهد داخل اللوحة.",
      source: "rule",
    });
  }

  if (status === "ready") {
    responses.push({
      actionType: "escalate-to-supervisor",
      title: "إحالة إلى المشرف",
      text: `تمت مراجعة المعاملة وفق سياسة ${policy.title}، والملف الحالي يظهر جاهزية مبدئية للإحالة إلى المشرف مع استمرار التحقق البلدي النهائي.`,
      rationale: "لا توجد نواقص حرجة تمنع رفع المعاملة للمستوى الإشرافي.",
      source: "rule",
    });
  }

  if (responses.length === 0) {
    responses.push({
      actionType: "return-to-reviewer",
      title: "إعادة للمراجع البلدي",
      text: "يرجى مراجعة التنبيهات الظاهرة في الملف واستكمال أي ملاحظات تشغيلية قبل إعادة الإحالة للمراجع البلدي.",
      rationale:
        "لا يوجد إجراء نوعي أوضح من إعادة الملف إلى مسار المراجعة التشغيلية الحالية.",
      source: "rule",
    });
  }

  return responses.filter(
    (response, index, allResponses) =>
      allResponses.findIndex((item) => item.text === response.text) === index,
  );
}

function localizeValidation(
  validation: DocumentValidation,
  locale: Locale,
): DocumentValidation {
  return {
    ...validation,
    summary: translateDisplayText(validation.summary, locale),
    details: validation.details.map((detail) =>
      translateDisplayText(detail, locale),
    ),
  };
}

function localizeSuggestedResponse(
  response: SuggestedResponse,
  locale: Locale,
): SuggestedResponse {
  return {
    ...response,
    title: translateDisplayText(response.title, locale),
    text: translateDisplayText(response.text, locale),
    rationale: response.rationale
      ? translateDisplayText(response.rationale, locale)
      : response.rationale,
  };
}

export function reviewApplication(
  policy: LicensePolicy,
  form: SubmissionForm,
  locale: Locale = "ar",
): ReviewResult {
  const matchedDocuments = policy.requiredDocuments.filter((document) =>
    form.selectedDocuments.includes(document),
  );
  const missingDocuments = policy.requiredDocuments.filter(
    (document) => !form.selectedDocuments.includes(document),
  );
  const documentValidations: DocumentValidation[] = trackedValidationRules
    .filter((rule) => policy.requiredDocuments.includes(rule.documentName))
    .map((rule) =>
      validateTrackedDocument(
        form,
        rule.documentName,
        rule.keywordGroups,
        rule.successThreshold,
      ),
    );

  const policyEvidence = buildPolicyEvidence(policy);
  const documentEvidence = buildDocumentEvidence(
    policy,
    [...matchedDocuments, ...missingDocuments].slice(0, 12),
  );
  const workflowEvidence = buildWorkflowEvidence(policy);
  const sourcePath = getPolicyKnowledge(policy.id)?.sourcePath ?? "";
  const policyAlerts = unique([
    ...(form.uploadedAttachments.length === 0
      ? ["لم يتم رفع أي ملفات فعلية للتحليل حتى الآن."]
      : []),
    ...(missingDocuments.length > 0
      ? [
          `يوجد ${missingDocuments.length} مرفقات ناقصة مقارنة بسياسة ${policy.title}.`,
        ]
      : []),
    ...(form.projectDescription.trim().length < 20
      ? ["وصف المشروع قصير ولا يكفي لتقييم المخاطر الهندسية."]
      : []),
    ...(!form.district.trim() || !form.plotNumber.trim()
      ? ["بيانات الموقع غير مكتملة ويجب توضيح الحي ورقم القطعة."]
      : []),
    ...(form.uploadedAttachments.some(
      (attachment) => attachment.notes.length > 0,
    )
      ? [
          "بعض الملفات المرفوعة لم يتم التعرف عليها بالكامل وتحتاج مراجعة بشرية.",
        ]
      : []),
    ...(policy.category === "building" &&
    !form.selectedDocuments.includes("وثيقة التأمين")
      ? ["وثيقة التأمين غير مرفقة رغم أنها عنصر حرج في رخص البناء."]
      : []),
    ...(policy.category === "building" &&
    !form.selectedDocuments.includes("المخطط الإنشائي")
      ? ["المخطط الإنشائي مفقود ويمنع رفع التوصية النهائية للاعتماد."]
      : []),
    ...documentValidations
      .filter((validation) => validation.status === "warning")
      .map(
        (validation) =>
          `التحقق التفصيلي من ${validation.documentName} ما زال يحتاج مراجعة بشرية لأن مؤشرات الاكتمال داخل الملف غير كافية.`,
      ),
    ...documentValidations
      .filter((validation) => validation.status === "missing")
      .map(
        (validation) =>
          `${validation.documentName} غير متاح للتحقق التفصيلي ضمن الملفات الحالية.`,
      ),
    ...(policy.category === "demolition" &&
    !form.selectedDocuments.includes("خطاب تصفية (كهرباء، مياه، هاتف)")
      ? ["لا يمكن تمرير رخصة الهدم دون خطابات تصفية الخدمات."]
      : []),
    ...(policy.category === "site-prep" &&
    !form.selectedDocuments.includes("الموافقات الخارجية حسب نوع المعاملة")
      ? [
          "الموافقات الخارجية غير مرفقة، وهي مطلوبة قبل اكتمال رخصة تجهيز الموقع.",
        ]
      : []),
    ...(policy.category === "transfer" &&
    !form.selectedDocuments.includes("صورة من الوكالة الشرعية")
      ? ["معاملة نقل الملكية تحتاج وكالة شرعية عند وجود ممثل عن المالك."]
      : []),
  ]);

  const completenessScore = Math.round(
    (matchedDocuments.length / policy.requiredDocuments.length) * 100,
  );
  const score = Math.max(0, completenessScore - policyAlerts.length * 4);

  const status: ReviewResult["status"] =
    missingDocuments.length === 0 && policyAlerts.length <= 1
      ? "ready"
      : score >= 70
        ? "needs-info"
        : "blocked";

  const summaryByStatus: Record<ReviewResult["status"], string> = {
    ready: "الملف شبه مكتمل ويمكن إحالة المعاملة للمشرف مع تدقيق نهائي سريع.",
    "needs-info":
      "الملف قابل للمعالجة لكن يحتاج استكمالات قبل التوصية بالاعتماد.",
    blocked: "المخاطر مرتفعة والنواقص تمنع التوصية بالاعتماد في هذه المرحلة.",
  };

  const nextStepByStatus: Record<ReviewResult["status"], string> = {
    ready:
      "إحالة إلى المشرف للاعتماد النهائي مع الاحتفاظ بتوصية الذكاء الاصطناعي في الملف.",
    "needs-info":
      "إرجاع للمكتب الهندسي بطلب استكمال المرفقات الموضحة في التقرير.",
    blocked:
      "إيقاف المعاملة مؤقتاً وطلب استكمال الوثائق الأساسية قبل إعادة الفحص.",
  };

  const suggestedResponses = buildSuggestedResponses(
    policy,
    documentValidations,
    missingDocuments,
    status,
  );

  return {
    score,
    status,
    summary: translateDisplayText(summaryByStatus[status], locale),
    missingDocuments,
    matchedDocuments,
    policyAlerts: policyAlerts.map((alert) =>
      translateDisplayText(alert, locale),
    ),
    documentValidations: documentValidations.map((validation) =>
      localizeValidation(validation, locale),
    ),
    suggestedResponses: suggestedResponses.map((response) =>
      localizeSuggestedResponse(response, locale),
    ),
    nextStep: translateDisplayText(nextStepByStatus[status], locale),
    sourcePath,
    evidence: [
      ...policyEvidence,
      ...documentEvidence.slice(0, 6),
      ...workflowEvidence.slice(0, 4),
    ],
    documentEvidence,
    workflowEvidence,
  };
}
