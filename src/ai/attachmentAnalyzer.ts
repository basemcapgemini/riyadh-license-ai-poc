import mammoth from "mammoth/mammoth.browser";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist";
import { recognize } from "tesseract.js";
import { requestCadPageClassification } from "../api/cadPageClassification";
import { requestAttachmentExtraction } from "../api/attachmentExtraction";
import { requestAttachmentValidation } from "../api/attachmentValidation";
import type {
  AttachmentAiValidation,
  AttachmentAnalysisTraceEvent,
  AttachmentPreview,
  LicensePolicy,
  UploadedAttachment,
} from "../types";
import { getSearchTerms, normalizeArabic } from "./policySearch";

GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.mjs",
  import.meta.url,
).toString();

const MAX_ATTACHMENT_TEXT_LENGTH = 24000;
const MAX_AI_ATTACHMENT_TEXT_LENGTH = 6000;
const AI_PDF_BATCH_SIZE = 6;
const MAX_PARALLEL_ATTACHMENT_ANALYSIS = 1;
const MAX_PDF_OCR_FALLBACK_PAGES = 6;
const CAD_SAMPLE_LOCAL_TEXT_PAGES = 10;
const CAD_CLASSIFICATION_BATCH_SIZE = 12;
const CAD_MAX_EXTRACTION_PAGES = 18;
const CAD_MIN_RELEVANT_EXTRACTION_PAGES = 8;
const DEFAULT_CPU_COUNT = 6;
const PDF_OCR_FALLBACK_CONCURRENCY = 2;
const CAD_MIN_PAGES = 40;
const CAD_MIN_FILE_SIZE_BYTES = 15 * 1024 * 1024;

function getAvailableCpuCount(): number {
  if (
    typeof navigator !== "undefined" &&
    Number.isFinite(navigator.hardwareConcurrency) &&
    navigator.hardwareConcurrency > 0
  ) {
    return navigator.hardwareConcurrency;
  }

  return DEFAULT_CPU_COUNT;
}

const AVAILABLE_CPU_COUNT = getAvailableCpuCount();
const AI_PDF_BATCH_CONCURRENCY = Math.min(
  2,
  Math.max(1, Math.floor(AVAILABLE_CPU_COUNT / 4)),
);
const AI_PDF_RENDER_CONCURRENCY = Math.min(
  6,
  Math.max(3, Math.ceil(AVAILABLE_CPU_COUNT / 2)),
);
const PDF_TEXT_READ_CONCURRENCY = Math.min(
  10,
  Math.max(4, AVAILABLE_CPU_COUNT),
);

type AnalyzeAttachmentsOptions = {
  onProgress?: (event: AttachmentAnalysisTraceEvent) => void;
};

type ProgressReporter = (
  event: Omit<AttachmentAnalysisTraceEvent, "id">,
) => void;

