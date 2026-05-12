import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { policies, emptyForm } from "./data/policyData";
import { requestLlmReview } from "./api/llmReview";
import { fetchJson, resolveApiUrl } from "./api/http";
import {
  analyzeAttachments,
  collectDetectedDocuments,
} from "./ai/attachmentAnalyzer";
import { getSearchTerms, normalizeArabic } from "./ai/policySearch";
import { reviewApplication } from "./ai/reviewEngine";
import {
  buildPolicyWithResolvedDocuments,
  formatChecklistDocumentLabel,
} from "./utils/policyRequiredDocuments";
import type {
  ApplicationRecord,
  AttachmentPreview,
  AttachmentAnalysisTraceEvent,
  DocumentValidation,
  EvidenceCitation,
  BasicFormFields,
  LicensePolicy,
  LlmReview,
  SubmissionForm,
  SuggestedResponse,
  SuggestedResponseActionType,
  UploadedAttachment,
} from "./types";

type ViewMode = "office" | "municipality";

type PreviewState = {
  fileName: string;
  kind: "pdf" | "html" | "image" | "unsupported";
  path?: string;
  sourceLabel?: string;
  url?: string;
  html?: string;
  message?: string;
};

type SourcePreviewResponse = {
  fileName: string;
  kind: "pdf" | "html" | "unsupported";
  url?: string;
  html?: string;
  message?: string;
};

type AttachmentReviewStatus = "passed" | "warning" | "missing";

type AttachmentReviewDetails = {
  attachmentId: string;
  status: AttachmentReviewStatus;
  summary: string;
  alerts: string[];
  strengths: string[];
  matchedDocuments: string[];
  validations: DocumentValidation[];
};

type DocumentUploadSlotStatus = "empty" | "passed" | "warning" | "missing";

type DocumentUploadSlotAnalysis = {
  status: DocumentUploadSlotStatus;
  summary: string;
  note?: string;
  confidence?: number;
};

type BulkUploadMatchOption = {
  documentName: string;
  score: number;
};

type BulkUploadPreviewItem = {
  id: string;
  file: File;
  selectedDocumentName: string;
  suggestedDocumentName: string;
  topCandidateDocumentName?: string;
  suggestions: BulkUploadMatchOption[];
};

const LEGACY_STORAGE_KEYS = [
  "riyadh-license-ai-poc.applications",
  "riyadh-license-ai-poc.selectedApplicationId",
];
const LEGACY_ATTACHMENT_CACHE_PREFIX =
  "riyadh-license-ai-poc.attachment-analysis.v4";
const ENABLE_DRAFT_LLM_REVIEW =
  String(
    import.meta.env.VITE_ENABLE_DRAFT_LLM_REVIEW || "false",
  ).toLowerCase() === "true";
const AI_ANALYSIS_ICON_URL =
  "https://static.thenounproject.com/png/6480915-200.png";

const statusLabel = {
  ready: "قابل للاعتماد",
  "needs-info": "بانتظار الاستكمال",
  blocked: "يتطلب معالجة",
};

const llmDecisionLabel = {
  "approve-with-human-check": "مناسب للاعتماد مع تحقق بشري",
  "needs-more-info": "بحاجة إلى استكمال معلومات",
  "reject-for-now": "غير مناسب حالياً",
};

const suggestedResponseActionLabel: Record<
  SuggestedResponseActionType,
  string
> = {
  "request-completion": "طلب استكمال",
  "return-to-reviewer": "إعادة للمدقق",
  "escalate-to-supervisor": "إحالة للمشرف",
};

const processSteps = {
  office: ["اختيار السياسة", "إدخال البيانات", "رفع الملفات", "إرسال الطلب"],
  municipality: ["الاستلام", "التدقيق", "طلب استكمال أو اعتماد"],
};

function getSubmissionValidationErrors(
  form: SubmissionForm,
  policy: LicensePolicy | null,
) {
  const errors: string[] = [];

  if (!form.applicantName.trim()) errors.push("اسم المستفيد مطلوب.");
  if (!form.nationalId.trim()) errors.push("الهوية أو السجل مطلوب.");
  if (!form.mobile.trim()) errors.push("رقم الجوال مطلوب.");
  if (!form.district.trim()) errors.push("بيانات الحي مطلوبة.");
  if (!form.plotNumber.trim()) errors.push("رقم القطعة أو المخطط مطلوب.");
  if (!policy) {
    errors.push("نوع السياسة مطلوب.");
  } else if ((policy.projectTypes?.length ?? 0) > 0 && !form.projectTypeGroupId) {
    errors.push("نوع المشروع مطلوب.");
  }
  if (policy && (policy.projectTypes?.length ?? 0) > 0 && !form.projectSubtypeId) {
    errors.push("التصنيف التفصيلي للمشروع مطلوب.");
  }
  if (form.projectDescription.trim().length < 20)
    errors.push("وصف المشروع يجب أن يكون أوضح وأطول من 20 حرفاً.");
  if (form.uploadedAttachments.length === 0)
    errors.push("يجب رفع ملف فعلي واحد على الأقل قبل الإرسال.");

  return errors;
}

function getProjectTypeGroups(policy: LicensePolicy) {
  return policy.projectTypes ?? [];
}

function getSelectedProjectTypeGroup(
  policy: LicensePolicy,
  projectTypeGroupId: string,
) {
  return getProjectTypeGroups(policy).find(
    (group) => group.id === projectTypeGroupId,
  );
}

function getSelectedProjectSubtype(
  policy: LicensePolicy,
  projectTypeGroupId: string,
  projectSubtypeId: string,
) {
  return getSelectedProjectTypeGroup(policy, projectTypeGroupId)?.subtypes.find(
    (subtype) => subtype.id === projectSubtypeId,
  );
}

function buildProjectTypeSummary(
  policy: LicensePolicy,
  projectTypeGroupId: string,
  projectSubtypeId: string,
) {
  const group = getSelectedProjectTypeGroup(policy, projectTypeGroupId);
  const subtype = getSelectedProjectSubtype(
    policy,
    projectTypeGroupId,
    projectSubtypeId,
  );

  if (!group) {
    return "غير محدد";
  }

  if (!subtype) {
    return group.title;
  }

  return `${group.title} / ${subtype.title}`;
}

function stripFileExtension(fileName: string) {
  return fileName.replace(/\.[^.]+$/u, "");
}

function isDeedAttachmentCandidate(attachment: UploadedAttachment) {
  const normalizedName = normalizeArabic(attachment.name);
  const normalizedDocument = normalizeArabic(attachment.requiredDocument || "");
  const normalizedExcerpt = normalizeArabic(attachment.excerpt || "");
  return (
    normalizedDocument.includes(normalizeArabic("صورة الصك")) ||
    normalizedName.includes(normalizeArabic("صك")) ||
    normalizedExcerpt.includes(normalizeArabic("صك"))
  );
}

function mergeBasicFormFieldsFromAttachments(attachments: UploadedAttachment[]) {
  const orderedAttachments = [...attachments].sort((left, right) => {
    const leftPriority = isDeedAttachmentCandidate(left) ? 0 : 1;
    const rightPriority = isDeedAttachmentCandidate(right) ? 0 : 1;
    return leftPriority - rightPriority;
  });

  const merged: Partial<BasicFormFields> = {};
  orderedAttachments.forEach((attachment) => {
    const fields = attachment.basicFields;
    if (!fields) {
      return;
    }

    (Object.keys(fields) as (keyof BasicFormFields)[]).forEach((key) => {
      if (!merged[key] && fields[key]) {
        merged[key] = fields[key];
      }
    });
  });

  return merged;
}

function buildFilenameMatchTerms(documentName: string) {
  return uniqueStrings([
    documentName,
    formatChecklistDocumentLabel(documentName),
    ...getSearchTerms(documentName),
  ])
    .map((term) => normalizeArabic(term))
    .filter(Boolean);
}

function scoreFilenameAgainstDocument(fileName: string, documentName: string) {
  const normalizedFileName = normalizeArabic(
    stripFileExtension(fileName).replace(/[_\-.]+/gu, " "),
  );
  if (!normalizedFileName) {
    return 0;
  }

  const normalizedDocumentName = normalizeArabic(documentName);
  const terms = buildFilenameMatchTerms(documentName);
  let score = 0;

  terms.forEach((term) => {
    if (!term || !normalizedFileName.includes(term)) {
      return;
    }

    score += Math.max(6, term.length * 3);
    if (term === normalizedDocumentName) {
      score += 20;
    }
  });

  return score;
}

