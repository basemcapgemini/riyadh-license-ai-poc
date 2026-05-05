import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { policies, defaultPolicyId, emptyForm } from "./data/policyData";
import { requestLlmReview } from "./api/llmReview";
import { fetchJson, resolveApiUrl } from "./api/http";
import {
  analyzeAttachments,
  collectDetectedDocuments,
} from "./ai/attachmentAnalyzer";
import { reviewApplication } from "./ai/reviewEngine";
import type {
  ApplicationRecord,
  AttachmentAnalysisTraceEvent,
  EvidenceCitation,
  LicensePolicy,
  LlmReview,
  SubmissionForm,
  SuggestedResponse,
  SuggestedResponseActionType,
} from "./types";

type ViewMode = "office" | "municipality";

type SourcePreviewState = {
  path: string;
  fileName: string;
  kind: "pdf" | "html" | "unsupported";
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

const APPLICATIONS_STORAGE_KEY = "riyadh-license-ai-poc.applications";
const SELECTED_APPLICATION_STORAGE_KEY =
  "riyadh-license-ai-poc.selectedApplicationId";

const statusLabel = {
  ready: "جاهز للاعتماد",
  "needs-info": "بحاجة لاستكمال",
  blocked: "متوقف",
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

function getSubmissionValidationErrors(form: SubmissionForm) {
  const errors: string[] = [];

  if (!form.applicantName.trim()) errors.push("اسم المستفيد مطلوب.");
  if (!form.nationalId.trim()) errors.push("الهوية أو السجل مطلوب.");
  if (!form.officeName.trim()) errors.push("اسم المكتب الهندسي مطلوب.");
  if (!form.officeLicense.trim()) errors.push("رقم ترخيص المكتب مطلوب.");
  if (!form.mobile.trim()) errors.push("رقم الجوال مطلوب.");
  if (!form.district.trim()) errors.push("بيانات الحي مطلوبة.");
  if (!form.plotNumber.trim()) errors.push("رقم القطعة أو المخطط مطلوب.");
  if (form.projectDescription.trim().length < 20)
    errors.push("وصف المشروع يجب أن يكون أوضح وأطول من 20 حرفاً.");
  if (form.uploadedAttachments.length === 0)
    errors.push("يجب رفع ملف فعلي واحد على الأقل قبل الإرسال.");

  return errors;
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

function loadStoredApplications() {
  if (typeof window === "undefined") {
    return [] as ApplicationRecord[];
  }

  try {
    const rawValue = window.localStorage.getItem(APPLICATIONS_STORAGE_KEY);
    if (!rawValue) {
      return [] as ApplicationRecord[];
    }

    const parsedValue = JSON.parse(rawValue);
    return Array.isArray(parsedValue)
      ? (parsedValue as ApplicationRecord[])
      : [];
  } catch {
    return [] as ApplicationRecord[];
  }
}

function loadStoredSelectedApplicationId() {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem(SELECTED_APPLICATION_STORAGE_KEY) ?? "";
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
    projectDescription: application.projectDescription,
    selectedDocuments: application.selectedDocuments,
    comments: application.comments,
    uploadedAttachments: application.uploadedAttachments,
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
  count?: number;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="smart-disclosure" open={defaultOpen}>
      <summary>
        <span>{title}</span>
        {typeof count === "number" ? <strong>{count}</strong> : null}
      </summary>
      <div className="smart-disclosure-body">{children}</div>
    </details>
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

function EvidenceList({
  title,
  citations,
  onPreviewSource,
}: {
  title: string;
  citations: EvidenceCitation[];
  onPreviewSource: (path: string) => void;
}) {
  return (
    <div className="review-card source-card compact-card">
      <SmartDisclosure title={title} count={citations.length}>
        <div className="citation-stack">
          {citations.map((citation) => (
            <article key={citation.id} className="citation-item">
              <strong>{citation.label}</strong>
              <span>{citation.sourceFileName}</span>
              <p>{citation.excerpt}</p>
              <em>مطابقة على: {citation.matchedText}</em>
              <FileReferenceAction
                path={citation.sourcePath}
                onPreview={onPreviewSource}
              />
            </article>
          ))}
          {citations.length === 0 ? (
            <div className="empty-attachments">
              لا توجد شواهد مطابقة من ملف السياسة المصدر.
            </div>
          ) : null}
        </div>
      </SmartDisclosure>
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
  const label =
    source === "ai" ? "من تحليل الذكاء الاصطناعي" : "من التحقق القاعدي";
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
          <ul>
            {validation.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
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
        </article>
      ))}
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
                      ? "من تحليل الذكاء الاصطناعي"
                      : "من التحقق القاعدي"}
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

function LoadingBanner({ message }: { message: string }) {
  return (
    <div
      className="upload-status loading-banner"
      role="status"
      aria-live="polite"
    >
      <span className="spinner" aria-hidden="true" />
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
      <LoadingBanner message={message} />
      <details className="analysis-trace-panel" open={active}>
        <summary>
          <span>عرض مسار التحليل</span>
          <strong>{events.length}</strong>
        </summary>
        <div className="analysis-trace-meta">
          <span>خطوات مكتملة: {successfulEvents}</span>
          <span>خطوات جارية: {runningEvents}</span>
          <span>
            يعرض هذا القسم المسار التشغيلي وملخصات الاستجابة، وليس التفكير
            الداخلي للنموذج.
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
        <LoadingBanner message="يتم الآن تعزيز النتيجة تلقائياً عبر تحليل نصوص الملفات والسياسة." />
      ) : null}

      {review ? (
        <>
          <div className="section-title-row">
            <h4>التحليل المعزز</h4>
            <HelpHint text="تفاصيل إضافية من المراجعة اللغوية تظهر عند الحاجة فقط. افتح أي قسم للاطلاع على التفاصيل." />
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
              <span>الموديل المستخدم</span>
              <strong>{review.model}</strong>
            </div>
          </div>

          <p className="llm-summary">{review.summary}</p>
          <small className="llm-timestamp">
            آخر توليد: {new Date(review.generatedAt).toLocaleString("ar-SA")}
          </small>

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
  const [policyId, setPolicyId] = useState(defaultPolicyId);
  const [form, setForm] = useState<SubmissionForm>(emptyForm);
  const [applications, setApplications] = useState<ApplicationRecord[]>(() =>
    loadStoredApplications(),
  );
  const [selectedApplicationId, setSelectedApplicationId] = useState(() =>
    loadStoredSelectedApplicationId(),
  );
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisTrace, setAnalysisTrace] = useState<
    AttachmentAnalysisTraceEvent[]
  >([]);
  const [analysisError, setAnalysisError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [previewState, setPreviewState] = useState<SourcePreviewState | null>(
    null,
  );
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const lastDraftAutoReviewKey = useRef("");
  const lastApplicationAutoReviewKey = useRef("");

  const activePolicy =
    policies.find((item) => item.id === policyId) ?? policies[0];
  const draftReview = reviewApplication(activePolicy, form);
  const selectedApplication =
    applications.find((item) => item.id === selectedApplicationId) ??
    applications[0] ??
    null;
  const submissionValidationErrors = getSubmissionValidationErrors(form);
  const canSubmit = submissionValidationErrors.length === 0 && !isAnalyzing;
  const hasUploadedFiles = form.uploadedAttachments.length > 0;
  const previewSourceName = previewState?.fileName ?? "";

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
      const review = await requestLlmReview({
        policy,
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
  const selectedDisplayValidations = selectedApplication
    ? selectDocumentValidations(
        selectedApplication.llmReview,
        selectedApplication.review.documentValidations,
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

  function handlePolicyChange(nextPolicyId: string) {
    const nextPolicy =
      policies.find((item) => item.id === nextPolicyId) ?? policies[0];
    setPolicyId(nextPolicy.id);
    draftLlmMutation.reset();
    setSubmitError("");
    setForm((current) => ({
      ...current,
      selectedDocuments: collectDetectedDocuments(
        current.uploadedAttachments,
        nextPolicy,
      ),
    }));
  }

  async function handleFileSelection(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) {
      return;
    }

    setIsAnalyzing(true);
    setAnalysisError("");
    setSubmitError("");
    setAnalysisTrace([]);
    draftLlmMutation.reset();

    try {
      const files = Array.from(fileList);
      const analyzed = await analyzeAttachments(files, activePolicy, {
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
        const existingById = new Map(
          current.uploadedAttachments.map((attachment) => [
            attachment.id,
            attachment,
          ]),
        );
        analyzed.forEach((attachment) => {
          existingById.set(attachment.id, attachment);
        });
        const uploadedAttachments = Array.from(existingById.values());
        return {
          ...current,
          uploadedAttachments,
          selectedDocuments: collectDetectedDocuments(
            uploadedAttachments,
            activePolicy,
          ),
        };
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "فشل تحليل الملفات المرفوعة.";
      setAnalysisError(message);
    } finally {
      setIsAnalyzing(false);
    }
  }

  function removeAttachment(attachmentId: string) {
    draftLlmMutation.reset();
    setSubmitError("");
    setForm((current) => {
      const uploadedAttachments = current.uploadedAttachments.filter(
        (attachment) => attachment.id !== attachmentId,
      );
      return {
        ...current,
        uploadedAttachments,
        selectedDocuments: collectDetectedDocuments(
          uploadedAttachments,
          activePolicy,
        ),
      };
    });
  }

  useEffect(() => {
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
        policy: activePolicy,
        submission: form,
        ruleReview: draftReview,
      });
    }, 1200);

    return () => window.clearTimeout(timeoutId);
  }, [activePolicy, draftLlmMutation, draftReview, form]);

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

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(
      APPLICATIONS_STORAGE_KEY,
      JSON.stringify(applications),
    );
  }, [applications]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (selectedApplicationId) {
      window.localStorage.setItem(
        SELECTED_APPLICATION_STORAGE_KEY,
        selectedApplicationId,
      );
      return;
    }

    window.localStorage.removeItem(SELECTED_APPLICATION_STORAGE_KEY);
  }, [selectedApplicationId]);

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

  const readyCount = applications.filter(
    (item) => item.review.status === "ready",
  ).length;
  const blockedCount = applications.filter(
    (item) => item.review.status === "blocked",
  ).length;

  return (
    <div className="app-shell">
      <section className="top-strip">
        <div className="top-strip-title">أمانة منطقة الرياض</div>
        <div className="top-strip-meta">
          <span>منصة داخلية لمراجعة الرخص الهندسية</span>
          <span>الرياض</span>
        </div>
      </section>

      <header className="hero-card">
        <div>
          <div className="brand-lockup">
            <img
              className="brand-logo"
              src="https://www.alriyadh.gov.sa/images/logo.png"
              alt="شعار أمانة منطقة الرياض"
            />
            <div className="brand-copy">
              <span className="brand-badge">مراجعة واستقبال الطلبات</span>
              <span className="eyebrow">
                النموذج الأولي الذكي لأمانة الرياض
              </span>
            </div>
          </div>
          <h1>
            منصة إثبات مفهوم لاعتماد الرخص الهندسية بمساعدة الذكاء الاصطناعي
          </h1>
          <p>
            توحيد استقبال الطلبات الهندسية، فحص المرفقات، واستخراج مؤشرات
            الجاهزية قبل الإحالة إلى المراجع البلدي المختص.
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
        <div className="hero-metrics">
          <div className="metric-card">
            <strong>12</strong>
            <span>سياسة مرجعية</span>
          </div>
          <div className="metric-card">
            <strong>{readyCount}</strong>
            <span>ملفات جاهزة للاعتماد</span>
          </div>
          <div className="metric-card warning">
            <strong>{blockedCount}</strong>
            <span>ملفات متوقفة</span>
          </div>
        </div>
      </header>

      <section className="toolbar">
        <div className="segment-control">
          <button
            className={viewMode === "office" ? "active" : ""}
            onClick={() => setViewMode("office")}
          >
            طبقة المكتب الهندسي
          </button>
          <button
            className={viewMode === "municipality" ? "active" : ""}
            onClick={() => setViewMode("municipality")}
          >
            طبقة الأمانة والمراجعة
          </button>
        </div>
        <div className="legend-row">
          <span>المصدر</span>
          <HelpHint text="المراجعة تعتمد على لوائح ونماذج عربية فعلية مع تحليل الملفات المرفوعة محلياً ثم دعم لغوي إضافي عند الحاجة." />
        </div>
      </section>

      {viewMode === "office" ? (
        <main className="workspace-grid">
          <section className="panel panel-form">
            <div className="panel-header">
              <div className="section-title-row">
                <h2>إعداد الطلب</h2>
                <HelpHint text="ابدأ بالبيانات الأساسية ثم ارفع ملفاً فعلياً واحداً على الأقل ليبدأ التحليل والمقارنة مع السياسة." />
              </div>
              <p>
                املأ البيانات الأساسية وارفع الملفات. بقية التفاصيل تظهر عند
                الحاجة فقط.
              </p>
            </div>

            <label className="field">
              <span>نوع السياسة</span>
              <select
                value={policyId}
                onChange={(event) => handlePolicyChange(event.target.value)}
              >
                {policies.map((policy) => (
                  <option key={policy.id} value={policy.id}>
                    {policy.title}
                  </option>
                ))}
              </select>
            </label>

            <div className="grid-two">
              <label className="field">
                <span>اسم المستفيد</span>
                <input
                  value={form.applicantName}
                  onChange={(event) =>
                    updateField("applicantName", event.target.value)
                  }
                />
              </label>
              <label className="field">
                <span>الهوية / السجل</span>
                <input
                  value={form.nationalId}
                  onChange={(event) =>
                    updateField("nationalId", event.target.value)
                  }
                />
              </label>
              <label className="field">
                <span>المكتب الهندسي</span>
                <input
                  value={form.officeName}
                  onChange={(event) =>
                    updateField("officeName", event.target.value)
                  }
                />
              </label>
              <label className="field">
                <span>رقم ترخيص المكتب</span>
                <input
                  value={form.officeLicense}
                  onChange={(event) =>
                    updateField("officeLicense", event.target.value)
                  }
                />
              </label>
              <label className="field">
                <span>الجوال</span>
                <input
                  value={form.mobile}
                  onChange={(event) =>
                    updateField("mobile", event.target.value)
                  }
                />
              </label>
              <label className="field">
                <span>الحي</span>
                <input
                  value={form.district}
                  onChange={(event) =>
                    updateField("district", event.target.value)
                  }
                />
              </label>
              <label className="field field-span">
                <span>رقم القطعة / المخطط</span>
                <input
                  value={form.plotNumber}
                  onChange={(event) =>
                    updateField("plotNumber", event.target.value)
                  }
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
              />
            </label>

            <label className="field">
              <span>ملاحظات المكتب للبلدية أو نظام الذكاء الاصطناعي</span>
              <textarea
                rows={3}
                value={form.comments}
                onChange={(event) =>
                  updateField("comments", event.target.value)
                }
              />
            </label>

            <div className="panel-subsection">
              <div className="subsection-heading">
                <h3>الملفات المرفوعة والتحليل الفعلي</h3>
                <span>
                  {form.selectedDocuments.length} /{" "}
                  {activePolicy.requiredDocuments.length}
                </span>
              </div>
              <label className="upload-dropzone">
                <input
                  type="file"
                  multiple
                  accept=".pdf,.docx,.txt,.json,.md,.png,.jpg,.jpeg,.webp"
                  onChange={(event) => {
                    void handleFileSelection(event.target.files);
                    event.target.value = "";
                  }}
                />
                <strong>إرفاق ملفات حقيقية للتحليل</strong>
                <span>
                  الأنواع المدعومة حالياً: PDF, DOCX, TXT, JSON, PNG, JPG, WebP.
                </span>
                <small>
                  يتم تحليل النص داخل الملفات محلياً في المتصفح. OCR للصور قد
                  يستغرق وقتاً أطول.
                </small>
              </label>
              {isAnalyzing ? (
                <AnalysisTracePanel
                  message="جاري قراءة وتحليل الملفات المرفوعة..."
                  events={analysisTrace}
                  active={isAnalyzing}
                />
              ) : null}
              {analysisError ? (
                <div className="upload-status error">{analysisError}</div>
              ) : null}
              {!isAnalyzing && analysisTrace.length > 0 ? (
                <details className="analysis-trace-panel analysis-trace-panel-resting">
                  <summary>
                    <span>آخر مسار تحليل</span>
                    <strong>{analysisTrace.length}</strong>
                  </summary>
                  <div className="analysis-trace-meta">
                    <span>
                      يمكنك مراجعة ما الذي قرأه النظام وكيف مرّت دفعات الذكاء
                      الاصطناعي على الملفات.
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
                                {documentName}
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
              <div className="document-grid">
                {activePolicy.requiredDocuments.map((document) => {
                  const checked = form.selectedDocuments.includes(document);
                  return (
                    <div
                      key={document}
                      className={`document-chip ${checked ? "checked" : ""}`}
                    >
                      <span>{document}</span>
                    </div>
                  );
                })}
              </div>
              <div className="attachment-stack">
                {form.uploadedAttachments.map((attachment) => (
                  <article key={attachment.id} className="attachment-card">
                    <div className="attachment-header">
                      <div>
                        <strong>{attachment.name}</strong>
                        <span>
                          {attachment.sourceType} -{" "}
                          {Math.round(attachment.size / 1024)} KB
                        </span>
                      </div>
                      <button
                        className="ghost-button"
                        onClick={() => removeAttachment(attachment.id)}
                      >
                        إزالة
                      </button>
                    </div>
                    <p>
                      {attachment.excerpt || "لم يتم استخراج نص قابل للعرض."}
                    </p>
                    <div className="attachment-tags">
                      {attachment.detectedDocuments.map((document) => (
                        <span key={document} className="tag success-tag">
                          {document}
                        </span>
                      ))}
                      {attachment.detectedDocuments.length === 0 ? (
                        <span className="tag">غير مرتبط تلقائياً</span>
                      ) : null}
                    </div>
                    {attachment.notes.length > 0 ? (
                      <ul className="inline-list">
                        {attachment.notes.map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                    ) : null}
                  </article>
                ))}
                {form.uploadedAttachments.length === 0 ? (
                  <div className="empty-attachments">لم يتم رفع ملفات بعد.</div>
                ) : null}
              </div>
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
              إرسال الطلب إلى طبقة الأمانة
            </button>
          </section>

          <aside className="panel panel-review">
            <div className="panel-header">
              <div className="section-title-row">
                <h2>حالة التجهيز</h2>
                <HelpHint text="هذه اللوحة تركّز على الجاهزية الحالية. التفاصيل الطويلة مثل الأدلة والمراجع والتعليلات أصبحت داخل أقسام قابلة للتوسيع." />
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
                      label: "الناقص",
                      value: draftReview.missingDocuments.length,
                      tone:
                        draftReview.missingDocuments.length > 0
                          ? "warning"
                          : "default",
                    },
                    {
                      label: "التنبيهات",
                      value: draftReview.policyAlerts.length,
                      tone:
                        draftReview.policyAlerts.length > 0
                          ? "danger"
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
              <div className="review-card">
                <h3>نتيجة القراءة الفعلية للملفات</h3>
                <ul>
                  {form.uploadedAttachments.map((attachment) => (
                    <li key={attachment.id}>
                      {attachment.name}:{" "}
                      {attachment.detectedDocuments.length > 0
                        ? attachment.detectedDocuments.join("، ")
                        : "لم يتم التعرف على مستند مطلوب"}
                    </li>
                  ))}
                </ul>
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
              <div className="review-card tone-warning">
                <h3>تنبيهات الذكاء الاصطناعي</h3>
                <ul>
                  {draftReview.policyAlerts.map((alert) => (
                    <li key={alert}>{alert}</li>
                  ))}
                  {draftReview.policyAlerts.length === 0 ? (
                    <li>لا توجد تنبيهات حرجة في هذه المرحلة.</li>
                  ) : null}
                </ul>
              </div>
            ) : null}

            {hasUploadedFiles && draftDisplayValidations.length > 0 ? (
              <div className="review-card compact-card">
                <SmartDisclosure
                  title="تحقق تفصيلي من المخططات"
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
                    <li key={document}>{document}</li>
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

            <EvidenceList
              title="شواهد المستندات من الملف الأصلي"
              citations={draftReview.documentEvidence.slice(0, 6)}
              onPreviewSource={openSourcePreview}
            />
            <EvidenceList
              title="شواهد الإجراءات من الملف الأصلي"
              citations={draftReview.workflowEvidence.slice(0, 4)}
              onPreviewSource={openSourcePreview}
            />
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
                  لا توجد معاملات في طبقة الأمانة بعد. أرسل طلباً من طبقة المكتب
                  الهندسي ليظهر هنا بنفس البيانات الفعلية والمرفقات التي تم
                  تحليلها.
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
                      label: "الناقص",
                      value: selectedApplication.review.missingDocuments.length,
                      tone:
                        selectedApplication.review.missingDocuments.length > 0
                          ? "warning"
                          : "default",
                    },
                    {
                      label: "التنبيهات",
                      value: selectedApplication.review.policyAlerts.length,
                      tone:
                        selectedApplication.review.policyAlerts.length > 0
                          ? "danger"
                          : "default",
                    },
                  ]}
                />

                <div className="review-columns">
                  <div className="review-card tone-neutral">
                    <h3>ملخص الذكاء الاصطناعي</h3>
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
                        <li key={document}>{document}</li>
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
                          <li key={document}>{document}</li>
                        ),
                      )}
                      {selectedApplication.review.missingDocuments.length ===
                      0 ? (
                        <li>لا توجد نواقص.</li>
                      ) : null}
                    </ul>
                  </div>

                  <div className="review-card tone-warning">
                    <h3>التنبيهات النظامية</h3>
                    <ul>
                      {selectedApplication.review.policyAlerts.map((alert) => (
                        <li key={alert}>{alert}</li>
                      ))}
                      {selectedApplication.review.policyAlerts.length === 0 ? (
                        <li>الفحص الآلي لم يرصد تنبيهات إضافية.</li>
                      ) : null}
                    </ul>
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
                      title="تحقق تفصيلي من المخططات"
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
                    title="الملفات الفعلية التي تم تحليلها"
                    count={selectedApplication.uploadedAttachments.length}
                  >
                    <div className="attachment-stack compact">
                      {selectedApplication.uploadedAttachments.map(
                        (attachment) => (
                          <article
                            key={attachment.id}
                            className="attachment-card compact"
                          >
                            <div className="attachment-header">
                              <div>
                                <strong>{attachment.name}</strong>
                                <span>{attachment.sourceType}</span>
                              </div>
                            </div>
                            <p>{attachment.excerpt || "لا يوجد نص مستخرج."}</p>
                          </article>
                        ),
                      )}
                      {selectedApplication.uploadedAttachments.length === 0 ? (
                        <div className="empty-attachments">
                          لا توجد ملفات فعلية مرفقة مع هذه المعاملة.
                        </div>
                      ) : null}
                    </div>
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

                <EvidenceList
                  title="أدلة المستندات من المصدر"
                  citations={selectedApplication.review.documentEvidence.slice(
                    0,
                    8,
                  )}
                  onPreviewSource={openSourcePreview}
                />
                <EvidenceList
                  title="أدلة الخطوات الإجرائية من المصدر"
                  citations={selectedApplication.review.workflowEvidence.slice(
                    0,
                    6,
                  )}
                  onPreviewSource={openSourcePreview}
                />

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
                لا توجد معاملة محددة للمراجعة. بعد إرسال أول طلب من طبقة المكتب
                سيظهر هنا ملف البلدية الحقيقي المرتبط به.
              </div>
            )}
          </section>
        </main>
      )}

      <footer className="site-footer">
        <div className="site-footer-brand">
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

        <div className="site-footer-summary">
          <div className="site-footer-stat">
            <strong>رخص هندسية</strong>
            <span>
              إدارة الطلب من الاستلام الأولي حتى قرار الاعتماد أو طلب الاستكمال
            </span>
          </div>
          <div className="site-footer-stat">
            <strong>تحليل ذكي</strong>
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
          <span>نسخة عمل داخلية للاستخدام التشغيلي والتطوير</span>
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
                <small>معاينة مباشرة لملف المصدر</small>
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