function buildAttachmentId(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

function summarizeText(text: string): string {
  return text.slice(0, 260).trim();
}

function escapePreviewHtml(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrapPreviewHtml(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="ar" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapePreviewHtml(title)}</title>
    <style>
      body { margin: 0; padding: 24px; font-family: "Noto Sans Arabic", "Segoe UI", sans-serif; background: #f6faf8; color: #14251f; line-height: 1.8; }
      .preview-shell { max-width: 980px; margin: 0 auto; background: #fff; border: 1px solid rgba(0, 105, 70, 0.1); border-radius: 18px; padding: 24px; box-shadow: 0 12px 30px rgba(20, 37, 31, 0.08); }
      h1 { margin: 0 0 16px; font-size: 1.2rem; }
      pre { white-space: pre-wrap; word-break: break-word; margin: 0; }
      img { max-width: 100%; height: auto; display: block; margin: 0 auto; }
      table { width: 100%; border-collapse: collapse; }
    </style>
  </head>
  <body>
    <div class="preview-shell">
      <h1>${escapePreviewHtml(title)}</h1>
      ${bodyHtml}
    </div>
  </body>
</html>`;
}

async function buildAttachmentPreview(
  file: File,
  sourceType: UploadedAttachment["sourceType"],
  extractedText: string,
): Promise<AttachmentPreview> {
  if (sourceType === "pdf") {
    return {
      fileName: file.name,
      kind: "pdf",
      url: URL.createObjectURL(file),
      revokeObjectUrl: true,
    };
  }

  if (sourceType === "image") {
    return {
      fileName: file.name,
      kind: "image",
      url: URL.createObjectURL(file),
      revokeObjectUrl: true,
    };
  }

  if (sourceType === "docx") {
    try {
      const buffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer: buffer });
      return {
        fileName: file.name,
        kind: "html",
        html: wrapPreviewHtml(
          file.name,
          `<pre>${escapePreviewHtml(result.value || extractedText)}</pre>`,
        ),
      };
    } catch {
      return {
        fileName: file.name,
        kind: "html",
        html: wrapPreviewHtml(
          file.name,
          `<pre>${escapePreviewHtml(extractedText)}</pre>`,
        ),
      };
    }
  }

  if (sourceType === "text" || sourceType === "unknown") {
    return {
      fileName: file.name,
      kind: "html",
      html: wrapPreviewHtml(
        file.name,
        `<pre>${escapePreviewHtml(extractedText || "لا يوجد محتوى نصي متاح للمعاينة.")}</pre>`,
      ),
    };
  }

  return {
    fileName: file.name,
    kind: "unsupported",
    message: "المعاينة غير متاحة لهذا الملف.",
  };
}

function normalizeExtractedText(text: string): string {
  return String(text)
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function createProgressReporter(
  onProgress?: AnalyzeAttachmentsOptions["onProgress"],
): ProgressReporter {
  let eventCount = 0;

  return (event) => {
    if (!onProgress) {
      return;
    }

    eventCount += 1;
    onProgress({
      id: `analysis-event-${eventCount}`,
      ...event,
    });
  };
}

function hasMeaningfulPdfText(text: string): boolean {
  return normalizeExtractedText(text).length >= 80;
}

function hasSufficientAttachmentText(text: string): boolean {
  return normalizeExtractedText(text).length >= 600;
}

async function renderPdfPageToDataUrl(
  page: PDFPageProxy,
  options: { scale?: number; mimeType?: string; quality?: number } = {},
): Promise<string> {
  const { scale = 2, mimeType = "image/png", quality = 0.92 } = options;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("Canvas 2D context is unavailable for PDF OCR.");
  }

  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));

  await page.render({ canvasContext: context, viewport }).promise;
  return canvas.toDataURL(mimeType, quality);
}

async function readPdfPageText(page: PDFPageProxy): Promise<string> {
  const content = await page.getTextContent();
  const pageText = content.items
    .map((item) => ("str" in item ? item.str : ""))
    .join(" ");
  return normalizeExtractedText(pageText);
}

async function readPdfPageWithOcr(page: PDFPageProxy): Promise<string> {
  const dataUrl = await renderPdfPageToDataUrl(page);
  const result = await recognize(dataUrl, "ara+eng");
  return normalizeExtractedText(result.data.text);
}

async function runPdfOcrFallback(
  pdf: PDFDocumentProxy,
  pages: string[],
  fileName: string,
  reportProgress: ProgressReporter,
): Promise<string[]> {
  const weakPageNumbers = pages
    .map((pageText, index) => ({ pageNumber: index + 1, pageText }))
    .filter(({ pageText }) => !hasMeaningfulPdfText(pageText))
    .map(({ pageNumber }) => pageNumber)
    .slice(0, MAX_PDF_OCR_FALLBACK_PAGES);

  if (weakPageNumbers.length === 0) {
    return pages;
  }

  reportProgress({
    operationKey: `ocr-${fileName}`,
    phase: "ocr",
    status: "running",
    title: `OCR احتياطي لملف ${fileName}`,
    detail: `فشل التحليل الذكي أو تعذر الوصول إليه، لذلك يتم تشغيل OCR على أول ${weakPageNumbers.length} صفحات منخفضة النص فقط لتجنب التأخير الكبير.`,
    fileName,
  });

  const ocrResults = await mapWithConcurrency(
    weakPageNumbers,
    PDF_OCR_FALLBACK_CONCURRENCY,
    async (pageNumber) => {
      const page = await pdf.getPage(pageNumber);
      try {
        return {
          pageNumber,
          text: await readPdfPageWithOcr(page),
        };
      } catch {
        return {
          pageNumber,
          text: "",
        };
      }
    },
  );

  const mergedPages = [...pages];
  ocrResults.forEach(({ pageNumber, text }) => {
    const existingText = mergedPages[pageNumber - 1] ?? "";
    if (text.length > existingText.length) {
      mergedPages[pageNumber - 1] = text;
      return;
    }

    if (text && existingText && !existingText.includes(text)) {
      mergedPages[pageNumber - 1] = normalizeExtractedText(
        `${existingText}\n${text}`,
      );
    }
  });

  reportProgress({
    operationKey: `ocr-${fileName}`,
    phase: "ocr",
    status: "done",
    title: `اكتمل OCR الاحتياطي: ${fileName}`,
    detail: "تم تطبيق OCR فقط كخطة بديلة بعد تعذر إكمال التحليل الذكي.",
    fileName,
  });

  return mergedPages;
}

function selectAllPdfPages(totalPages: number): number[] {
  return Array.from({ length: totalPages }, (_value, index) => index + 1);
}

function chunkPageNumbers(
  pageNumbers: number[],
  chunkSize: number,
): number[][] {
  const chunks: number[][] = [];

  for (let index = 0; index < pageNumbers.length; index += chunkSize) {
    chunks.push(pageNumbers.slice(index, index + chunkSize));
  }

  return chunks;
}

function buildCadLocalTextSamplePageNumbers(totalPages: number): number[] {
  if (totalPages <= 0) {
    return [];
  }

  const selected = new Set<number>([1, totalPages]);
  const targetCount = Math.min(CAD_SAMPLE_LOCAL_TEXT_PAGES, totalPages);

  if (targetCount <= 2) {
    return Array.from(selected).sort((left, right) => left - right);
  }

  const interval = Math.max(1, Math.floor(totalPages / (targetCount - 1)));
  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += interval) {
    selected.add(pageNumber);
    if (selected.size >= targetCount) {
      break;
    }
  }

  selected.add(Math.max(1, Math.ceil(totalPages / 2)));

  return Array.from(selected)
    .filter((pageNumber) => pageNumber >= 1 && pageNumber <= totalPages)
    .sort((left, right) => left - right)
    .slice(0, targetCount);
}

async function readPdfSelectedPagesText(
  pdf: PDFDocumentProxy,
  pageNumbers: number[],
): Promise<string[]> {
  const pages = new Array<string>(pdf.numPages).fill("");

  const selectedTexts = await mapWithConcurrency(
    pageNumbers,
    Math.min(PDF_TEXT_READ_CONCURRENCY, Math.max(2, pageNumbers.length)),
    async (pageNumber) => {
      const page = await pdf.getPage(pageNumber);
      return {
        pageNumber,
        text: await readPdfPageText(page),
      };
    },
  );

  selectedTexts.forEach(({ pageNumber, text }) => {
    pages[pageNumber - 1] = text;
  });

  return pages;
}

async function ensurePdfPageTexts(
  pdf: PDFDocumentProxy,
  pages: string[],
  pageNumbers: number[],
): Promise<string[]> {
  const missingPageNumbers = pageNumbers.filter(
    (pageNumber) => !(pages[pageNumber - 1] ?? "").trim(),
  );

  if (missingPageNumbers.length === 0) {
    return pages;
  }

  const filledPages = [...pages];
  const selectedTexts = await mapWithConcurrency(
    missingPageNumbers,
    Math.min(PDF_TEXT_READ_CONCURRENCY, Math.max(2, missingPageNumbers.length)),
    async (pageNumber) => {
      const page = await pdf.getPage(pageNumber);
      return {
        pageNumber,
        text: await readPdfPageText(page),
      };
    },
  );

  selectedTexts.forEach(({ pageNumber, text }) => {
    filledPages[pageNumber - 1] = text;
  });

  return filledPages;
}

function shouldRunAiForPdf(
  pages: string[],
  localDetectedDocuments: string[],
): boolean {
  const weakPagesCount = pages.filter(
    (pageText) => !hasMeaningfulPdfText(pageText),
  ).length;
  const weakPagesRatio = pages.length > 0 ? weakPagesCount / pages.length : 1;
  const combinedText = normalizeExtractedText(pages.join("\n\n"));

  if (!hasSufficientAttachmentText(combinedText)) {
    return true;
  }

  if (localDetectedDocuments.length === 0) {
    return true;
  }

  return weakPagesRatio >= 0.35;
}

async function mapWithConcurrency<TItem, TResult>(
  items: TItem[],
  concurrency: number,
  mapper: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(concurrency, items.length)) },
      () => worker(),
    ),
  );

  return results;
}

async function buildPdfPageImagesForAi(
  pdf: PDFDocumentProxy,
  pageNumbers: number[],
): Promise<Array<{ pageNumber: number; dataUrl: string }>> {
  return mapWithConcurrency(
    pageNumbers,
    AI_PDF_RENDER_CONCURRENCY,
    async (pageNumber) => {
      const page = await pdf.getPage(pageNumber);
      return {
        pageNumber,
        dataUrl: await renderPdfPageToDataUrl(page, {
          scale: 1.5,
          mimeType: "image/jpeg",
          quality: 0.82,
        }),
      };
    },
  );
}

async function buildPdfPageImagesForCadClassification(
  pdf: PDFDocumentProxy,
  pageNumbers: number[],
): Promise<Array<{ pageNumber: number; dataUrl: string }>> {
  return mapWithConcurrency(
    pageNumbers,
    Math.min(3, Math.max(1, pageNumbers.length)),
    async (pageNumber) => {
      const page = await pdf.getPage(pageNumber);
      return {
        pageNumber,
        dataUrl: await renderPdfPageToDataUrl(page, {
          scale: 1,
          mimeType: "image/jpeg",
          quality: 0.68,
        }),
      };
    },
  );
}

function sampleEvenly(pageNumbers: number[], targetCount: number): number[] {
  if (pageNumbers.length <= targetCount) {
    return [...pageNumbers];
  }

  if (targetCount <= 1) {
    return pageNumbers.length > 0 ? [pageNumbers[0]] : [];
  }

  const selected = new Set<number>();
  const lastIndex = pageNumbers.length - 1;

  for (let index = 0; index < targetCount; index += 1) {
    const ratio = index / (targetCount - 1);
    const pageIndex = Math.round(lastIndex * ratio);
    selected.add(pageNumbers[Math.max(0, Math.min(lastIndex, pageIndex))]);
  }

  return Array.from(selected)
    .sort((left, right) => left - right)
    .slice(0, targetCount);
}

function selectCadRelevantPages(
  criticalPages: number[],
  supportingPages: number[],
  allPageNumbers: number[],
): number[] {
  if (criticalPages.length >= CAD_MAX_EXTRACTION_PAGES) {
    return sampleEvenly(criticalPages, CAD_MAX_EXTRACTION_PAGES);
  }

  if (
    criticalPages.length + supportingPages.length >=
    CAD_MIN_RELEVANT_EXTRACTION_PAGES
  ) {
    const remainingSlots = Math.max(
      0,
      CAD_MAX_EXTRACTION_PAGES - criticalPages.length,
    );
    return [
      ...criticalPages,
      ...sampleEvenly(supportingPages, remainingSlots),
    ].sort((left, right) => left - right);
  }

  return sampleEvenly(
    allPageNumbers,
    Math.min(CAD_MIN_RELEVANT_EXTRACTION_PAGES, allPageNumbers.length),
  );
}

async function classifyCadPagesForExtraction(
  file: File,
  pdf: PDFDocumentProxy,
  pages: string[],
  policy: LicensePolicy,
  reportProgress: ProgressReporter,
): Promise<{
  effectivePageNumbers: number[];
  pages: string[];
  notes: string[];
}> {
  const allPageNumbers = selectAllPdfPages(pdf.numPages);
  const pageBatches = chunkPageNumbers(
    allPageNumbers,
    CAD_CLASSIFICATION_BATCH_SIZE,
  );
  const criticalPages = new Set<number>();
  const supportingPages = new Set<number>();
  let enrichedPages = [...pages];

  reportProgress({
    operationKey: `cad-triage-${file.name}`,
    phase: "ai",
    status: "running",
    title: `فرز صفحات الملف الكبير: ${file.name}`,
    detail: `سيتم تنفيذ مرور فرز منخفض التكلفة على ${allPageNumbers.length} صفحة لتقليل عدد الصفحات التي ستذهب إلى التحليل الأقوى لاحقاً.`,
    fileName: file.name,
  });

  try {
    for (const pageBatch of pageBatches) {
      enrichedPages = await ensurePdfPageTexts(pdf, enrichedPages, pageBatch);
      const pageImages = await buildPdfPageImagesForCadClassification(
        pdf,
        pageBatch,
      );

      if (pageImages.length === 0) {
        continue;
      }

      const classification = await requestCadPageClassification({
        fileName: file.name,
        mimeType: file.type || "application/pdf",
        requiredDocuments: policy.requiredDocuments,
        pageImages,
        localPageTexts: pageBatch.map((pageNumber) => ({
          pageNumber,
          text: enrichedPages[pageNumber - 1] ?? "",
        })),
      });

      classification.pages.forEach((page) => {
        if (page.relevance === "critical") {
          criticalPages.add(page.pageNumber);
          return;
        }

        if (page.relevance === "supporting") {
          supportingPages.add(page.pageNumber);
        }
      });
    }
  } catch {
    const fallbackPageNumbers = sampleEvenly(
      allPageNumbers,
      Math.min(CAD_MAX_EXTRACTION_PAGES, allPageNumbers.length),
    );

    reportProgress({
      operationKey: `cad-triage-${file.name}`,
      phase: "ai",
      status: "error",
      title: `تعذر فرز صفحات الملف الكبير: ${file.name}`,
      detail: `تعذر تشغيل فرز الصفحات منخفض التكلفة، لذلك سيتم الاكتفاء بعينة موزعة من ${fallbackPageNumbers.length} صفحة بدلاً من إرسال الملف كاملاً.`,
      fileName: file.name,
    });

    return {
      effectivePageNumbers: fallbackPageNumbers,
      pages: enrichedPages,
      notes: [
        `تعذر تشغيل فرز صفحات CAD، لذلك تم تحليل عينة موزعة من ${fallbackPageNumbers.length} صفحة لتقليل الضغط على حد المعدل.`,
      ],
    };
  }

  const effectivePageNumbers = selectCadRelevantPages(
    Array.from(criticalPages).sort((left, right) => left - right),
    Array.from(supportingPages).sort((left, right) => left - right),
    allPageNumbers,
  );

  reportProgress({
    operationKey: `cad-triage-${file.name}`,
    phase: "ai",
    status: "done",
    title: `اكتمل فرز صفحات الملف الكبير: ${file.name}`,
    detail: `تم اختيار ${effectivePageNumbers.length} صفحة فقط للتحليل الأقوى بدلاً من ${allPageNumbers.length} صفحة كاملة.`,
    fileName: file.name,
  });

  return {
    effectivePageNumbers,
    pages: enrichedPages,
    notes: [
      `تم تنفيذ فرز صفحات CAD أولاً، ثم اختيار ${effectivePageNumbers.length} صفحة فقط للتحليل الأقوى بدلاً من ${allPageNumbers.length}.`,
    ],
  };
}

function shouldUseCadMode(
  file: File,
  pdf: PDFDocumentProxy,
  pages: string[],
): boolean {
  const weakPagesCount = pages.filter(
    (pageText) => !hasMeaningfulPdfText(pageText),
  ).length;
  const weakPagesRatio = pages.length > 0 ? weakPagesCount / pages.length : 1;

  return (
    pdf.numPages >= CAD_MIN_PAGES &&
    (file.size >= CAD_MIN_FILE_SIZE_BYTES || weakPagesRatio >= 0.5)
  );
}

function detectDocuments(
  policy: LicensePolicy,
  attachmentText: string,
  fileName: string,
  seededDocuments: string[] = [],
  seededNotes: string[] = [],
): { detectedDocuments: string[]; notes: string[] } {
  const haystack = normalizeArabic(`${fileName} ${attachmentText}`);
  const detectedDocuments = new Set(
    seededDocuments.filter((documentName) =>
      policy.requiredDocuments.includes(documentName),
    ),
  );

  policy.requiredDocuments.forEach((documentName) => {
    const aliases = getSearchTerms(documentName);
    if (aliases.some((alias) => haystack.includes(normalizeArabic(alias)))) {
      detectedDocuments.add(documentName);
    }
  });

  const notes = seededNotes.filter(Boolean);
  if (!attachmentText.trim()) {
    notes.push("تعذر استخراج نص واضح من هذا الملف.");
  }
  if (detectedDocuments.size === 0) {
    notes.push("لم يتم ربط الملف تلقائياً بمستند مطلوب ضمن السياسة الحالية.");
  }

  return {
    detectedDocuments: policy.requiredDocuments.filter((documentName) =>
      detectedDocuments.has(documentName),
    ),
    notes: Array.from(new Set(notes)),
  };
}

async function readPdf(
  file: File,
  policy: LicensePolicy,
  reportProgress: ProgressReporter,
): Promise<{
  extractedText: string;
  detectedDocuments: string[];
  notes: string[];
  aiConfidence?: number;
}> {
  const buffer = await file.arrayBuffer();
  const pdf = await getDocument({ data: buffer }).promise;

  reportProgress({
    operationKey: `read-${file.name}`,
    phase: "read",
    status: "running",
    title: `قراءة ملف PDF: ${file.name}`,
    detail: `تم فتح الملف ويجري تحليل ${pdf.numPages} صفحة محلياً قبل إرسالها إلى الذكاء الاصطناعي عند الحاجة.`,
    fileName: file.name,
  });

  const fastCadCandidate =
    pdf.numPages >= CAD_MIN_PAGES && file.size >= CAD_MIN_FILE_SIZE_BYTES;

  let pages = fastCadCandidate
    ? await readPdfSelectedPagesText(
        pdf,
        buildCadLocalTextSamplePageNumbers(pdf.numPages),
      )
    : await mapWithConcurrency(
        selectAllPdfPages(pdf.numPages),
        PDF_TEXT_READ_CONCURRENCY,
        async (pageNumber) => {
          const page = await pdf.getPage(pageNumber);
          return readPdfPageText(page);
        },
      );

  reportProgress({
    operationKey: `read-${file.name}`,
    phase: "read",
    status: "done",
    title: `اكتملت القراءة المحلية للملف: ${file.name}`,
    detail: fastCadCandidate
      ? `هذا ملف كبير، لذلك تمت قراءة عينة محلية سريعة من الصفحات فقط أولاً لتسريع القرار قبل التحليل الذكي.`
      : `تمت قراءة النص المضمّن محلياً من ${pdf.numPages} صفحة، ويجري الآن استكمال التحليل الذكي الكامل.`,
    fileName: file.name,
  });

  let extractedText = normalizeExtractedText(
    pages
      .map((pageText, index) =>
        pageText ? `[[page:${index + 1}]]\n${pageText}` : "",
      )
      .filter(Boolean)
      .join("\n\n"),
  ).slice(0, MAX_ATTACHMENT_TEXT_LENGTH);

  const localDetection = detectDocuments(policy, extractedText, file.name);
  if (
    !fastCadCandidate &&
    !shouldRunAiForPdf(pages, localDetection.detectedDocuments)
  ) {
    reportProgress({
      operationKey: `ai-overall-${file.name}`,
      phase: "ai",
      status: "done",
      title: `تم تجاوز التحليل الذكي المكلف: ${file.name}`,
      detail:
        "القراءة المحلية كانت كافية لاكتشاف المستندات المطلوبة، لذلك لم يتم إرسال كل صفحات الملف إلى النموذج.",
      fileName: file.name,
      detectedDocuments: localDetection.detectedDocuments,
    });

    reportProgress({
      operationKey: `file-${file.name}`,
      phase: "done",
      status: "done",
      title: `اكتمل تحليل ${file.name}`,
      detail:
        localDetection.detectedDocuments.length > 0
          ? `انتهى التحليل المحلي وتم ربط الملف مبدئياً بـ ${localDetection.detectedDocuments.length} مستندات مطلوبة دون استدعاء الذكاء الاصطناعي.`
          : "انتهى التحليل المحلي لهذا الملف دون الحاجة إلى استدعاء الذكاء الاصطناعي.",
      fileName: file.name,
      detectedDocuments: localDetection.detectedDocuments,
    });

    return {
      extractedText,
      detectedDocuments: localDetection.detectedDocuments,
      notes: Array.from(
        new Set([
          ...localDetection.notes,
          "تم الاكتفاء بالقراءة المحلية لتقليل التكلفة لأن النص المستخرج كان واضحاً بما يكفي.",
        ]),
      ),
    };
  }

  try {
    const cadMode = shouldUseCadMode(file, pdf, pages);
    let effectivePageNumbers = selectAllPdfPages(pdf.numPages);
    let cadTriageNotes: string[] = [];

    if (cadMode) {
      const cadTriage = await classifyCadPagesForExtraction(
        file,
        pdf,
        pages,
        policy,
        reportProgress,
      );
      effectivePageNumbers = cadTriage.effectivePageNumbers;
      pages = cadTriage.pages;
      cadTriageNotes = cadTriage.notes;
    }

    pages = await ensurePdfPageTexts(pdf, pages, effectivePageNumbers);
    const pageBatches = chunkPageNumbers(
      effectivePageNumbers,
      AI_PDF_BATCH_SIZE,
    );
    reportProgress({
      operationKey: `ai-overall-${file.name}`,
      phase: "ai",
      status: "running",
      title: `تحليل ذكي لجميع الصفحات: ${file.name}`,
      detail: cadMode
        ? `هذا ملف CAD كبير، لذلك سيتم إرسال ${effectivePageNumbers.length} صفحة مرشحة فقط بعد فرز أولي منخفض التكلفة، بدلاً من إرسال الملف كاملاً.`
        : `سيتم إرسال جميع صفحات الملف (${effectivePageNumbers.length} صفحة) على ${pageBatches.length} دفعات متوازية حتى لا يتم تجاهل أي صفحة.`,
      fileName: file.name,
    });

    const batchResults = await mapWithConcurrency(
      pageBatches,
      AI_PDF_BATCH_CONCURRENCY,
      async (pageBatch) => {
        const batchOperationKey = `ai-batch-${file.name}-${pageBatch[0]}-${pageBatch[pageBatch.length - 1]}`;
        reportProgress({
          operationKey: batchOperationKey,
          phase: "ai",
          status: "running",
          title: `دفعة صفحات ${pageBatch[0]}-${pageBatch[pageBatch.length - 1]}`,
          detail: `يتم الآن تجهيز وإرسال الصفحات ${pageBatch.join("، ")} إلى نموذج الرؤية لاستخراج عناوين اللوحات والمستندات.`,
          fileName: file.name,
        });

        const pageImages = await buildPdfPageImagesForAi(pdf, pageBatch);
        if (pageImages.length === 0) {
          return {
            pageBatch,
            detectedDocuments: [] as string[],
            notes: [] as string[],
            extractedText: "",
          };
        }

        const aiExtraction = await requestAttachmentExtraction({
          fileName: file.name,
          mimeType: file.type || "application/pdf",
          requiredDocuments: policy.requiredDocuments,
          extractionMode: cadMode ? "cad-critical" : "standard",
          localExtractedText: pageBatch
            .map((pageNumber) => pages[pageNumber - 1] ?? "")
            .join("\n\n")
            .slice(0, MAX_AI_ATTACHMENT_TEXT_LENGTH),
          pageImages,
        });

        reportProgress({
          operationKey: batchOperationKey,
          phase: "ai",
          status: "done",
          title: `استجابة الذكاء الاصطناعي لدفعة ${pageBatch[0]}-${pageBatch[pageBatch.length - 1]}`,
          detail:
            aiExtraction.detectedDocuments.length > 0
              ? `تم التعرف على ${aiExtraction.detectedDocuments.length} مستندات مرشحة من هذه الدفعة.`
              : "لم تُرجع هذه الدفعة مستندات مطابقة واضحة، وتم الاحتفاظ بملخص النص المستخرج فقط.",
          fileName: file.name,
          model: aiExtraction.model,
          detectedDocuments: aiExtraction.detectedDocuments,
          responseSummary: normalizeExtractedText(
            aiExtraction.extractedText,
          ).slice(0, 220),
        });

        return {
          pageBatch,
          detectedDocuments: aiExtraction.detectedDocuments ?? [],
          notes: aiExtraction.notes ?? [],
          extractedText: aiExtraction.extractedText ?? "",
          confidence: Number.isFinite(aiExtraction.confidence)
            ? aiExtraction.confidence
            : 0,
        };
      },
    );

    const aiDetectedDocuments = new Set<string>();
    const aiNotes: string[] = [];
    const aiTexts: string[] = [];
    const aiConfidences: number[] = [];

    batchResults.forEach(
      ({
        pageBatch,
        detectedDocuments,
        notes,
        extractedText: batchText,
        confidence,
      }) => {
        detectedDocuments.forEach((documentName) =>
          aiDetectedDocuments.add(documentName),
        );
        aiNotes.push(...notes);
        if (
          typeof confidence === "number" &&
          Number.isFinite(confidence) &&
          confidence > 0
        ) {
          aiConfidences.push(confidence);
        }
        if (batchText) {
          aiTexts.push(`[[ai-pages:${pageBatch.join(",")}]]\n${batchText}`);
        }
      },
    );

    extractedText = normalizeExtractedText(
      [extractedText, ...aiTexts].filter(Boolean).join("\n\n"),
    ).slice(0, MAX_ATTACHMENT_TEXT_LENGTH);

    const notes = Array.from(
      new Set([...localDetection.notes, ...cadTriageNotes, ...aiNotes]),
    );
    if (aiTexts.length > 0) {
      notes.push(
        cadMode
          ? `تم استخدام وضع CAD الاقتصادي: جرى فرز الصفحات أولاً ثم تحليل ${effectivePageNumbers.length} صفحة مرشحة فقط بالنموذج الأقوى.`
          : `تمت إضافة قراءة ذكية على جميع صفحات الملف (${effectivePageNumbers.length} صفحة).`,
      );
    }

    reportProgress({
      operationKey: `ai-overall-${file.name}`,
      phase: "ai",
      status: "done",
      title: `اكتمل التحليل الذكي لجميع الصفحات: ${file.name}`,
      detail: `اكتملت جميع دفعات الذكاء الاصطناعي للملف بعد تحليل ${effectivePageNumbers.length} صفحات مرشحة.`,
      fileName: file.name,
      detectedDocuments: Array.from(aiDetectedDocuments),
    });

    reportProgress({
      operationKey: `file-${file.name}`,
      phase: "done",
      status: "done",
      title: `اكتمل تحليل ${file.name}`,
      detail:
        aiDetectedDocuments.size > 0
          ? `انتهى التحليل وتم ربط الملف مبدئياً بـ ${aiDetectedDocuments.size} مستندات مطلوبة.`
          : "انتهى التحليل دون ربط واضح بمستندات مطلوبة، ويمكن مراجعة الملخصات التفصيلية أدناه.",
      fileName: file.name,
      detectedDocuments: Array.from(aiDetectedDocuments),
    });

    return {
      extractedText,
      detectedDocuments: Array.from(aiDetectedDocuments),
      notes,
      aiConfidence:
        aiConfidences.length > 0
          ? Math.round(
              aiConfidences.reduce((sum, value) => sum + value, 0) /
                aiConfidences.length,
            )
          : undefined,
    };
  } catch {
    pages = await runPdfOcrFallback(pdf, pages, file.name, reportProgress);
    extractedText = normalizeExtractedText(
      pages
        .map((pageText, index) =>
          pageText ? `[[page:${index + 1}]]\n${pageText}` : "",
        )
        .filter(Boolean)
        .join("\n\n"),
    ).slice(0, MAX_ATTACHMENT_TEXT_LENGTH);

    reportProgress({
      operationKey: `ai-overall-${file.name}`,
      phase: "ai",
      status: "error",
      title: `تعذر إكمال التحليل الذكي: ${file.name}`,
      detail:
        "حدث خطأ أثناء التحليل الذكي وتمت العودة إلى القراءة المحلية فقط لهذا الملف.",
      fileName: file.name,
    });

    return {
      extractedText,
      detectedDocuments: [],
      notes: [
        "تعذر تشغيل الاستخراج الذكي من الخادم، وتم الاعتماد على القراءة المحلية فقط.",
      ],
      aiConfidence: 0,
    };
  }
}

async function readDocx(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return result.value.slice(0, 12000);
}

async function readImageWithOcr(file: File): Promise<string> {
  const result = await recognize(file, "ara+eng");
  return result.data.text.slice(0, 8000);
}

async function readTextLikeFile(file: File): Promise<string> {
  const text = await file.text();
  return text.slice(0, 12000);
}

async function extractText(
  file: File,
  policy: LicensePolicy,
  reportProgress: ProgressReporter,
): Promise<{
  sourceType: UploadedAttachment["sourceType"];
  extractedText: string;
  detectedDocuments: string[];
  notes: string[];
  aiConfidence?: number;
}> {
  const lowerName = file.name.toLowerCase();

  reportProgress({
    operationKey: `file-${file.name}`,
    phase: "upload",
    status: "running",
    title: `بدء تحليل الملف ${file.name}`,
    detail: `نوع الملف: ${file.type || "غير معروف"}، الحجم التقريبي: ${Math.max(1, Math.round(file.size / 1024))} كيلوبايت.`,
    fileName: file.name,
  });

  if (lowerName.endsWith(".pdf")) {
    const pdfResult = await readPdf(file, policy, reportProgress);
    return { sourceType: "pdf", ...pdfResult };
  }
  if (lowerName.endsWith(".docx")) {
    reportProgress({
      operationKey: `read-${file.name}`,
      phase: "read",
      status: "done",
      title: `تمت قراءة DOCX: ${file.name}`,
      detail: "استخراج نص DOCX تم محلياً دون الحاجة إلى تحليل بصري إضافي.",
      fileName: file.name,
    });
    return {
      sourceType: "docx",
      extractedText: await readDocx(file),
      detectedDocuments: [],
      notes: [],
      aiConfidence: undefined,
    };
  }
  if (
    lowerName.endsWith(".txt") ||
    lowerName.endsWith(".json") ||
    lowerName.endsWith(".md") ||
    file.type.startsWith("text/")
  ) {
    reportProgress({
      operationKey: `read-${file.name}`,
      phase: "read",
      status: "done",
      title: `تمت قراءة ملف نصي: ${file.name}`,
      detail: "تم استخراج النص مباشرة من الملف دون OCR أو تحليل بصري.",
      fileName: file.name,
    });
    return {
      sourceType: "text",
      extractedText: await readTextLikeFile(file),
      detectedDocuments: [],
      notes: [],
      aiConfidence: undefined,
    };
  }
  if (file.type.startsWith("image/")) {
    reportProgress({
      operationKey: `ocr-${file.name}`,
      phase: "ocr",
      status: "running",
      title: `OCR لصورة ${file.name}`,
      detail: "يتم استخراج النص من الصورة باستخدام OCR محلي.",
      fileName: file.name,
    });
    return {
      sourceType: "image",
      extractedText: await readImageWithOcr(file),
      detectedDocuments: [],
      notes: [],
      aiConfidence: undefined,
    };
  }

  try {
    return {
      sourceType: "unknown",
      extractedText: await readTextLikeFile(file),
      detectedDocuments: [],
      notes: [],
      aiConfidence: undefined,
    };
  } catch {
    return {
      sourceType: "unknown",
      extractedText: "",
      detectedDocuments: [],
      notes: [],
      aiConfidence: undefined,
    };
  }
}

export async function analyzeAttachments(
  files: File[],
  policy: LicensePolicy,
  options: AnalyzeAttachmentsOptions = {},
): Promise<UploadedAttachment[]> {
  const reportProgress = createProgressReporter(options.onProgress);
  reportProgress({
    operationKey: "upload-all",
    phase: "upload",
    status: "running",
    title: "بدء تحليل الملفات المرفوعة",
    detail: `تم استلام ${files.length} ملفات، وسيتم تحليلها وربطها بمستندات السياسة المختارة خطوة بخطوة.`,
  });

  const attachments = await mapWithConcurrency(
    files,
    MAX_PARALLEL_ATTACHMENT_ANALYSIS,
    async (file) => {
      const {
        sourceType,
        extractedText,
        detectedDocuments: seededDocuments,
        notes: seededNotes,
        aiConfidence,
      } = await extractText(file, policy, reportProgress);
      const { detectedDocuments, notes } = detectDocuments(
        policy,
        extractedText,
        file.name,
        seededDocuments,
        seededNotes,
      );

      reportProgress({
        operationKey: `match-${file.name}`,
        phase: "match",
        status: "done",
        title: `مطابقة نتائج ${file.name} مع السياسة`,
        detail:
          detectedDocuments.length > 0
            ? `تمت مطابقة الملف مع: ${detectedDocuments.join("، ")}.`
            : "لم يتم العثور على مطابقة نهائية مؤكدة مع مستندات السياسة الحالية.",
        fileName: file.name,
        detectedDocuments,
      });

      reportProgress({
        operationKey: `validate-${file.name}`,
        phase: "ai",
        status: "running",
        title: `AI validation for ${file.name}`,
        detail:
          "A dedicated AI validation request is being sent for this uploaded file to verify the slot match and return reviewer feedback.",
        fileName: file.name,
        detectedDocuments,
      });

      let aiValidation: AttachmentAiValidation | undefined;
      try {
        const validationResult = await requestAttachmentValidation({
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          sourceType,
          requiredDocuments: policy.requiredDocuments,
          expectedDocument: policy.requiredDocuments[0],
          extractedText,
          detectedDocuments,
          notes,
        });

        aiValidation = {
          status: validationResult.status,
          summary: validationResult.summary,
          feedback: validationResult.feedback,
          confidence: validationResult.confidence,
          model: validationResult.model,
          checklistResults: validationResult.checklistResults,
        };

        reportProgress({
          operationKey: `validate-${file.name}`,
          phase: "ai",
          status: "done",
          title: `AI validation completed for ${file.name}`,
          detail: validationResult.summary,
          fileName: file.name,
          detectedDocuments,
          model: validationResult.model,
          responseSummary: validationResult.feedback.join(" | ").slice(0, 220),
        });
      } catch {
        reportProgress({
          operationKey: `validate-${file.name}`,
          phase: "ai",
          status: "error",
          title: `تعذر التحقق الذكي للملف ${file.name}`,
          detail:
            "فشل طلب التحقق المخصص لهذا الملف، لذلك لن يتم عرض ملاحظات تحقق مولدة محلياً بدلاً من رد النموذج.",
          fileName: file.name,
          detectedDocuments,
        });
      }

      if (aiValidation) {
        reportProgress({
          operationKey: `validate-${file.name}`,
          phase: "ai",
          status: "done",
          title: `اكتمل تحقق الملف ${file.name}`,
          detail: aiValidation.summary,
          fileName: file.name,
          model: aiValidation.model,
          detectedDocuments,
        });
      }

      const attachment = {
        id: buildAttachmentId(file),
        name: file.name,
        mimeType: file.type,
        size: file.size,
        sourceType,
        extractedText,
        excerpt: summarizeText(extractedText),
        detectedDocuments,
        notes,
        preview: await buildAttachmentPreview(file, sourceType, extractedText),
        aiValidation,
      } satisfies UploadedAttachment;
      return attachment;
    },
  );

  reportProgress({
    operationKey: "upload-all",
    phase: "done",
    status: "done",
    title: "اكتمل تحليل جميع الملفات",
    detail: `تم إنهاء تحليل ${attachments.length} ملفات وتجهيز النتائج للعرض وربطها بالسياسة.`,
  });

  return attachments;
}

export function collectDetectedDocuments(
  attachments: UploadedAttachment[],
  policy: LicensePolicy,
): string[] {
  return Array.from(
    new Set(
      attachments
        .flatMap((attachment) => attachment.detectedDocuments)
        .filter((documentName) =>
          policy.requiredDocuments.includes(documentName),
        ),
    ),
  );
}