function findBestFilenameDocumentMatch(
  fileName: string,
  requiredDocuments: string[],
) {
  const scoredDocuments = requiredDocuments
    .map((documentName) => ({
      documentName,
      score: scoreFilenameAgainstDocument(fileName, documentName),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  return scoredDocuments[0] ?? null;
}

function buildFilenameMatchOptions(
  fileName: string,
  requiredDocuments: string[],
) {
  return requiredDocuments
    .map((documentName) => ({
      documentName,
      score: scoreFilenameAgainstDocument(fileName, documentName),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);
}

function buildBulkUploadPreviewItems(
  files: File[],
  requiredDocuments: string[],
) {
  const items: BulkUploadPreviewItem[] = files.map((file, index) => {
    const suggestions = buildFilenameMatchOptions(file.name, requiredDocuments);
    return {
      id: `${file.name}-${file.size}-${file.lastModified}-${index}`,
      file,
      selectedDocumentName: "",
      suggestedDocumentName: "",
      topCandidateDocumentName: suggestions[0]?.documentName,
      suggestions,
    };
  });

  const reservedDocuments = new Set<string>();
  const rankedItems = [...items].sort((left, right) => {
    const leftScore = left.suggestions[0]?.score ?? 0;
    const rightScore = right.suggestions[0]?.score ?? 0;
    return rightScore - leftScore;
  });

  rankedItems.forEach((item) => {
    const selectedMatch = item.suggestions.find(
      (suggestion) => !reservedDocuments.has(suggestion.documentName),
    );

    if (!selectedMatch) {
      return;
    }

    item.selectedDocumentName = selectedMatch.documentName;
    item.suggestedDocumentName = selectedMatch.documentName;
    reservedDocuments.add(selectedMatch.documentName);
  });

  return items;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function getValidatedDocumentNames(validations: DocumentValidation[]) {
  return uniqueStrings(
    validations
      .filter((validation) => validation.status === "passed")
      .map((validation) => validation.documentName),
  );
}

function getWarningDocumentNames(validations: DocumentValidation[]) {
  return uniqueStrings(
    validations
      .filter((validation) => validation.status === "warning")
      .map((validation) => validation.documentName),
  );
}

function buildAttachmentReviewDetails(
  attachment: UploadedAttachment,
  validations: DocumentValidation[],
): AttachmentReviewDetails {
  const relatedValidations = validations.filter((validation) =>
    attachment.detectedDocuments.includes(validation.documentName),
  );
  const warningValidations = relatedValidations.filter(
    (validation) => validation.status === "warning",
  );
  const passedValidations = relatedValidations.filter(
    (validation) => validation.status === "passed",
  );

  const alerts = uniqueStrings([
    ...(attachment.aiValidation?.status === "missing"
      ? [attachment.aiValidation.summary]
      : []),
    ...(attachment.aiValidation?.status === "warning"
      ? [attachment.aiValidation.summary]
      : []),
    ...(attachment.aiValidation?.feedback ?? []),
    ...(!attachment.aiValidation && attachment.detectedDocuments.length === 0
      ? ["لم يتم ربط هذا الملف بأي مستند مطلوب من القائمة الحالية."]
      : []),
    ...(!attachment.aiValidation && attachment.extractedText.trim().length < 80
      ? ["النص المستخرج من هذا الملف محدود، وقد تحتاج القراءة إلى ملف أوضح."]
      : []),
    ...warningValidations.map(
      (validation) =>
        `${formatChecklistDocumentLabel(validation.documentName)} موجود في هذا الملف لكنه ما زال يحتاج تدقيقاً بشرياً.`,
    ),
  ]);

  const strengths = uniqueStrings([
    ...(attachment.aiValidation?.status === "passed"
      ? [attachment.aiValidation.summary]
      : []),
    ...attachment.detectedDocuments.map(
      (documentName) =>
        `تم ربط الملف مع ${formatChecklistDocumentLabel(documentName)}.`,
    ),
    ...passedValidations.map(
      (validation) =>
        `${formatChecklistDocumentLabel(validation.documentName)} يحمل مؤشرات كافية داخل هذا الملف.`,
    ),
  ]);

  const status: AttachmentReviewStatus =
    attachment.aiValidation?.status === "passed"
      ? "passed"
      : attachment.aiValidation?.status === "warning"
        ? "warning"
        : attachment.aiValidation?.status === "missing"
          ? "missing"
          : attachment.detectedDocuments.length === 0
            ? "missing"
            : alerts.length > 0
              ? "warning"
              : "passed";

  const summary =
    attachment.aiValidation?.summary ||
    "تعذر استكمال قراءة هذا الملف آلياً في الوقت الحالي.";

  return {
    attachmentId: attachment.id,
    status,
    summary,
    alerts,
    strengths,
    matchedDocuments: attachment.detectedDocuments,
    validations: relatedValidations,
  };
}

function buildAttachmentReviewCollection(
  attachments: UploadedAttachment[],
  validations: DocumentValidation[],
) {
  return attachments.map((attachment) =>
    buildAttachmentReviewDetails(attachment, validations),
  );
}

function getAttachmentForRequiredDocument(
  attachments: UploadedAttachment[],
  documentName: string,
) {
  return attachments.find(
    (attachment) => attachment.requiredDocument === documentName,
  );
}

function buildDocumentUploadSlotAnalysis(
  documentName: string,
  attachment: UploadedAttachment | undefined,
  validations: DocumentValidation[],
): DocumentUploadSlotAnalysis {
  if (!attachment) {
    return {
      status: "empty",
      summary: "",
    };
  }

  const validation = validations.find(
    (item) => item.documentName === documentName,
  );
  const matchesTarget = attachment.detectedDocuments.includes(documentName);

  if (attachment.aiValidation) {
    return {
      status: attachment.aiValidation.status,
      summary: attachment.aiValidation.summary,
      note: attachment.aiValidation.feedback[0] || undefined,
      confidence:
        Number.isFinite(attachment.aiValidation.confidence) &&
        attachment.aiValidation.confidence > 0
          ? attachment.aiValidation.confidence
          : undefined,
    };
  }

  if (attachment.basicFields && isDeedAttachmentCandidate(attachment)) {
    return {
      status: "passed",
      summary: "تم استخراج الحقول الأساسية من صورة الصك بنجاح.",
      note: "تمت تعبئة الحقول الأساسية من الاستخراج الموجه بدلاً من التحليل العام.",
    };
  }

  return {
    status: "warning",
    summary:
      attachment.extractedText.trim().length > 0
        ? "تمت قراءة الملف، لكن التحليل التفصيلي ما زال يحتاج تدقيقاً إضافياً."
        : "تعذر استكمال قراءة هذا الملف آلياً في الوقت الحالي.",
    note: undefined,
  };
}

function buildOfficeReply(
  application: ApplicationRecord,
  policy: LicensePolicy,
) {
  const missingItems = Array.from(
    new Set([
      ...(application.review.missingDocuments ?? []),
      ...(application.llmReview?.missingItems ?? []),
    ]),
  ).slice(0, 6);
  const actions = (application.llmReview?.suggestedActions ?? []).slice(0, 3);
  const statusText =
    application.review.status === "ready"
      ? "بعد مراجعة الطلب، يظهر أن المعاملة قابلة للاستكمال النهائي مع تحقق بلدي أخير."
      : application.review.status === "needs-info"
        ? "بعد مراجعة الطلب، تحتاج المعاملة إلى استكمالات قبل المتابعة للاعتماد."
        : "بعد مراجعة الطلب، لا يمكن متابعة المعاملة حالياً قبل معالجة النواقص النظامية الأساسية.";

  const missingText =
    missingItems.length > 0
      ? `يرجى تزويدنا بـ: ${missingItems.join("، ")}.`
      : "لا توجد نواقص جوهرية إضافية مسجلة على المرفقات الحالية.";

  const actionText =
    actions.length > 0
      ? `الإجراء المقترح: ${actions.join(" ")}.`
      : `المرجع المستخدم في المراجعة: ${policy.title}.`;

  return `${statusText} ${missingText} ${actionText}`.trim();
}

function normalizeSuggestedResponsesForDisplay(
  value: unknown,
): SuggestedResponse[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: SuggestedResponse[] = [];

  for (const item of value) {
    if (typeof item === "string") {
      normalized.push({
        actionType: "request-completion",
        title: "طلب استكمال",
        text: item,
        rationale: "",
        source: "rule",
      });
      continue;
    }

    if (
      !item ||
      typeof item !== "object" ||
      !("text" in item) ||
      typeof item.text !== "string"
    ) {
      continue;
    }

    const actionType: SuggestedResponseActionType =
      item.actionType === "return-to-reviewer" ||
      item.actionType === "escalate-to-supervisor" ||
      item.actionType === "request-completion"
        ? item.actionType
        : "request-completion";

    normalized.push({
      actionType,
      title:
        typeof item.title === "string" && item.title.trim()
          ? item.title
          : suggestedResponseActionLabel[actionType],
      text: item.text,
      rationale: typeof item.rationale === "string" ? item.rationale : "",
      source: item.source === "ai" ? "ai" : "rule",
    });
  }

  return normalized;
}

function buildSubmissionFromApplication(
  application: ApplicationRecord,
): SubmissionForm {
  return {
    applicantName: application.applicantName,
    nationalId: "",
    officeName: application.officeName,
    officeLicense: "",
    mobile: "",
    district: application.district,
    plotNumber: application.plotNumber,
    projectTypeGroupId: application.projectTypeGroupId ?? "",
    projectSubtypeId: application.projectSubtypeId ?? "",
    projectDescription: application.projectDescription,
    selectedDocuments: application.selectedDocuments,
    comments: application.comments,
    uploadedAttachments: application.uploadedAttachments.map((attachment) => ({
      ...attachment,
      requiredDocument:
        attachment.requiredDocument ||
        attachment.detectedDocuments[0] ||
        undefined,
    })),
  };
}

function getFileNameFromPath(pathValue: string) {
  return pathValue.split(/[\\/]/).filter(Boolean).pop() || pathValue;
}

function FileReferenceAction({
  path,
  onPreview,
}: {
  path: string;
  onPreview: (path: string) => void;
}) {
  if (!path) {
    return null;
  }

  const fileName = getFileNameFromPath(path);
  const extension = path.toLowerCase().split(".").pop();
  const canPreview = ["pdf", "docx", "txt", "md", "json"].includes(
    extension ?? "",
  );

  return (
    <div className="file-reference-actions">
      <span>{fileName}</span>
      {canPreview ? (
        <button
          type="button"
          className="ghost-button file-preview-button"
          onClick={() => onPreview(path)}
        >
          معاينة الملف
        </button>
      ) : (
        <details className="path-reveal">
          <summary>عرض المسار</summary>
          <small>{path}</small>
        </details>
      )}
    </div>
  );
}

function AttachmentPreviewAction({
  attachment,
  onPreview,
}: {
  attachment: UploadedAttachment;
  onPreview: (attachment: UploadedAttachment) => void;
}) {
  if (!attachment.preview || attachment.preview.kind === "unsupported") {
    return null;
  }

  return (
    <button
      type="button"
      className="ghost-button file-preview-button"
      onClick={() => onPreview(attachment)}
    >
      معاينة الملف
    </button>
  );
}

function HelpHint({ text }: { text: string }) {
  return (
    <span className="help-hint" title={text} aria-label={text}>
      i
    </span>
  );
}

function ProcessStrip({
  steps,
  activeIndex,
}: {
  steps: string[];
  activeIndex: number;
}) {
  return (
    <div className="process-strip">
      {steps.map((step, index) => (
        <div
          key={step}
          className={`process-chip ${index <= activeIndex ? "active" : ""}`}
        >
          <span>{index + 1}</span>
          <strong>{step}</strong>
        </div>
      ))}
    </div>
  );
}

function SmartDisclosure({
  title,
  count,
  children,
  defaultOpen = false,
}: {
  title: string;
  count?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="smart-disclosure">
      <button
        type="button"
        className="smart-disclosure-trigger"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span>{title}</span>
        <span className="smart-disclosure-summary-meta">
          {count !== undefined && count !== null ? (
            <strong>{count}</strong>
          ) : null}
          <span className="smart-disclosure-toggle" aria-hidden="true">
            {isOpen ? "▾" : "▸"}
          </span>
        </span>
      </button>
      {isOpen ? <div className="smart-disclosure-body">{children}</div> : null}
    </div>
  );
}

function ReviewGlance({
  items,
}: {
  items: Array<{
    label: string;
    value: string | number;
    tone?: "default" | "success" | "warning" | "danger";
  }>;
}) {
  return (
    <div className="review-glance-grid">
      {items.map((item) => (
        <div
          key={item.label}
          className={`glance-card ${item.tone ?? "default"}`}
        >
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

function ValidationStatusLabel({
  status,
}: {
  status: "passed" | "warning" | "missing";
}) {
  const label =
    status === "passed"
      ? "مكتمل"
      : status === "warning"
        ? "يحتاج تدقيق"
        : "غير متاح";
  return <span className={`status-pill validation-${status}`}>{label}</span>;
}

function selectDocumentValidations(
  llmReview: LlmReview | null | undefined,
  fallbackValidations: ApplicationRecord["review"]["documentValidations"],
) {
  return llmReview?.documentValidations?.length
    ? llmReview.documentValidations
    : fallbackValidations;
}

function selectSuggestedResponses(
  llmReview: LlmReview | null | undefined,
  fallbackResponses: ApplicationRecord["review"]["suggestedResponses"],
) {
  const aiResponses = normalizeSuggestedResponsesForDisplay(
    llmReview?.suggestedResponses,
  );
  if (aiResponses.length > 0) {
    return aiResponses;
  }

  return normalizeSuggestedResponsesForDisplay(fallbackResponses);
}

function ValidationSourceLabel({ source }: { source?: "rule" | "ai" }) {
  const label = source === "ai" ? "من المراجعة الآلية" : "من التحقق النظامي";
  return (
    <span
      className={`status-pill validation-source ${source === "ai" ? "ai" : "rule"}`}
    >
      {label}
    </span>
  );
}

function SuggestedResponseActionLabel({
  actionType,
}: {
  actionType: SuggestedResponseActionType;
}) {
  return (
    <span className={`status-pill suggested-action ${actionType}`}>
      {suggestedResponseActionLabel[actionType]}
    </span>
  );
}

function ValidationCards({
  validations,
}: {
  validations: ApplicationRecord["review"]["documentValidations"];
}) {
  return (
    <div className="validation-stack">
      {validations.map((validation) => (
        <article
          key={validation.documentName}
          className={`validation-card ${validation.status}`}
        >
          <div className="validation-header">
            <strong>{validation.documentName}</strong>
            <div className="validation-badges">
              <ValidationSourceLabel source={validation.source} />
              <ValidationStatusLabel status={validation.status} />
            </div>
          </div>
          <p>{validation.summary}</p>
          {validation.details.length > 0 ||
          (validation.evidenceSnippets?.length ?? 0) > 0 ? (
            <details className="compact-inline-disclosure">
              <summary>عرض التفاصيل</summary>
              {validation.details.length > 0 ? (
                <ul>
                  {validation.details.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              ) : null}
              {validation.evidenceSnippets &&
              validation.evidenceSnippets.length > 0 ? (
                <div className="validation-evidence-block">
                  <strong>شواهد من الورقة</strong>
                  <div className="validation-evidence-list">
                    {validation.evidenceSnippets.map((snippet) => (
                      <p key={snippet} className="validation-evidence-snippet">
                        {snippet}
                      </p>
                    ))}
                  </div>
                </div>
              ) : null}
            </details>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function AttachmentReviewCards({
  attachments,
  validations,
  onPreviewAttachment,
}: {
  attachments: UploadedAttachment[];
  validations: DocumentValidation[];
  onPreviewAttachment: (attachment: UploadedAttachment) => void;
}) {
  const reviewItems = buildAttachmentReviewCollection(attachments, validations);

  return (
    <div className="attachment-stack compact">
      {attachments.map((attachment) => {
        const review =
          reviewItems.find((item) => item.attachmentId === attachment.id) ??
          buildAttachmentReviewDetails(attachment, validations);
        const checklistResults =
          attachment.aiValidation?.checklistResults ?? [];
        const validatedDocuments = getValidatedDocumentNames(
          review.validations,
        );
        const warningDocuments = getWarningDocumentNames(review.validations);

        return (
          <article
            key={attachment.id}
            className={`attachment-card compact ${review.status}`}
          >
            <div className="attachment-header">
              <div>
                <strong>{attachment.name}</strong>
                <span>
                  {attachment.sourceType} -{" "}
                  {Math.max(1, Math.round(attachment.size / 1024))} KB
                </span>
              </div>
              <div className="attachment-card-actions">
                <AttachmentPreviewAction
                  attachment={attachment}
                  onPreview={onPreviewAttachment}
                />
                <span className={`status-pill validation-${review.status}`}>
                  {review.status === "passed"
                    ? "واضح"
                    : review.status === "warning"
                      ? "يحتاج انتباهاً"
                      : "غير مرتبط"}
                </span>
              </div>
            </div>

            <p>{review.summary}</p>

            <div className="attachment-simple-grid">
              <div className="attachment-simple-section">
                <small>تم العثور عليه</small>
                {review.matchedDocuments.length > 0 ? (
                  <div className="attachment-tags">
                    {review.matchedDocuments.map((documentName) => (
                      <span key={documentName} className="tag success-tag">
                        {formatChecklistDocumentLabel(documentName)}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="attachment-empty-note">
                    لم يتم العثور على مستند مطلوب داخل هذا الملف.
                  </p>
                )}
              </div>

              <div className="attachment-simple-section">
                <small>تم التحقق منه</small>
                {validatedDocuments.length > 0 ? (
                  <div className="attachment-tags">
                    {validatedDocuments.map((documentName) => (
                      <span key={documentName} className="tag success-tag">
                        {formatChecklistDocumentLabel(documentName)}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="attachment-empty-note">
                    لا يوجد تحقق مكتمل بعد لهذا الملف.
                  </p>
                )}
              </div>

              <div className="attachment-simple-section">
                <small>يحتاج تدقيق</small>
                {warningDocuments.length > 0 ? (
                  <div className="attachment-tags">
                    {warningDocuments.map((documentName) => (
                      <span key={documentName} className="tag warning-tag">
                        {formatChecklistDocumentLabel(documentName)}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="attachment-empty-note">
                    لا توجد عناصر مفتوحة لهذا الملف.
                  </p>
                )}
              </div>
            </div>

            {review.alerts.length > 0 ||
            review.strengths.length > 0 ||
            review.validations.length > 0 ||
            checklistResults.length > 0 ? (
              <details className="compact-inline-disclosure attachment-extra-details">
                <summary>تفاصيل إضافية</summary>
                {review.alerts.length > 0 ? (
                  <div className="validation-evidence-block">
                    <strong>ملاحظات</strong>
                    <ul>
                      {review.alerts.map((alert) => (
                        <li key={alert}>{alert}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {review.validations.length > 0 ? (
                  <div className="validation-evidence-block">
                    <strong>نتائج التحقق</strong>
                    <ul>
                      {review.validations.map((validation) => (
                        <li key={validation.documentName}>
                          {formatChecklistDocumentLabel(
                            validation.documentName,
                          )}
                          : {validation.summary}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {checklistResults.length > 0 ? (
                  <div className="validation-evidence-block attachment-checklist-block">
                    <strong>نتائج فحص عناصر المخطط المعماري</strong>
                    <ul>
                      {checklistResults.map((result) => (
                        <li key={`${attachment.id}-${result.item}`}>
                          <strong>{result.item}</strong>
                          {`: ${
                            result.status === "Compliant"
                              ? "متوافق"
                              : result.status === "Non-Compliant"
                                ? "غير متوافق"
                                : "غير موجود"
                          } - ${result.comment}`}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {review.strengths.length > 0 ? (
                  <div className="validation-evidence-block">
                    <strong>ما يدعمه الملف</strong>
                    <ul>
                      {review.strengths.slice(0, 4).map((strength) => (
                        <li key={strength}>{strength}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </details>
            ) : null}
          </article>
        );
      })}
      {attachments.length === 0 ? (
        <div className="empty-attachments">لم يتم رفع ملفات بعد.</div>
      ) : null}
    </div>
  );
}

function SuggestedResponsesSection({
  responses,
  applicationId,
  onCopy,
}: {
  responses: SuggestedResponse[];
  applicationId: string;
  onCopy: (text: string, label: string) => Promise<void>;
}) {
  const actionOrder: SuggestedResponseActionType[] = [
    "request-completion",
    "return-to-reviewer",
    "escalate-to-supervisor",
  ];
  const groupedResponses = actionOrder
    .map((actionType) => ({
      actionType,
      items: responses.filter((response) => response.actionType === actionType),
    }))
    .filter((group) => group.items.length > 0);

  if (groupedResponses.length === 0) {
    return <p>لا توجد ردود مقترحة إضافية حالياً.</p>;
  }

  return (
    <div className="suggested-response-groups">
      {groupedResponses.map((group) => (
        <section key={group.actionType} className="suggested-response-group">
          <div className="suggested-response-group-header">
            <SuggestedResponseActionLabel actionType={group.actionType} />
            <strong>{suggestedResponseActionLabel[group.actionType]}</strong>
          </div>
          <div className="suggested-response-stack">
            {group.items.map((response, index) => (
              <article
                key={`${applicationId}-${group.actionType}-${index}`}
                className="suggested-response-card"
              >
                <div className="suggested-response-card-header">
                  <strong>{response.title}</strong>
                  <span
                    className={`status-pill validation-source ${response.source === "ai" ? "ai" : "rule"}`}
                  >
                    {response.source === "ai"
                      ? "من المراجعة الآلية"
                      : "من التحقق النظامي"}
                  </span>
                </div>
                <p>{response.text}</p>
                {response.rationale ? (
                  <small>{response.rationale}</small>
                ) : null}
                <button
                  className="ghost-button"
                  onClick={() => void onCopy(response.text, response.title)}
                >
                  نسخ الرد المقترح
                </button>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function AiAnalysisIcon({ className = "" }: { className?: string }) {
  return (
    <img
      className={["ai-analysis-icon", className].filter(Boolean).join(" ")}
      src={AI_ANALYSIS_ICON_URL}
      alt=""
      aria-hidden="true"
    />
  );
}

function LoadingBanner({
  message,
  icon = "spinner",
}: {
  message: string;
  icon?: "spinner" | "ai";
}) {
  return (
    <div
      className="upload-status loading-banner"
      role="status"
      aria-live="polite"
    >
      {icon === "ai" ? (
        <AiAnalysisIcon className="ai-analysis-icon-md ai-analysis-icon-pulse" />
      ) : (
        <span className="spinner" aria-hidden="true" />
      )}
      <span>{message}</span>
    </div>
  );
}

function AnalysisTracePanel({
  message,
  events,
  active,
}: {
  message: string;
  events: AttachmentAnalysisTraceEvent[];
  active: boolean;
}) {
  const successfulEvents = events.filter(
    (event) => event.status === "done",
  ).length;
  const runningEvents = events.filter(
    (event) => event.status === "running",
  ).length;

  return (
    <div className="analysis-trace-wrapper">
      <LoadingBanner message={message} icon="ai" />
      <details className="analysis-trace-panel">
        <summary>
          <span>سجل المعالجة</span>
          <strong>{events.length}</strong>
        </summary>
        <div className="analysis-trace-meta">
          <span>خطوات مكتملة: {successfulEvents}</span>
          <span>خطوات قيد التنفيذ: {runningEvents}</span>
          <span>
            يعرض هذا القسم ما تم تنفيذه على الملفات وملخص المخرجات التشغيلية.
          </span>
        </div>
        <div className="analysis-trace-list">
          {events.map((event) => (
            <article
              key={event.id}
              className={`analysis-trace-item ${event.status}`}
            >
              <div className="analysis-trace-header">
                <strong>{event.title}</strong>
                <span>{event.fileName ?? event.phase}</span>
              </div>
              <p>{event.detail}</p>
              {event.detectedDocuments && event.detectedDocuments.length > 0 ? (
                <div className="analysis-trace-tags">
                  {event.detectedDocuments.map((documentName) => (
                    <span
                      key={`${event.id}-${documentName}`}
                      className="tag success-tag"
                    >
                      {documentName}
                    </span>
                  ))}
                </div>
              ) : null}
              {event.model || event.responseSummary ? (
                <div className="analysis-trace-extra">
                  {event.model ? <small>النموذج: {event.model}</small> : null}
                  {event.responseSummary ? (
                    <small>ملخص الاستجابة: {event.responseSummary}</small>
                  ) : null}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </details>
    </div>
  );
}

function ComplianceReportSection({ review }: { review: LlmReview }) {
  const report = review.complianceReport;
  if (!report) {
    return null;
  }

  const missingAttachmentRows = report.attachmentsStatus.rows.filter(
    (row) => row.status === "Missing",
  );

  const formatConfidenceLevel = (value: string) => {
    if (value === "High") return "عالٍ";
    if (value === "Medium") return "متوسط";
    if (value === "Low") return "منخفض";
    return value;
  };

  const formatAttachmentStatus = (value: string) => {
    if (value === "Present") return "موجود";
    if (value === "Missing") return "مفقود";
    if (value === "Invalid / Unclear") return "غير واضح / غير صالح";
    return value;
  };

  const formatDataConsistencyStatus = (value: string) => {
    if (value === "Match") return "متطابق";
    if (value === "Mismatch") return "غير متطابق";
    if (value === "Missing") return "مفقود";
    return value;
  };

  const formatAttachmentAccuracyStatus = (value: string) => {
    if (value === "Valid") return "سليم";
    if (value === "Invalid") return "غير صالح";
    if (value === "Partially Valid") return "صالح جزئياً";
    return value;
  };

  const formatRequirementsStatus = (value: string) => {
    if (value === "Compliant") return "متوافق";
    if (value === "Not Compliant") return "غير متوافق";
    return value;
  };

  const formatChecklistStatus = (value: string) => {
    if (value === "Compliant") return "متوافق";
    if (value === "Non-Compliant") return "غير متوافق";
    if (value === "Not Found") return "غير موجود";
    return value;
  };

  const formatOverallStatus = (value: string) => {
    if (value === "Complete") return "مكتمل";
    if (value === "Incomplete") return "غير مكتمل";
    return value;
  };

  const formatFieldLabel = (value: string) => {
    if (value === "Plot Number") return "رقم القطعة";
    if (value === "Beneficiary Name") return "اسم المستفيد";
    if (value === "Engineering Office") return "المكتب الهندسي";
    if (value === "Plan Number") return "رقم المخطط";
    if (value === "Deed Number") return "رقم الصك";
    return value;
  };

  return (
    <SmartDisclosure title="تقرير الامتثال المنظم" defaultOpen>
      <div className="compliance-report-stack">
        <div className="review-card compact-card tone-neutral">
          <h4>1. معلومات المشروع</h4>
          <ul>
            <li>نوع المشروع: {report.projectInformation.projectType}</li>
            <li>
              مستوى الثقة:{" "}
              {formatConfidenceLevel(report.projectInformation.confidenceLevel)}
            </li>
          </ul>
        </div>

        <SmartDisclosure
          title="2. حالة المرفقات"
          count={report.attachmentsStatus.rows.length}
        >
          <div className="review-card compact-card tone-neutral">
            <p>
              الحالة العامة:{" "}
              {formatOverallStatus(report.attachmentsStatus.overallStatus)}
            </p>
            {missingAttachmentRows.length > 0 ? (
              <ul>
                {missingAttachmentRows.map((row) => (
                  <li key={row.attachment}>
                    {row.attachment}: هذا المرفق مفقود ويجب استكماله.
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="table-scroll">
            <table className="compliance-table">
              <thead>
                <tr>
                  <th>المرفق</th>
                  <th>الحالة</th>
                  <th>الملاحظات</th>
                </tr>
              </thead>
              <tbody>
                {report.attachmentsStatus.rows.map((row) => (
                  <tr key={row.attachment}>
                    <td>{row.attachment}</td>
                    <td>{formatAttachmentStatus(row.status)}</td>
                    <td>{row.notes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SmartDisclosure>

        <SmartDisclosure
          title="3. التحقق من اتساق البيانات"
          count={report.dataConsistencyCheck.length}
        >
          <div className="table-scroll">
            <table className="compliance-table">
              <thead>
                <tr>
                  <th>الحقل</th>
                  <th>الصك</th>
                  <th>المستندات الأخرى</th>
                  <th>الحالة</th>
                </tr>
              </thead>
              <tbody>
                {report.dataConsistencyCheck.map((row) => (
                  <tr key={row.field}>
                    <td>{formatFieldLabel(row.field)}</td>
                    <td>{row.sak}</td>
                    <td>{row.otherDocs}</td>
                    <td>{formatDataConsistencyStatus(row.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SmartDisclosure>

        <SmartDisclosure title="4. دقة المرفقات">
          <div className="review-card compact-card tone-neutral">
            <p>
              {formatAttachmentAccuracyStatus(report.attachmentAccuracy.status)}
            </p>
            <h5>ملاحظات:</h5>
            {report.attachmentAccuracy.notes.length > 0 ? (
              <ul>
                {report.attachmentAccuracy.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </SmartDisclosure>

        <SmartDisclosure
          title="5. الامتثال المعماري"
          count={report.architecturalCompliance.notesForCheck.length}
          defaultOpen
        >
          <div className="review-card compact-card tone-neutral">
            <h5>5.1 الامتثال للاشتراطات:</h5>
            <p>
              {formatRequirementsStatus(
                report.architecturalCompliance.requirementsCompliance,
              )}
            </p>
          </div>

          <div className="review-card compact-card tone-neutral">
            <h5>5.2 عناصر التدقيق:</h5>
          </div>
          <div className="table-scroll">
            <table className="compliance-table">
              <thead>
                <tr>
                  <th>العنصر</th>
                  <th>الحالة</th>
                  <th>التعليق</th>
                </tr>
              </thead>
              <tbody>
                {report.architecturalCompliance.notesForCheck.map((row) => (
                  <tr key={`${row.item}-${row.comment}`}>
                    <td>{row.item}</td>
                    <td>{formatChecklistStatus(row.status)}</td>
                    <td>{row.comment}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="review-card compact-card tone-warning">
            <h5>5.3 المخالفات:</h5>
            <ul>
              {report.architecturalCompliance.violations.map((item) => (
                <li key={item}>{item}</li>
              ))}
              {report.architecturalCompliance.violations.length === 0 ? (
                <li>لم يتم العثور على مخالفات مؤكدة ضمن الأدلة الحالية.</li>
              ) : null}
            </ul>
          </div>
        </SmartDisclosure>

        <div className="review-card compact-card tone-neutral">
          <h4>6. الملخص النهائي</h4>
          <ul>
            <li>المرفقات: {report.finalSummary.attachments}</li>
            <li>اتساق البيانات: {report.finalSummary.dataConsistency}</li>
            <li>
              الامتثال المعماري: {report.finalSummary.architecturalCompliance}
            </li>
          </ul>
          <h5>القضايا الرئيسية:</h5>
          <ul>
            {report.finalSummary.keyIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
            {report.finalSummary.keyIssues.length === 0 ? (
              <li>لا توجد قضايا حرجة مسجلة.</li>
            ) : null}
          </ul>
        </div>
      </div>
    </SmartDisclosure>
  );
}

function LlmSupportContent({
  review,
  loading,
  error,
  onPreviewSource,
}: {
  review: LlmReview | null | undefined;
  loading: boolean;
  error: string;
  onPreviewSource: (path: string) => void;
}) {
  return (
    <>
      {error ? <div className="upload-status error">{error}</div> : null}
      {loading ? (
        <LoadingBanner
          message="جاري استكمال المراجعة المساندة وربط نتائج الملفات بالمرجع التنظيمي."
          icon="ai"
        />
      ) : null}

      {review ? (
        <>
          <div className="section-title-row">
            <h4>المراجعة المساندة</h4>
            <HelpHint text="يعرض هذا القسم خلاصات داعمة للمراجع، بينما تبقى التفاصيل الطويلة ضمن أقسام قابلة للتوسيع عند الحاجة." />
          </div>
          <div className="llm-metrics">
            <div className="detail-card llm-decision-card">
              <span>القرار المقترح</span>
              <strong>{llmDecisionLabel[review.decision]}</strong>
            </div>
            <div className="detail-card">
              <span>مستوى الثقة</span>
              <strong>{review.confidence}%</strong>
            </div>
            <div className="detail-card">
              <span className="ai-model-label">
                <AiAnalysisIcon className="ai-analysis-icon-xs" />
                <span>المحرك المستخدم</span>
              </span>
              <strong>{review.model}</strong>
            </div>
          </div>

          <p className="llm-summary">{review.summary}</p>
          <small className="llm-timestamp">
            آخر توليد: {new Date(review.generatedAt).toLocaleString("ar-SA")}
          </small>

          <ComplianceReportSection review={review} />

          <div className="llm-disclosures">
            <SmartDisclosure
              title="أسباب التوصية"
              count={review.reasoning.length}
            >
              <ul>
                {review.reasoning.map((item) => (
                  <li key={item}>{item}</li>
                ))}
                {review.reasoning.length === 0 ? (
                  <li>لم يعرض النموذج أسباباً إضافية.</li>
                ) : null}
              </ul>
            </SmartDisclosure>

            <SmartDisclosure
              title="العناصر الناقصة"
              count={review.missingItems.length}
            >
              <ul>
                {review.missingItems.map((item) => (
                  <li key={item}>{item}</li>
                ))}
                {review.missingItems.length === 0 ? (
                  <li>لا توجد عناصر ناقصة إضافية وفق المراجعة اللغوية.</li>
                ) : null}
              </ul>
            </SmartDisclosure>

            <SmartDisclosure
              title="المخاطر والقيود"
              count={review.risks.length}
            >
              <ul>
                {review.risks.map((item) => (
                  <li key={item}>{item}</li>
                ))}
                {review.risks.length === 0 ? (
                  <li>لا توجد مخاطر إضافية بارزة.</li>
                ) : null}
              </ul>
            </SmartDisclosure>

            <SmartDisclosure
              title="الإجراءات المقترحة"
              count={review.suggestedActions.length}
            >
              <ul>
                {review.suggestedActions.map((item) => (
                  <li key={item}>{item}</li>
                ))}
                {review.suggestedActions.length === 0 ? (
                  <li>لا توجد إجراءات مقترحة إضافية.</li>
                ) : null}
              </ul>
            </SmartDisclosure>

            <SmartDisclosure
              title="شواهد المراجعة"
              count={review.evidence.length}
            >
              <div className="citation-stack llm-evidence-stack">
                {review.evidence.map((item) => (
                  <article
                    key={`${item.label}-${item.sourcePath}-${item.excerpt}`}
                    className="citation-item"
                  >
                    <strong>{item.label}</strong>
                    <p>{item.excerpt}</p>
                    <em>{item.relevance}</em>
                    <FileReferenceAction
                      path={item.sourcePath}
                      onPreview={onPreviewSource}
                    />
                  </article>
                ))}
                {review.evidence.length === 0 ? (
                  <div className="empty-attachments">
                    لا توجد شواهد إضافية من مراجعة LLM.
                  </div>
                ) : null}
              </div>
            </SmartDisclosure>
          </div>
        </>
      ) : null}
    </>
  );
}

export default function App() {
  const [viewMode, setViewMode] = useState<ViewMode>("office");
  const [policyId, setPolicyId] = useState("");
  const [form, setForm] = useState<SubmissionForm>(emptyForm);
  const [applications, setApplications] = useState<ApplicationRecord[]>([]);
  const [selectedApplicationId, setSelectedApplicationId] = useState("");
  const [uploadingDocuments, setUploadingDocuments] = useState<string[]>([]);
  const [bulkUploadPreview, setBulkUploadPreview] = useState<
    BulkUploadPreviewItem[] | null
  >(null);
  const [bulkUploadPreviewError, setBulkUploadPreviewError] = useState("");
  const [isConfirmingBulkUpload, setIsConfirmingBulkUpload] = useState(false);
  const [analysisTrace, setAnalysisTrace] = useState<
    AttachmentAnalysisTraceEvent[]
  >([]);
  const [analysisError, setAnalysisError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [previewState, setPreviewState] = useState<PreviewState | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const trackedPreviewUrlsRef = useRef<Set<string>>(new Set());
  const lastDraftAutoReviewKey = useRef("");
  const lastApplicationAutoReviewKey = useRef("");

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    LEGACY_STORAGE_KEYS.forEach((storageKey) => {
      window.localStorage.removeItem(storageKey);
    });

    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const storageKey = window.localStorage.key(index);
      if (storageKey?.startsWith(LEGACY_ATTACHMENT_CACHE_PREFIX)) {
        window.localStorage.removeItem(storageKey);
      }
    }
  }, []);

  const selectedPolicy =
    policies.find((item) => item.id === policyId) ?? null;
  const activePolicy = selectedPolicy ?? policies[0];
  const activeScopedPolicy = buildPolicyWithResolvedDocuments(
    activePolicy,
    form.projectTypeGroupId,
    form.projectSubtypeId,
  );
  const activeProjectTypeGroups = selectedPolicy
    ? getProjectTypeGroups(selectedPolicy)
    : [];
  const activeProjectTypeGroup = selectedPolicy
    ? getSelectedProjectTypeGroup(selectedPolicy, form.projectTypeGroupId)
    : undefined;
  const draftReview = reviewApplication(activeScopedPolicy, form);
  const selectedApplication =
    applications.find((item) => item.id === selectedApplicationId) ??
    applications[0] ??
    null;
  const extractedBasicFields = mergeBasicFormFieldsFromAttachments(
    form.uploadedAttachments,
  );
  useEffect(() => {
    setForm((current) => {
      const extracted = mergeBasicFormFieldsFromAttachments(
        current.uploadedAttachments,
      );
      const nextForm = {
        ...current,
        applicantName: extracted.applicantName ?? "",
        nationalId: extracted.nationalId ?? "",
        officeName: extracted.officeName ?? "",
        officeLicense: extracted.officeLicense ?? "",
        district: extracted.district ?? "",
        plotNumber: extracted.plotNumber ?? "",
      };

      return Object.entries(nextForm).every(
        ([key, value]) => current[key as keyof SubmissionForm] === value,
      )
        ? current
        : nextForm;
    });
  }, [form.uploadedAttachments]);

  const submissionValidationErrors = getSubmissionValidationErrors(
    form,
    selectedPolicy,
  );
  const requiresProjectSubtypeSelection = activeProjectTypeGroups.length > 0;
  const canUploadFiles =
    Boolean(selectedPolicy) &&
    (!requiresProjectSubtypeSelection ||
      Boolean(form.projectTypeGroupId && form.projectSubtypeId));
  const isAnalyzing = uploadingDocuments.length > 0;
  const hasBulkUploadPreview =
    bulkUploadPreview !== null && bulkUploadPreview.length > 0;
  const uploadLockMessage = !selectedPolicy
    ? "اختر نوع السياسة أولاً قبل رفع أي ملف."
    : !requiresProjectSubtypeSelection
      ? ""
      : !form.projectTypeGroupId
      ? "اختر نوع المشروع أولاً قبل رفع أي ملف."
      : !form.projectSubtypeId
        ? "اختر التصنيف التفصيلي للمشروع قبل رفع أي ملف."
        : "";
  const canSubmit = submissionValidationErrors.length === 0 && !isAnalyzing;
  const hasUploadedFiles = form.uploadedAttachments.length > 0;
  const previewSourceName = previewState?.fileName ?? "";
  const previewSourceLabel =
    previewState?.sourceLabel ?? "معاينة مباشرة لملف المصدر";

  const draftLlmMutation = useMutation({
    mutationFn: requestLlmReview,
  });

  const applicationLlmMutation = useMutation({
    mutationFn: async ({ applicationId }: { applicationId: string }) => {
      const application = applications.find(
        (item) => item.id === applicationId,
      );
      if (!application) {
        throw new Error("تعذر العثور على المعاملة المطلوبة لتشغيل مراجعة LLM.");
      }

      const policy =
        policies.find((item) => item.id === application.policyId) ??
        policies[0];
      const scopedPolicy = buildPolicyWithResolvedDocuments(
        policy,
        application.projectTypeGroupId ?? "",
        application.projectSubtypeId ?? "",
      );
      const review = await requestLlmReview({
        policy: scopedPolicy,
        submission: buildSubmissionFromApplication(application),
        ruleReview: application.review,
      });

      return { applicationId, review };
    },
    onSuccess: ({ applicationId, review }) => {
      setApplications((current) =>
        current.map((application) =>
          application.id === applicationId
            ? { ...application, llmReview: review }
            : application,
        ),
      );
    },
  });

  const draftDisplayValidations = selectDocumentValidations(
    draftLlmMutation.data,
    draftReview.documentValidations,
  );
  const draftValidatedDocuments = getValidatedDocumentNames(
    draftDisplayValidations,
  );
  const selectedDisplayValidations = selectedApplication
    ? selectDocumentValidations(
        selectedApplication.llmReview,
        selectedApplication.review.documentValidations,
      )
    : [];
  const selectedValidatedDocuments = getValidatedDocumentNames(
    selectedDisplayValidations,
  );
  const draftAttachmentReviews = buildAttachmentReviewCollection(
    form.uploadedAttachments,
    draftDisplayValidations,
  );
  const selectedAttachmentReviews = selectedApplication
    ? buildAttachmentReviewCollection(
        selectedApplication.uploadedAttachments,
        selectedDisplayValidations,
      )
    : [];
  const selectedSuggestedResponses = selectedApplication
    ? selectSuggestedResponses(
        selectedApplication.llmReview,
        selectedApplication.review.suggestedResponses,
      )
    : [];

  function updateField<K extends keyof SubmissionForm>(
    field: K,
    value: SubmissionForm[K],
  ) {
    draftLlmMutation.reset();
    setSubmitError("");
    setForm((current) => ({ ...current, [field]: value }));
  }

  function applyBasicFieldsFromAttachments(
    attachments: UploadedAttachment[],
    currentForm: SubmissionForm,
  ) {
    const extracted = mergeBasicFormFieldsFromAttachments(attachments);
    return {
      ...currentForm,
      applicantName: extracted.applicantName ?? currentForm.applicantName,
      nationalId: extracted.nationalId ?? currentForm.nationalId,
      officeName: extracted.officeName ?? currentForm.officeName,
      officeLicense: extracted.officeLicense ?? currentForm.officeLicense,
      district: extracted.district ?? currentForm.district,
      plotNumber: extracted.plotNumber ?? currentForm.plotNumber,
    };
  }

  function clearBulkUploadPreview() {
    setBulkUploadPreview(null);
    setBulkUploadPreviewError("");
    setIsConfirmingBulkUpload(false);
  }

  function handlePolicyChange(nextPolicyId: string) {
    const nextPolicy =
      policies.find((item) => item.id === nextPolicyId) ?? null;
    setPolicyId(nextPolicy?.id ?? "");
    draftLlmMutation.reset();
    setSubmitError("");
    clearBulkUploadPreview();
    setForm((current) => ({
      ...current,
      projectTypeGroupId: "",
      projectSubtypeId: "",
      selectedDocuments: [],
    }));
  }

  function handleProjectTypeGroupChange(nextProjectTypeGroupId: string) {
    draftLlmMutation.reset();
    setAnalysisError("");
    setSubmitError("");
    clearBulkUploadPreview();
    setForm((current) => ({
      ...current,
      projectTypeGroupId: nextProjectTypeGroupId,
      projectSubtypeId: "",
      uploadedAttachments: [],
      selectedDocuments: [],
    }));
  }

  function handleProjectSubtypeChange(nextProjectSubtypeId: string) {
    draftLlmMutation.reset();
    setAnalysisError("");
    setSubmitError("");
    clearBulkUploadPreview();
    const nextScopedPolicy = buildPolicyWithResolvedDocuments(
      activePolicy,
      form.projectTypeGroupId,
      nextProjectSubtypeId,
    );
    setForm((current) => ({
      ...current,
      projectSubtypeId: nextProjectSubtypeId,
      uploadedAttachments: current.uploadedAttachments.filter(
        (attachment) =>
          !attachment.requiredDocument ||
          nextScopedPolicy.requiredDocuments.includes(
            attachment.requiredDocument,
          ),
      ),
      selectedDocuments: current.selectedDocuments.filter((documentName) =>
        nextScopedPolicy.requiredDocuments.includes(documentName),
      ),
    }));
  }

  async function uploadFileForDocument(documentName: string, file: File) {
    setUploadingDocuments((current) =>
      current.includes(documentName) ? current : [...current, documentName],
    );
    setSubmitError("");
    draftLlmMutation.reset();

    try {
      const focusedPolicy = {
        ...activeScopedPolicy,
        requiredDocuments: [documentName],
      };
      const analyzed = await analyzeAttachments([file], focusedPolicy, {
        onProgress: (event) => {
          setAnalysisTrace((current) => {
            if (!event.operationKey) {
              return [...current, event];
            }

            const existingIndex = current.findIndex(
              (item) => item.operationKey === event.operationKey,
            );
            if (existingIndex === -1) {
              return [...current, event];
            }

            const updated = [...current];
            updated[existingIndex] = {
              ...updated[existingIndex],
              ...event,
              id: updated[existingIndex].id,
            };
            return updated;
          });
        },
      });

      setForm((current) => {
        const replacement = analyzed.map((attachment) => ({
          ...attachment,
          requiredDocument: documentName,
        }));
        const uploadedAttachments = [
          ...current.uploadedAttachments.filter(
            (attachment) => attachment.requiredDocument !== documentName,
          ),
          ...replacement,
        ];
        return applyBasicFieldsFromAttachments(uploadedAttachments, {
          ...current,
          uploadedAttachments,
          selectedDocuments: collectDetectedDocuments(
            uploadedAttachments,
            activeScopedPolicy,
          ),
        });
      });

      return { ok: true as const };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "فشل تحليل الملفات المرفوعة.";
      return { ok: false as const, message };
    } finally {
      setUploadingDocuments((current) =>
        current.filter((item) => item !== documentName),
      );
    }
  }

  async function handleFileSelection(
    documentName: string,
    fileList: FileList | null,
  ) {
    if (!fileList || fileList.length === 0) {
      return;
    }

    if (!canUploadFiles) {
      setAnalysisError(
        uploadLockMessage ||
          "يجب اختيار نوع المشروع والتصنيف التفصيلي قبل رفع الملفات.",
      );
      return;
    }

    setAnalysisError("");
    clearBulkUploadPreview();
    const file = fileList[0];
    if (!file) {
      return;
    }

    const result = await uploadFileForDocument(documentName, file);
    if (!result.ok) {
      setAnalysisError(result.message);
    }
  }

  async function handleBulkFileSelection(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) {
      return;
    }

    if (!canUploadFiles) {
      setAnalysisError(
        uploadLockMessage ||
          "يجب اختيار نوع المشروع والتصنيف التفصيلي قبل رفع الملفات.",
      );
      return;
    }

    const files = Array.from(fileList);
    setAnalysisError("");
    setSubmitError("");
    draftLlmMutation.reset();

    const previewItems = buildBulkUploadPreviewItems(
      files,
      activeScopedPolicy.requiredDocuments,
    );
    setBulkUploadPreview(previewItems);
    setBulkUploadPreviewError(
      previewItems.some((item) => item.selectedDocumentName)
        ? ""
        : "لم يتم العثور على أي تطابق واضح تلقائياً. يمكنك تعيين المستندات يدوياً ثم بدء الرفع.",
    );
  }

  function updateBulkUploadPreviewSelection(
    previewItemId: string,
    nextDocumentName: string,
  ) {
    setBulkUploadPreview((current) => {
      if (!current) {
        return current;
      }

      return current.map((item) => {
        if (item.id === previewItemId) {
          return {
            ...item,
            selectedDocumentName: nextDocumentName,
          };
        }

        if (
          nextDocumentName &&
          item.selectedDocumentName === nextDocumentName
        ) {
          return {
            ...item,
            selectedDocumentName: "",
          };
        }

        return item;
      });
    });
    setBulkUploadPreviewError("");
  }

  async function confirmBulkUploadPreview() {
    if (!bulkUploadPreview || bulkUploadPreview.length === 0) {
      return;
    }

    const assignments = bulkUploadPreview.filter(
      (item) => item.selectedDocumentName,
    );

    if (assignments.length === 0) {
      setBulkUploadPreviewError(
        "اختر مستنداً واحداً على الأقل من المعاينة قبل بدء الرفع.",
      );
      return;
    }

    setBulkUploadPreviewError("");
    setAnalysisError("");
    setSubmitError("");
    setIsConfirmingBulkUpload(true);

    const uploadFailures: string[] = [];
    const skippedFiles = bulkUploadPreview
      .filter((item) => !item.selectedDocumentName)
      .map((item) => item.file.name);

    try {
      for (const assignment of assignments) {
        const result = await uploadFileForDocument(
          assignment.selectedDocumentName,
          assignment.file,
        );
        if (!result.ok) {
          uploadFailures.push(`${assignment.file.name}: ${result.message}`);
        }
      }

      const messages: string[] = [];
      if (skippedFiles.length > 0) {
        messages.push(
          `تم ترك هذه الملفات بدون رفع ضمن هذه الدفعة: ${skippedFiles.join("، ")}.`,
        );
      }
      if (uploadFailures.length > 0) {
        messages.push(`فشل تحليل بعض الملفات: ${uploadFailures.join("، ")}.`);
      }

      if (messages.length > 0) {
        setAnalysisError(messages.join(" "));
      }

      clearBulkUploadPreview();
    } finally {
      setIsConfirmingBulkUpload(false);
    }
  }

  function removeAttachment(documentName: string) {
    draftLlmMutation.reset();
    setSubmitError("");
    clearBulkUploadPreview();
    setForm((current) => {
      const uploadedAttachments = current.uploadedAttachments.filter(
        (attachment) => attachment.requiredDocument !== documentName,
      );
      return {
        ...current,
        uploadedAttachments,
        selectedDocuments: collectDetectedDocuments(
          uploadedAttachments,
          activeScopedPolicy,
        ),
      };
    });
  }

  useEffect(() => {
    if (!ENABLE_DRAFT_LLM_REVIEW) {
      return;
    }

    const hasMinimumDraftContext =
      form.uploadedAttachments.length > 0 &&
      form.projectDescription.trim().length >= 20 &&
      form.district.trim().length > 0 &&
      form.plotNumber.trim().length > 0;

    if (!hasMinimumDraftContext || draftLlmMutation.isPending) {
      return;
    }

    const nextKey = JSON.stringify({
      policyId: activePolicy.id,
      projectTypeGroupId: form.projectTypeGroupId,
      projectSubtypeId: form.projectSubtypeId,
      selectedDocuments: form.selectedDocuments,
      attachments: form.uploadedAttachments.map((attachment) => ({
        id: attachment.id,
        excerpt: attachment.excerpt,
        detectedDocuments: attachment.detectedDocuments,
        notes: attachment.notes,
      })),
      district: form.district,
      plotNumber: form.plotNumber,
      projectDescription: form.projectDescription,
      comments: form.comments,
    });

    if (nextKey === lastDraftAutoReviewKey.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      lastDraftAutoReviewKey.current = nextKey;
      draftLlmMutation.mutate({
        policy: activeScopedPolicy,
        submission: form,
        ruleReview: draftReview,
      });
    }, 1200);

    return () => window.clearTimeout(timeoutId);
  }, [activeScopedPolicy, draftLlmMutation, draftReview, form]);

  useEffect(() => {
    if (
      !selectedApplication ||
      selectedApplication.llmReview ||
      applicationLlmMutation.isPending
    ) {
      return;
    }

    const nextKey = JSON.stringify({
      applicationId: selectedApplication.id,
      projectTypeGroupId: selectedApplication.projectTypeGroupId ?? "",
      projectSubtypeId: selectedApplication.projectSubtypeId ?? "",
      selectedDocuments: selectedApplication.selectedDocuments,
      attachments: selectedApplication.uploadedAttachments.map(
        (attachment) => ({
          id: attachment.id,
          excerpt: attachment.excerpt,
          detectedDocuments: attachment.detectedDocuments,
        }),
      ),
      status: selectedApplication.review.status,
    });

    if (nextKey === lastApplicationAutoReviewKey.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      lastApplicationAutoReviewKey.current = nextKey;
      applicationLlmMutation.mutate({ applicationId: selectedApplication.id });
    }, 900);

    return () => window.clearTimeout(timeoutId);
  }, [applicationLlmMutation, selectedApplication]);

  useEffect(() => {
    if (applications.length === 0) {
      if (selectedApplicationId) {
        setSelectedApplicationId("");
      }
      return;
    }

    if (!applications.some((item) => item.id === selectedApplicationId)) {
      setSelectedApplicationId(applications[0].id);
    }
  }, [applications, selectedApplicationId]);

  async function copyOfficeReply(application: ApplicationRecord) {
    const policy =
      policies.find((item) => item.id === application.policyId) ?? policies[0];
    const replyText = buildOfficeReply(application, policy);

    try {
      await navigator.clipboard.writeText(replyText);
      setCopyStatus(`تم نسخ الرد المقترح للمعاملة ${application.id}.`);
      window.setTimeout(() => setCopyStatus(""), 2200);
    } catch {
      setCopyStatus("تعذر نسخ الرد المقترح تلقائياً من المتصفح الحالي.");
      window.setTimeout(() => setCopyStatus(""), 2200);
    }
  }

  async function copySuggestedResponse(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus(`تم نسخ ${label}.`);
      window.setTimeout(() => setCopyStatus(""), 2200);
    } catch {
      setCopyStatus("تعذر نسخ النص المقترح تلقائياً من المتصفح الحالي.");
      window.setTimeout(() => setCopyStatus(""), 2200);
    }
  }

  async function openSourcePreview(path: string) {
    setPreviewLoading(true);
    setPreviewError("");

    try {
      const payload = await fetchJson<SourcePreviewResponse>(
        `/api/source-preview?path=${encodeURIComponent(path)}`,
        { method: "GET" },
        "تعذر تحميل معاينة الملف.",
      );

      setPreviewState({
        path,
        ...payload,
        sourceLabel: "معاينة مباشرة لملف المصدر",
        url: payload.url ? resolveApiUrl(payload.url) : undefined,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "تعذر تحميل معاينة الملف.";
      setPreviewError(message);
      setPreviewState({
        path,
        fileName: getFileNameFromPath(path),
        kind: "unsupported",
        sourceLabel: "معاينة مباشرة لملف المصدر",
        message,
      });
    } finally {
      setPreviewLoading(false);
    }
  }

  function closeSourcePreview() {
    setPreviewState(null);
    setPreviewLoading(false);
    setPreviewError("");
  }

  function openAttachmentPreview(attachment: UploadedAttachment) {
    if (!attachment.preview) {
      return;
    }

    setPreviewLoading(false);
    setPreviewError("");
    setPreviewState({
      fileName: attachment.preview.fileName,
      kind: attachment.preview.kind,
      sourceLabel: "معاينة الملف المرفوع",
      url: attachment.preview.url,
      html: attachment.preview.html,
      message: attachment.preview.message,
    });
  }

  useEffect(() => {
    const nextPreviewUrls = new Set<string>();
    const allUploadedAttachments = [
      ...form.uploadedAttachments,
      ...applications.flatMap((application) => application.uploadedAttachments),
    ];

    allUploadedAttachments.forEach((attachment) => {
      if (attachment.preview?.revokeObjectUrl && attachment.preview.url) {
        nextPreviewUrls.add(attachment.preview.url);
      }
    });

    trackedPreviewUrlsRef.current.forEach((previewUrl) => {
      if (!nextPreviewUrls.has(previewUrl)) {
        URL.revokeObjectURL(previewUrl);
      }
    });

    trackedPreviewUrlsRef.current = nextPreviewUrls;
  }, [applications, form.uploadedAttachments]);

  useEffect(() => {
    return () => {
      trackedPreviewUrlsRef.current.forEach((previewUrl) => {
        URL.revokeObjectURL(previewUrl);
      });
      trackedPreviewUrlsRef.current = new Set();
    };
  }, []);

  function submitApplication() {
    if (!canSubmit) {
      setSubmitError(submissionValidationErrors[0] ?? "الطلب غير مكتمل بعد.");
      return;
    }

    const created: ApplicationRecord = {
      id: `APP-${24000 + applications.length + 1}`,
      policyId: activePolicy.id,
      submittedAt: new Date()
        .toLocaleString("en-GB", { hour12: false })
        .replace(",", ""),
      source: "portal",
      applicantName: form.applicantName,
      officeName: form.officeName,
      district: form.district,
      plotNumber: form.plotNumber,
      projectTypeGroupId: form.projectTypeGroupId,
      projectSubtypeId: form.projectSubtypeId,
      projectDescription: form.projectDescription,
      selectedDocuments: form.selectedDocuments,
      comments: form.comments,
      uploadedAttachments: form.uploadedAttachments,
      llmReview: draftLlmMutation.data ?? null,
      review: draftReview,
    };

    setApplications((current) => [created, ...current]);
    setSelectedApplicationId(created.id);
    setViewMode("municipality");
    setForm(emptyForm);
    draftLlmMutation.reset();
    setAnalysisError("");
    setSubmitError("");
    lastDraftAutoReviewKey.current = "";
  }

  return (
    <div className="app-shell">
      <section className="top-strip">
        <div className="top-strip-title">أمانة منطقة الرياض</div>
        <div className="top-strip-meta">
          <span>منصة تشغيل داخلية لمراجعة رخص البناء</span>
          <span>الرياض</span>
        </div>
      </section>

      <header className="hero-card">
        <div className="hero-content">
          <div className="hero-heading-row">
            <div className="hero-title-block">
              <h1>
                منصة إثبات مفهوم لاعتماد رخص البناء بمساعدة الذكاء الاصطناعي
              </h1>
              <div className="hero-tag-row">
                <span className="brand-badge">استقبال ومراجعة الطلبات</span>
                <span className="eyebrow">تشغيل موحد لفرق المكاتب الهندسية  والأمانة</span>
              </div>
            </div>
            <div className="hero-logo-shell">
              <img
                className="brand-logo"
                src="https://www.alriyadh.gov.sa/images/logo.png"
                alt="شعار أمانة منطقة الرياض"
              />
            </div>
          </div>
          <div className="brand-copy">
            <span className="hero-kicker">أمانة منطقة الرياض</span>
            <span className="hero-subtitle">
              تشغيل موحد لرحلة المكاتب الهندسية  والأمانة من الاستقبال حتى الاعتماد
            </span>
          </div>
          <p>
            توحيد استقبال الطلبات الهندسية، فحص المرفقات، وإبراز مؤشرات الاكتمال
            والمخاطر قبل الإحالة إلى المراجع البلدي المختص.
          </p>
          <ProcessStrip
            steps={
              viewMode === "office"
                ? processSteps.office
                : processSteps.municipality
            }
            activeIndex={viewMode === "office" ? 2 : 1}
          />
        </div>
      </header>

      <section className="toolbar">
        <div className="segment-control">
          <button
            className={viewMode === "office" ? "active" : ""}
            onClick={() => setViewMode("office")}
          >
            واجهة المكتب الهندسي
          </button>
          <button
            className={viewMode === "municipality" ? "active" : ""}
            onClick={() => setViewMode("municipality")}
          >
            واجهة الأمانة والمراجعة
          </button>
        </div>
        <div className="legend-row">
          <span>المصدر</span>
          <HelpHint text="المراجعة تستند إلى لوائح ونماذج عربية فعلية مع قراءة للمرفقات المرفوعة وربطها بالمرجع المناسب عند الحاجة." />
        </div>
      </section>

      {viewMode === "office" ? (
        <main className="workspace-grid">
          <section className="panel panel-form">
            <div className="panel-header">
              <div className="section-title-row">
                <h2>إعداد الطلب</h2>
                <HelpHint text="ابدأ بالبيانات الأساسية ثم ارفع ملفاً فعلياً واحداً على الأقل ليبدأ الفحص وربط المرفقات بمتطلبات السياسة." />
              </div>
              <p>
                املأ البيانات الأساسية وارفع الملفات، ثم راجع مؤشرات الاكتمال
                قبل الإرسال.
              </p>
            </div>

            <label className="field">
              <span>نوع السياسة</span>
              <select
                value={policyId}
                onChange={(event) => handlePolicyChange(event.target.value)}
              >
                <option value="">اختر نوع السياسة</option>
                {policies.map((policy) => (
                  <option key={policy.id} value={policy.id}>
                    {policy.title}
                  </option>
                ))}
              </select>
            </label>

            {activeProjectTypeGroups.length > 0 ? (
              <div className="grid-two">
                <label className="field">
                  <span>نوع المشروع</span>
                  <select
                    value={form.projectTypeGroupId}
                    onChange={(event) =>
                      handleProjectTypeGroupChange(event.target.value)
                    }
                  >
                    <option value="">اختر نوع المشروع</option>
                    {activeProjectTypeGroups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.title}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="field">
                  <span>التصنيف التفصيلي للمشروع</span>
                  <select
                    value={form.projectSubtypeId}
                    onChange={(event) =>
                      handleProjectSubtypeChange(event.target.value)
                    }
                    disabled={!activeProjectTypeGroup}
                  >
                    <option value="">
                      {activeProjectTypeGroup
                        ? "اختر التصنيف التفصيلي"
                        : "اختر نوع المشروع أولاً"}
                    </option>
                    {(activeProjectTypeGroup?.subtypes ?? []).map((subtype) => (
                      <option key={subtype.id} value={subtype.id}>
                        {subtype.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ) : null}

            {activeProjectTypeGroups.length > 0 ? (
              <div className="review-card compact-note tone-neutral">
                <h3>تصنيف المشروع المعتمد للمراجعة</h3>
                <p>
                  {buildProjectTypeSummary(
                    activePolicy,
                    form.projectTypeGroupId,
                    form.projectSubtypeId,
                  )}
                </p>
                <small>
                  عدد المرفقات المطلوبة لهذا التصنيف:{" "}
                  {activeScopedPolicy.requiredDocuments.length}
                </small>
              </div>
            ) : null}

            <div className="review-card compact-card tone-neutral">
              <SmartDisclosure title="البيانات الأساسية للطلب">
                <div className="grid-two">
                  <label className="field">
                    <span>اسم المستفيد</span>
                    <input
                      value={form.applicantName || extractedBasicFields.applicantName || ""}
                      readOnly
                      aria-readonly="true"
                      placeholder="سيتم استخراجه من المرفقات"
                    />
                  </label>
                  <label className="field">
                    <span>الهوية / السجل</span>
                    <input
                      value={form.nationalId || extractedBasicFields.nationalId || ""}
                      readOnly
                      aria-readonly="true"
                      placeholder="سيتم استخراجه من المرفقات"
                    />
                  </label>
                  <label className="field">
                    <span>المكتب الهندسي</span>
                    <input
                      value={form.officeName || extractedBasicFields.officeName || ""}
                      onChange={(event) =>
                        updateField("officeName", event.target.value)
                      }
                      placeholder="اختياري"
                    />
                  </label>
                  <label className="field">
                    <span>رقم ترخيص المكتب</span>
                    <input
                      value={form.officeLicense || extractedBasicFields.officeLicense || ""}
                      onChange={(event) =>
                        updateField("officeLicense", event.target.value)
                      }
                      placeholder="اختياري"
                    />
                  </label>
                  <label className="field">
                    <span>الجوال</span>
                    <input
                      value={form.mobile}
                      onChange={(event) =>
                        updateField("mobile", event.target.value)
                      }
                      placeholder="0500000000"
                    />
                  </label>
                  <label className="field">
                    <span>الحي</span>
                    <input
                      value={form.district || extractedBasicFields.district || ""}
                      readOnly
                      aria-readonly="true"
                      placeholder="سيتم استخراجه من المرفقات"
                    />
                  </label>
                  <label className="field field-span">
                    <span>رقم القطعة / المخطط</span>
                    <input
                      value={form.plotNumber || extractedBasicFields.plotNumber || ""}
                      readOnly
                      aria-readonly="true"
                      placeholder="سيتم استخراجه من المرفقات"
                    />
                  </label>
                </div>

                <label className="field">
                  <span>وصف المشروع</span>
                  <textarea
                    rows={4}
                    value={form.projectDescription}
                    onChange={(event) =>
                      updateField("projectDescription", event.target.value)
                    }
                    placeholder="اكتب وصف المشروع هنا"
                  />
                </label>

                <label className="field">
                  <span>ملاحظات المكتب للأمانة</span>
                  <textarea
                    rows={3}
                    value={form.comments}
                    onChange={(event) =>
                      updateField("comments", event.target.value)
                    }
                  />
                </label>
              </SmartDisclosure>
            </div>

            <div className="panel-subsection">
              <SmartDisclosure
                title="الملفات المرفوعة ونتيجة الفحص"
                count={
                  selectedPolicy
                    ? `${form.selectedDocuments.length} / ${activeScopedPolicy.requiredDocuments.length}`
                    : "0 / 0"
                }
                defaultOpen
              >
                <div className="review-card compact-note tone-neutral">
                  <h3>رفع ملف مستقل لكل متطلب</h3>
                  <p>
                    لكل مستند مطلوب خانة رفع منفصلة. سيجري فحص الملف المرفوع
                    داخل هذه الخانة مقابل هذا المتطلب فقط، ثم تُعرض لك خلاصة
                    واضحة عن مدى مناسبته.
                  </p>
                  {canUploadFiles ? (
                    <label
                      className={`secondary-button bulk-upload-button${isAnalyzing || isConfirmingBulkUpload ? " is-disabled" : ""}`}
                      aria-disabled={isAnalyzing || isConfirmingBulkUpload}
                    >
                      <input
                        type="file"
                        multiple
                        accept=".pdf,.docx,.txt,.json,.md,.png,.jpg,.jpeg,.webp"
                        disabled={isAnalyzing || isConfirmingBulkUpload}
                        onChange={(event) => {
                          void handleBulkFileSelection(event.target.files);
                          event.target.value = "";
                        }}
                      />
                      مراجعة دفعة ملفات قبل رفعها وتوزيعها
                    </label>
                  ) : null}
                  <small>
                    {canUploadFiles
                      ? "الأنواع المدعومة: PDF, DOCX, TXT, JSON, PNG, JPG, WebP. بعد اختيار الدفعة ستظهر معاينة توضح ربط كل ملف بالمتطلب المقترح مع إمكانية إعادة التوزيع يدوياً قبل بدء الرفع."
                      : uploadLockMessage}
                  </small>
                </div>
                {hasBulkUploadPreview ? (
                  <div className="review-card bulk-preview-card">
                    <div className="bulk-preview-header">
                      <div>
                        <h3>معاينة دفعة الرفع قبل البدء</h3>
                        <p>
                          راجع ربط كل ملف بالمستند المطلوب. يمكن تعديل أي ملف
                          يدوياً، وعند اختيار نفس المتطلب لملف جديد سيتم نقله من
                          الملف السابق داخل هذه الدفعة.
                        </p>
                      </div>
                      <div className="bulk-preview-summary">
                        <strong>
                          {
                            bulkUploadPreview.filter(
                              (item) => item.selectedDocumentName,
                            ).length
                          }
                        </strong>
                        <span>جاهز للرفع</span>
                      </div>
                    </div>

                    {bulkUploadPreviewError ? (
                      <div className="upload-status error">
                        {bulkUploadPreviewError}
                      </div>
                    ) : null}

                    <div className="bulk-preview-list">
                      {bulkUploadPreview.map((item) => {
                        const selectedAttachment = item.selectedDocumentName
                          ? getAttachmentForRequiredDocument(
                              form.uploadedAttachments,
                              item.selectedDocumentName,
                            )
                          : undefined;
                        const selectedLabel = item.selectedDocumentName
                          ? formatChecklistDocumentLabel(
                              item.selectedDocumentName,
                            )
                          : "لم يتم التعيين بعد";
                        const isManualSelection =
                          Boolean(item.selectedDocumentName) &&
                          item.selectedDocumentName !==
                            item.suggestedDocumentName;

                        return (
                          <article key={item.id} className="bulk-preview-row">
                            <div className="bulk-preview-row-main">
                              <div>
                                <strong>{item.file.name}</strong>
                                <span>
                                  {Math.max(
                                    1,
                                    Math.round(item.file.size / 1024),
                                  )}{" "}
                                  KB
                                </span>
                              </div>
                              <span
                                className={`status-pill ${item.selectedDocumentName ? "ready" : "needs-info"}`}
                              >
                                {selectedLabel}
                              </span>
                            </div>

                            <label className="bulk-preview-field">
                              <span>المتطلب الذي سيذهب إليه الملف</span>
                              <select
                                value={item.selectedDocumentName}
                                onChange={(event) =>
                                  updateBulkUploadPreviewSelection(
                                    item.id,
                                    event.target.value,
                                  )
                                }
                                disabled={isConfirmingBulkUpload || isAnalyzing}
                              >
                                <option value="">
                                  اترك هذا الملف بدون رفع
                                </option>
                                {activeScopedPolicy.requiredDocuments.map(
                                  (documentName) => {
                                    const existingAttachment =
                                      getAttachmentForRequiredDocument(
                                        form.uploadedAttachments,
                                        documentName,
                                      );

                                    return (
                                      <option
                                        key={`${item.id}-${documentName}`}
                                        value={documentName}
                                      >
                                        {formatChecklistDocumentLabel(
                                          documentName,
                                        )}
                                        {existingAttachment
                                          ? ` - سيستبدل ${existingAttachment.name}`
                                          : ""}
                                      </option>
                                    );
                                  },
                                )}
                              </select>
                            </label>

                            <div className="bulk-preview-meta">
                              {item.suggestedDocumentName ? (
                                <span>
                                  المطابقة التلقائية:{" "}
                                  {formatChecklistDocumentLabel(
                                    item.suggestedDocumentName,
                                  )}
                                </span>
                              ) : item.topCandidateDocumentName ? (
                                <span>
                                  أقرب متطلب بالاسم:{" "}
                                  {formatChecklistDocumentLabel(
                                    item.topCandidateDocumentName,
                                  )}
                                </span>
                              ) : (
                                <span>
                                  لا يوجد تطابق تلقائي واضح لاسم هذا الملف.
                                </span>
                              )}
                              {isManualSelection ? (
                                <span>تم تعديل هذا الربط يدوياً.</span>
                              ) : null}
                              {!item.selectedDocumentName &&
                              item.topCandidateDocumentName ? (
                                <span>
                                  ملف آخر في نفس الدفعة حجز هذا المتطلب بدرجة
                                  أعلى، ويمكنك إعادة التوزيع يدوياً إذا لزم
                                  الأمر.
                                </span>
                              ) : null}
                              {selectedAttachment ? (
                                <span>
                                  سيستبدل الملف الحالي في الخانة:{" "}
                                  {selectedAttachment.name}
                                </span>
                              ) : null}
                            </div>
                          </article>
                        );
                      })}
                    </div>

                    <div className="bulk-preview-actions">
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={clearBulkUploadPreview}
                        disabled={isConfirmingBulkUpload || isAnalyzing}
                      >
                        إلغاء هذه الدفعة
                      </button>
                      <button
                        type="button"
                        className="primary-button bulk-preview-confirm"
                        onClick={() => void confirmBulkUploadPreview()}
                        disabled={isConfirmingBulkUpload || isAnalyzing}
                      >
                        {isConfirmingBulkUpload
                          ? "جاري بدء الرفع"
                          : "تأكيد المعاينة وبدء الرفع"}
                      </button>
                    </div>
                  </div>
                ) : null}
                {isAnalyzing ? (
                  <AnalysisTracePanel
                    message="جاري فحص الملفات المرفوعة وتجهيز نتائجها..."
                    events={analysisTrace}
                    active={isAnalyzing}
                  />
                ) : null}
                {analysisError ? (
                  <div className="upload-status error">{analysisError}</div>
                ) : null}
                {!isAnalyzing && analysisTrace.length > 0 ? (
                  <details
                    key={`analysis-trace-${analysisTrace.length}`}
                    className="analysis-trace-panel analysis-trace-panel-resting"
                  >
                    <summary>
                      <span>آخر سجل معالجة</span>
                      <strong>{analysisTrace.length}</strong>
                    </summary>
                    <div className="analysis-trace-meta">
                      <span>
                        يمكنك مراجعة ما تم على الملفات خطوة بخطوة مع ملخص
                        المخرجات التشغيلية.
                      </span>
                    </div>
                    <div className="analysis-trace-list">
                      {analysisTrace.map((event) => (
                        <article
                          key={event.id}
                          className={`analysis-trace-item ${event.status}`}
                        >
                          <div className="analysis-trace-header">
                            <strong>{event.title}</strong>
                            <span>{event.fileName ?? event.phase}</span>
                          </div>
                          <p>{event.detail}</p>
                          {event.detectedDocuments &&
                          event.detectedDocuments.length > 0 ? (
                            <div className="analysis-trace-tags">
                              {event.detectedDocuments.map((documentName) => (
                                <span
                                  key={`${event.id}-${documentName}`}
                                  className="tag success-tag"
                                >
                                  {formatChecklistDocumentLabel(documentName)}
                                </span>
                              ))}
                            </div>
                          ) : null}
                          {event.model || event.responseSummary ? (
                            <div className="analysis-trace-extra">
                              {event.model ? (
                                <small>النموذج: {event.model}</small>
                              ) : null}
                              {event.responseSummary ? (
                                <small>
                                  ملخص الاستجابة: {event.responseSummary}
                                </small>
                              ) : null}
                            </div>
                          ) : null}
                        </article>
                      ))}
                    </div>
                  </details>
                ) : null}
                {canUploadFiles ? (
                  <div className="attachment-stack">
                  {activeScopedPolicy.requiredDocuments.map((documentName) => {
                    const attachment = getAttachmentForRequiredDocument(
                      form.uploadedAttachments,
                      documentName,
                    );
                    const isDocumentUploading =
                      uploadingDocuments.includes(documentName);
                    const slotAnalysis = buildDocumentUploadSlotAnalysis(
                      documentName,
                      attachment,
                      draftDisplayValidations,
                    );

                    return (
                      <article
                        key={documentName}
                        className={`attachment-card ${attachment ? "filled-slot" : "empty-slot"}`}
                      >
                        <div className="attachment-header">
                          <div className="attachment-header-copy">
                            <strong>
                              {formatChecklistDocumentLabel(documentName)}
                            </strong>
                            {attachment ? (
                              <span>
                                {`${attachment.name} - ${Math.round(attachment.size / 1024)} KB`}
                              </span>
                            ) : null}
                            {attachment?.aiValidation?.model ? (
                              <small className="attachment-ai-model">
                                <AiAnalysisIcon className="ai-analysis-icon-xs" />
                                <span>
                                  المحرك: {attachment.aiValidation.model}
                                </span>
                              </small>
                            ) : null}
                          </div>
                          <div className="attachment-card-actions">
                            <label
                              className={`upload-dropzone ${attachment ? "is-filled" : "is-empty"}${!canUploadFiles || isDocumentUploading ? " is-disabled" : ""}`}
                              aria-disabled={
                                !canUploadFiles || isDocumentUploading
                              }
                              title={
                                isDocumentUploading
                                  ? "جاري فحص الملف"
                                  : attachment
                                    ? "استبدال الملف"
                                    : `رفع ملف لـ ${formatChecklistDocumentLabel(documentName)}`
                              }
                            >
                              <input
                                type="file"
                                accept=".pdf,.docx,.txt,.json,.md,.png,.jpg,.jpeg,.webp"
                                disabled={
                                  !canUploadFiles || isDocumentUploading
                                }
                                onChange={(event) => {
                                  void handleFileSelection(
                                    documentName,
                                    event.target.files,
                                  );
                                  event.target.value = "";
                                }}
                              />
                              <span className="upload-dropzone-icon-shell">
                                {isDocumentUploading ? (
                                  <AiAnalysisIcon className="upload-dropzone-ai-icon ai-analysis-icon-pulse" />
                                ) : (
                                  <span
                                    className="upload-dropzone-icon"
                                    aria-hidden="true"
                                  >
                                    +
                                  </span>
                                )}
                                <span className="sr-only">
                                  {isDocumentUploading
                                    ? "جاري فحص الملف"
                                    : attachment
                                      ? "استبدال الملف"
                                      : `رفع ملف لـ ${formatChecklistDocumentLabel(documentName)}`}
                                </span>
                              </span>
                            </label>
                            {attachment ? (
                              <>
                                <AttachmentPreviewAction
                                  attachment={attachment}
                                  onPreview={openAttachmentPreview}
                                />
                                <button
                                  className="ghost-button"
                                  onClick={() => removeAttachment(documentName)}
                                  disabled={isDocumentUploading}
                                >
                                  إزالة
                                </button>
                              </>
                            ) : null}
                          </div>
                        </div>

                        {isDocumentUploading ? (
                          <div
                            className="upload-status loading-banner slot-loading-banner"
                            role="status"
                            aria-live="polite"
                          >
                            <AiAnalysisIcon className="ai-analysis-icon-sm ai-analysis-icon-pulse" />
                            <span>
                              جاري فحص الملف المرفوع لهذا المتطلب وإعداد نتيجة
                              التحقق.
                            </span>
                          </div>
                        ) : attachment ? (
                          <div
                            className={`upload-status ${slotAnalysis.status === "passed" ? "success" : slotAnalysis.status === "empty" ? "empty" : "error"}`.trim()}
                          >
                            <div className="slot-analysis-row">
                              <span>{slotAnalysis.summary}</span>
                              {slotAnalysis.confidence ? (
                                <span className="slot-confidence-badge">
                                  الثقة {slotAnalysis.confidence}%
                                </span>
                              ) : null}
                            </div>
                          </div>
                        ) : null}

                        {!isDocumentUploading &&
                        attachment &&
                        slotAnalysis.note ? (
                          <small>{slotAnalysis.note}</small>
                        ) : null}

                        {attachment ? (
                          <>
                            {attachment.aiValidation?.feedback &&
                            attachment.aiValidation.feedback.length > 0 ? (
                              <ul className="inline-list">
                                {attachment.aiValidation.feedback.map(
                                  (feedbackItem) => (
                                    <li key={feedbackItem}>{feedbackItem}</li>
                                  ),
                                )}
                              </ul>
                            ) : null}
                            {attachment.aiValidation?.checklistResults &&
                            attachment.aiValidation.checklistResults.length >
                              0 ? (
                              <div className="validation-evidence-block attachment-checklist-block">
                                <strong>نتائج فحص عناصر المخطط المعماري</strong>
                                <ul>
                                  {attachment.aiValidation.checklistResults.map(
                                    (result) => (
                                      <li
                                        key={`${attachment.id}-${result.item}`}
                                      >
                                        <strong>{result.item}</strong>
                                        {`: ${
                                          result.status === "Compliant"
                                            ? "متوافق"
                                            : result.status === "Non-Compliant"
                                              ? "غير متوافق"
                                              : "غير موجود"
                                        } - ${result.comment}`}
                                      </li>
                                    ),
                                  )}
                                </ul>
                              </div>
                            ) : null}
                            <div className="attachment-tags">
                              {attachment.detectedDocuments.map((document) => (
                                <span
                                  key={document}
                                  className="tag success-tag"
                                >
                                  {formatChecklistDocumentLabel(document)}
                                </span>
                              ))}
                              {attachment.detectedDocuments.length === 0 ? (
                                <span className="tag">غير مرتبط تلقائياً</span>
                              ) : null}
                            </div>
                          </>
                        ) : null}
                      </article>
                    );
                  })}
                  </div>
                ) : (
                  <div className="empty-attachments">
                    اختر نوع السياسة ثم نوع المشروع والتصنيف التفصيلي أولاً حتى
                    تظهر خانات رفع الملفات.
                  </div>
                )}
              </SmartDisclosure>
            </div>

            {submitError ? (
              <div className="upload-status error">{submitError}</div>
            ) : null}
            {submissionValidationErrors.length > 0 ? (
              <div className="review-card tone-warning compact-note">
                <h3>ما يلزم قبل الإرسال</h3>
                <ul>
                  {submissionValidationErrors.slice(0, 6).map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <button
              className="primary-button"
              onClick={submitApplication}
              disabled={!canSubmit}
            >
              إرسال الطلب إلى واجهة الأمانة
            </button>
          </section>

          <aside className="panel panel-review">
            <div className="panel-header">
              <div className="section-title-row">
                <h2>حالة التجهيز</h2>
                <HelpHint text="هذه اللوحة تركّز على جاهزية الطلب الحالية، بينما تبقى التفاصيل المرجعية والتحققية ضمن أقسام قابلة للتوسيع." />
              </div>
              <p>عرض سريع للجاهزية قبل الإرسال إلى الأمانة.</p>
            </div>

            {hasUploadedFiles ? (
              <>
                <div className="score-ring" data-status={draftReview.status}>
                  <strong>{draftReview.score}%</strong>
                  <span>{statusLabel[draftReview.status]}</span>
                </div>
                <ReviewGlance
                  items={[
                    {
                      label: "المكتشف",
                      value: draftReview.matchedDocuments.length,
                      tone: "success",
                    },
                    {
                      label: "المتحقق منه",
                      value: draftValidatedDocuments.length,
                      tone:
                        draftValidatedDocuments.length > 0
                          ? "success"
                          : "default",
                    },
                    {
                      label: "غير الموجود",
                      value: draftReview.missingDocuments.length,
                      tone:
                        draftReview.missingDocuments.length > 0
                          ? "warning"
                          : "default",
                    },
                  ]}
                />
              </>
            ) : null}

            {hasUploadedFiles ? (
              <div className="review-card tone-neutral">
                <h3>الخلاصة</h3>
                <p>{draftReview.summary}</p>
                <small>{draftReview.nextStep}</small>
                <LlmSupportContent
                  review={draftLlmMutation.data}
                  loading={draftLlmMutation.isPending}
                  error={
                    draftLlmMutation.error instanceof Error
                      ? draftLlmMutation.error.message
                      : ""
                  }
                  onPreviewSource={openSourcePreview}
                />
              </div>
            ) : null}

            <div className="review-card source-card compact-card">
              <SmartDisclosure
                title="ملف السياسة المصدر"
                count={draftReview.sourcePath ? 1 : 0}
              >
                <p>
                  {draftReview.sourcePath
                    ? "تم ربط ملف السياسة المصدر بهذه المعاملة."
                    : "لم يتم ربط ملف مصدر بعد."}
                </p>
                <FileReferenceAction
                  path={draftReview.sourcePath}
                  onPreview={openSourcePreview}
                />
              </SmartDisclosure>
            </div>

            {hasUploadedFiles ? (
              <div className="review-card compact-card">
                <SmartDisclosure
                  title="مراجعة واضحة حسب كل ملف"
                  count={form.uploadedAttachments.length}
                  defaultOpen
                >
                  <p>
                    كل ملف أدناه يحمل ربطه الخاص بالمستندات والتنبيهات، بدلاً من
                    تجميع الملاحظات في قائمة عامة واحدة.
                  </p>
                  <ReviewGlance
                    items={[
                      {
                        label: "ملفات واضحة",
                        value: draftAttachmentReviews.filter(
                          (item) => item.status === "passed",
                        ).length,
                        tone: "success",
                      },
                      {
                        label: "ملفات تحتاج انتباهاً",
                        value: draftAttachmentReviews.filter(
                          (item) => item.status === "warning",
                        ).length,
                        tone: "warning",
                      },
                      {
                        label: "ملفات غير مرتبطة",
                        value: draftAttachmentReviews.filter(
                          (item) => item.status === "missing",
                        ).length,
                        tone: "danger",
                      },
                    ]}
                  />
                  <AttachmentReviewCards
                    attachments={form.uploadedAttachments}
                    validations={draftDisplayValidations}
                    onPreviewAttachment={openAttachmentPreview}
                  />
                </SmartDisclosure>
              </div>
            ) : null}

            <div className="review-card compact-card">
              <SmartDisclosure
                title="مراجع السياسة"
                count={activePolicy.references.length}
              >
                <ul>
                  {activePolicy.references.map((reference) => (
                    <li key={reference}>{reference}</li>
                  ))}
                </ul>
              </SmartDisclosure>
            </div>

            {hasUploadedFiles ? (
              <div className="review-card compact-card">
                <SmartDisclosure
                  title="ملاحظات إضافية"
                  count={draftReview.policyAlerts.length}
                >
                  <ul>
                    {draftReview.policyAlerts.map((alert) => (
                      <li key={alert}>{alert}</li>
                    ))}
                    {draftReview.policyAlerts.length === 0 ? (
                      <li>لا توجد تنبيهات حرجة في هذه المرحلة.</li>
                    ) : null}
                  </ul>
                </SmartDisclosure>
              </div>
            ) : null}

            {hasUploadedFiles && draftDisplayValidations.length > 0 ? (
              <div className="review-card compact-card">
                <SmartDisclosure
                  title="تفاصيل التحقق"
                  count={draftDisplayValidations.length}
                >
                  <ValidationCards validations={draftDisplayValidations} />
                </SmartDisclosure>
              </div>
            ) : null}

            {hasUploadedFiles ? (
              <div className="review-card tone-danger">
                <h3>المرفقات الناقصة</h3>
                <ul>
                  {draftReview.missingDocuments.slice(0, 8).map((document) => (
                    <li key={document}>
                      {formatChecklistDocumentLabel(document)}
                    </li>
                  ))}
                  {draftReview.missingDocuments.length === 0 ? (
                    <li>جميع المرفقات الأساسية موجودة.</li>
                  ) : null}
                </ul>
              </div>
            ) : null}

            <div className="review-card compact-card">
              <SmartDisclosure
                title="مسار التنفيذ حسب السياسة"
                count={activePolicy.workflow.length}
              >
                <ol className="timeline-list">
                  {activePolicy.workflow.map((step) => (
                    <li key={step.id}>
                      <strong>{step.actor}</strong>
                      <span>{step.action}</span>
                      <small>{step.duration}</small>
                    </li>
                  ))}
                </ol>
              </SmartDisclosure>
            </div>
          </aside>
        </main>
      ) : (
        <main className="workspace-grid municipality-grid">
          <section className="panel queue-panel">
            <div className="panel-header">
              <div className="section-title-row">
                <h2>طابور المعاملات</h2>
                <HelpHint text="اختر معاملة من القائمة لمشاهدة ملخصها أولاً. التفاصيل المرجعية والإجرائية أصبحت قابلة للتوسيع لتقليل كثافة القراءة." />
              </div>
              <p>اختر معاملة ثم راجع الحالة المختصرة أولاً.</p>
            </div>

            <div className="queue-list">
              {applications.map((application) => {
                const policy =
                  policies.find((item) => item.id === application.policyId) ??
                  policies[0];
                return (
                  <button
                    key={application.id}
                    className={`queue-item ${selectedApplication?.id === application.id ? "selected" : ""}`}
                    onClick={() => setSelectedApplicationId(application.id)}
                  >
                    <div>
                      <strong>{application.id}</strong>
                      <span>{policy.title}</span>
                      {application.projectTypeGroupId ||
                      application.projectSubtypeId ? (
                        <small>
                          {buildProjectTypeSummary(
                            policy,
                            application.projectTypeGroupId ?? "",
                            application.projectSubtypeId ?? "",
                          )}
                        </small>
                      ) : null}
                    </div>
                    <div>
                      <em>{application.officeName}</em>
                      <span
                        className={`status-pill ${application.review.status}`}
                      >
                        {statusLabel[application.review.status]}
                      </span>
                    </div>
                  </button>
                );
              })}
              {applications.length === 0 ? (
                <div className="empty-attachments">
                  لا توجد معاملات في واجهة الأمانة بعد. أرسل طلباً من واجهة
                  المكتب الهندسي ليظهر هنا بنفس البيانات الفعلية والمرفقات التي
                  تم فحصها.
                </div>
              ) : null}
            </div>
          </section>

          <section className="panel review-panel">
            {selectedApplication ? (
              <>
                <div className="panel-header review-heading">
                  <div>
                    <h2>مراجعة المعاملة {selectedApplication.id}</h2>
                    <p>
                      {
                        policies.find(
                          (item) => item.id === selectedApplication.policyId,
                        )?.title
                      }
                    </p>
                  </div>
                  <div
                    className={`status-banner ${selectedApplication.review.status}`}
                  >
                    <strong>{selectedApplication.review.score}%</strong>
                    <span>
                      {statusLabel[selectedApplication.review.status]}
                    </span>
                  </div>
                </div>

                <div className="detail-grid">
                  <div className="detail-card">
                    <span>المستفيد</span>
                    <strong>{selectedApplication.applicantName}</strong>
                  </div>
                  <div className="detail-card">
                    <span>المكتب</span>
                    <strong>{selectedApplication.officeName}</strong>
                  </div>
                  <div className="detail-card">
                    <span>الموقع</span>
                    <strong>
                      {selectedApplication.district} -{" "}
                      {selectedApplication.plotNumber}
                    </strong>
                  </div>
                  <div className="detail-card">
                    <span>نوع المشروع</span>
                    <strong>
                      {buildProjectTypeSummary(
                        policies.find(
                          (item) => item.id === selectedApplication.policyId,
                        ) ?? policies[0],
                        selectedApplication.projectTypeGroupId ?? "",
                        selectedApplication.projectSubtypeId ?? "",
                      )}
                    </strong>
                  </div>
                  <div className="detail-card">
                    <span>وقت التقديم</span>
                    <strong>{selectedApplication.submittedAt}</strong>
                  </div>
                </div>

                <ReviewGlance
                  items={[
                    {
                      label: "المستلم",
                      value: selectedApplication.selectedDocuments.length,
                      tone: "success",
                    },
                    {
                      label: "المتحقق منه",
                      value: selectedValidatedDocuments.length,
                      tone:
                        selectedValidatedDocuments.length > 0
                          ? "success"
                          : "default",
                    },
                    {
                      label: "غير الموجود",
                      value: selectedApplication.review.missingDocuments.length,
                      tone:
                        selectedApplication.review.missingDocuments.length > 0
                          ? "warning"
                          : "default",
                    },
                  ]}
                />

                <div className="review-columns">
                  <div className="review-card tone-neutral review-card-full-span">
                    <h3>ملخص المراجعة المساندة</h3>
                    <p>{selectedApplication.review.summary}</p>
                    <small>{selectedApplication.review.nextStep}</small>
                    <LlmSupportContent
                      review={selectedApplication.llmReview}
                      loading={
                        applicationLlmMutation.isPending &&
                        applicationLlmMutation.variables?.applicationId ===
                          selectedApplication.id
                      }
                      error={
                        applicationLlmMutation.variables?.applicationId ===
                          selectedApplication.id &&
                        applicationLlmMutation.error instanceof Error
                          ? applicationLlmMutation.error.message
                          : ""
                      }
                      onPreviewSource={openSourcePreview}
                    />
                  </div>

                  <div className="review-card">
                    <h3>المرفقات المستلمة</h3>
                    <ul>
                      {selectedApplication.selectedDocuments.map((document) => (
                        <li key={document}>
                          {formatChecklistDocumentLabel(document)}
                        </li>
                      ))}
                      {selectedApplication.selectedDocuments.length === 0 ? (
                        <li>
                          لم يتم اكتشاف مستندات مطابقة من الملفات المرفوعة.
                        </li>
                      ) : null}
                    </ul>
                  </div>

                  <div className="review-card tone-danger">
                    <h3>المرفقات الناقصة</h3>
                    <ul>
                      {selectedApplication.review.missingDocuments.map(
                        (document) => (
                          <li key={document}>
                            {formatChecklistDocumentLabel(document)}
                          </li>
                        ),
                      )}
                      {selectedApplication.review.missingDocuments.length ===
                      0 ? (
                        <li>لا توجد نواقص.</li>
                      ) : null}
                    </ul>
                  </div>

                  <div className="review-card compact-card">
                    <SmartDisclosure
                      title="ملاحظات إضافية"
                      count={selectedApplication.review.policyAlerts.length}
                    >
                      <ul>
                        {selectedApplication.review.policyAlerts.map(
                          (alert) => (
                            <li key={alert}>{alert}</li>
                          ),
                        )}
                        {selectedApplication.review.policyAlerts.length ===
                        0 ? (
                          <li>الفحص الآلي لم يرصد تنبيهات إضافية.</li>
                        ) : null}
                      </ul>
                    </SmartDisclosure>
                  </div>
                </div>

                <div className="review-card source-card">
                  <SmartDisclosure
                    title="المرجع الرسمي المستخدم"
                    count={selectedApplication.review.sourcePath ? 1 : 0}
                  >
                    <p>
                      {selectedApplication.review.sourcePath
                        ? "تم ربط مرجع رسمي بهذه المراجعة."
                        : "لا يوجد ملف مصدر مربوط لهذه السياسة."}
                    </p>
                    <FileReferenceAction
                      path={selectedApplication.review.sourcePath}
                      onPreview={openSourcePreview}
                    />
                  </SmartDisclosure>
                </div>

                {selectedDisplayValidations.length > 0 ? (
                  <div className="review-card compact-card">
                    <SmartDisclosure
                      title="تفاصيل التحقق"
                      count={selectedDisplayValidations.length}
                    >
                      <ValidationCards
                        validations={selectedDisplayValidations}
                      />
                    </SmartDisclosure>
                  </div>
                ) : null}

                <div className="review-card tone-neutral">
                  <div className="reply-card-header">
                    <h3>ردود مقترحة للمكتب الهندسي</h3>
                  </div>
                  <SuggestedResponsesSection
                    responses={selectedSuggestedResponses}
                    applicationId={selectedApplication.id}
                    onCopy={copySuggestedResponse}
                  />
                  {copyStatus ? (
                    <small className="copy-status-message">{copyStatus}</small>
                  ) : null}
                </div>

                <div className="review-card compact-card">
                  <SmartDisclosure
                    title="الملفات الفعلية التي تم فحصها"
                    count={selectedApplication.uploadedAttachments.length}
                    defaultOpen
                  >
                    <ReviewGlance
                      items={[
                        {
                          label: "ملفات واضحة",
                          value: selectedAttachmentReviews.filter(
                            (item) => item.status === "passed",
                          ).length,
                          tone: "success",
                        },
                        {
                          label: "ملفات تحتاج انتباهاً",
                          value: selectedAttachmentReviews.filter(
                            (item) => item.status === "warning",
                          ).length,
                          tone: "warning",
                        },
                        {
                          label: "ملفات غير مرتبطة",
                          value: selectedAttachmentReviews.filter(
                            (item) => item.status === "missing",
                          ).length,
                          tone: "danger",
                        },
                      ]}
                    />
                    <AttachmentReviewCards
                      attachments={selectedApplication.uploadedAttachments}
                      validations={selectedDisplayValidations}
                      onPreviewAttachment={openAttachmentPreview}
                    />
                  </SmartDisclosure>
                </div>

                <div className="review-card compact-card">
                  <SmartDisclosure title="الوصف والملاحظات">
                    <p>{selectedApplication.projectDescription}</p>
                    <small>{selectedApplication.comments}</small>
                  </SmartDisclosure>
                </div>

                <div className="review-card tone-neutral">
                  <div className="reply-card-header">
                    <h3>الرد المقترح إلى المكتب الهندسي</h3>
                    <button
                      className="ghost-button"
                      onClick={() => void copyOfficeReply(selectedApplication)}
                    >
                      نسخ الرد
                    </button>
                  </div>
                  <p>
                    {buildOfficeReply(
                      selectedApplication,
                      policies.find(
                        (item) => item.id === selectedApplication.policyId,
                      ) ?? policies[0],
                    )}
                  </p>
                  {copyStatus ? (
                    <small className="copy-status-message">{copyStatus}</small>
                  ) : null}
                </div>

                <div className="review-card compact-card">
                  <SmartDisclosure
                    title="المسار الإجرائي المقترح للبلدية"
                    count={
                      (
                        policies.find(
                          (item) => item.id === selectedApplication.policyId,
                        )?.workflow ?? []
                      ).length
                    }
                  >
                    <ol className="timeline-list municipality-timeline">
                      {(
                        policies.find(
                          (item) => item.id === selectedApplication.policyId,
                        )?.workflow ?? []
                      ).map((step) => (
                        <li key={step.id}>
                          <strong>{step.actor}</strong>
                          <span>{step.action}</span>
                          <small>{step.duration}</small>
                        </li>
                      ))}
                    </ol>
                  </SmartDisclosure>
                </div>

                <div className="action-row">
                  <button className="secondary-button">
                    طلب استكمال من المكتب
                  </button>
                  <button className="secondary-button">إعادة للمدقق</button>
                  <button className="primary-button">اعتماد نهائي</button>
                </div>
              </>
            ) : (
              <div className="empty-attachments">
                لا توجد معاملة محددة للمراجعة. بعد إرسال أول طلب من واجهة المكتب
                الهندسي سيظهر هنا ملف الأمانة المرتبط به.
              </div>
            )}
          </section>
        </main>
      )}

      <footer className="site-footer">
        <div className="site-footer-brand">
          <div className="site-footer-brand-main">
            <img
              className="footer-logo"
              src="https://www.alriyadh.gov.sa/images/logo.png"
              alt="شعار أمانة منطقة الرياض"
            />
            <div>
              <strong>أمانة منطقة الرياض</strong>
              <p>
                منظومة داخلية تدعم فرق الاستقبال والتدقيق في فرز الطلبات، التحقق
                من اكتمال المستندات، وتسريع اتخاذ الإجراء المناسب.
              </p>
            </div>
          </div>

          <div className="site-footer-partners">
            <img
              className="footer-vision-logo"
              src="https://www.alriyadh.gov.sa/_next/static/media/vision30.1c33917f.svg"
              alt="شعار رؤية السعودية 2030"
            />
          </div>
        </div>

        <div className="site-footer-summary">
          <div className="site-footer-stat">
            <strong>رخص هندسية</strong>
            <span>
              إدارة الطلب من الاستلام الأولي حتى قرار الاعتماد أو طلب الاستكمال
            </span>
          </div>
          <div className="site-footer-stat">
            <strong>مراجعة مساندة</strong>
            <span>
              استخراج قرائن من الملفات والسياسات لمساندة المراجع دون استبدال
              القرار البشري
            </span>
          </div>
          <div className="site-footer-stat">
            <strong>جاهزية تشغيلية</strong>
            <span>
              عرض مركز للحالة والنواقص والتنبيهات بما يساعد على تقليل زمن
              المراجعة ورفع جودة القرار
            </span>
          </div>
        </div>

        <div className="site-footer-bottom">
          <span>جميع الحقوق محفوظة لأمانة منطقة الرياض © 2026</span>
          <span>نسخة تشغيل داخلية للاستخدام المؤسسي والتطوير المستمر</span>
        </div>
      </footer>

      {previewState ? (
        <div
          className="modal-backdrop"
          onClick={closeSourcePreview}
          role="presentation"
        >
          <div
            className="preview-modal"
            role="dialog"
            aria-modal="true"
            aria-label={previewSourceName}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="preview-modal-header">
              <div>
                <strong>{previewSourceName}</strong>
                <small>{previewSourceLabel}</small>
              </div>
              <button
                type="button"
                className="ghost-button"
                onClick={closeSourcePreview}
              >
                إغلاق
              </button>
            </div>

            {previewLoading ? (
              <LoadingBanner message="جاري تجهيز معاينة الملف..." />
            ) : null}
            {previewError && !previewLoading ? (
              <div className="upload-status error preview-status">
                {previewError}
              </div>
            ) : null}

            {!previewLoading &&
            previewState.kind === "pdf" &&
            previewState.url ? (
              <iframe
                title={previewSourceName}
                className="preview-frame"
                src={previewState.url}
              />
            ) : null}

            {!previewLoading &&
            previewState.kind === "html" &&
            previewState.html ? (
              <iframe
                title={previewSourceName}
                className="preview-frame"
                srcDoc={previewState.html}
              />
            ) : null}

            {!previewLoading &&
            previewState.kind === "image" &&
            previewState.url ? (
              <div className="preview-image-shell">
                <img
                  src={previewState.url}
                  alt={previewSourceName}
                  className="preview-image"
                />
              </div>
            ) : null}

            {!previewLoading && previewState.kind === "unsupported" ? (
              <div className="preview-empty-state">
                {previewState.message || "المعاينة غير متاحة لهذا الملف."}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
