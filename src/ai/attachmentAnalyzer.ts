import mammoth from "mammoth/mammoth.browser";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist";
import { recognize } from "tesseract.js";
import { requestAttachmentExtraction } from "../api/attachmentExtraction";
import type {
  AttachmentAnalysisTraceEvent,
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
const DEFAULT_CPU_COUNT = 6;
const PDF_OCR_FALLBACK_CONCURRENCY = 2;

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
  5,
  Math.max(3, Math.floor(AVAILABLE_CPU_COUNT / 2)),
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
    .map(({ pageNumber }) => pageNumber);

  if (weakPageNumbers.length === 0) {
    return pages;
  }

  reportProgress({
    operationKey: `ocr-${fileName}`,
    phase: "ocr",
    status: "running",
    title: `OCR احتياطي لملف ${fileName}`,
    detail: `فشل التحليل الذكي أو تعذر الوصول إليه، لذلك يتم تشغيل OCR على ${weakPageNumbers.length} صفحات منخفضة النص فقط.`,
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

  let pages = await mapWithConcurrency(
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
    detail: `تمت قراءة النص المضمّن محلياً من ${pdf.numPages} صفحة، ويجري الآن استكمال التحليل الذكي الكامل.`,
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

  try {
    const pageNumbers = selectAllPdfPages(pdf.numPages);
    const pageBatches = chunkPageNumbers(pageNumbers, AI_PDF_BATCH_SIZE);
    reportProgress({
      operationKey: `ai-overall-${file.name}`,
      phase: "ai",
      status: "running",
      title: `تحليل ذكي لجميع الصفحات: ${file.name}`,
      detail: `سيتم إرسال ${pdf.numPages} صفحة على ${pageBatches.length} دفعات متوازية لرفع سرعة المعالجة مع الحفاظ على شمول كل الصفحات.`,
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
          localExtractedText: extractedText.slice(
            0,
            MAX_AI_ATTACHMENT_TEXT_LENGTH,
          ),
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
        };
      },
    );

    const aiDetectedDocuments = new Set<string>();
    const aiNotes: string[] = [];
    const aiTexts: string[] = [];

    batchResults.forEach(
      ({ pageBatch, detectedDocuments, notes, extractedText: batchText }) => {
        detectedDocuments.forEach((documentName) =>
          aiDetectedDocuments.add(documentName),
        );
        aiNotes.push(...notes);
        if (batchText) {
          aiTexts.push(`[[ai-pages:${pageBatch.join(",")}]]\n${batchText}`);
        }
      },
    );

    extractedText = normalizeExtractedText(
      [extractedText, ...aiTexts].filter(Boolean).join("\n\n"),
    ).slice(0, MAX_ATTACHMENT_TEXT_LENGTH);

    const notes = Array.from(new Set(aiNotes));
    if (aiTexts.length > 0) {
      notes.push(
        `تمت إضافة قراءة ذكية على جميع صفحات الملف وعددها ${pageNumbers.length} صفحة.`,
      );
    }

    reportProgress({
      operationKey: `ai-overall-${file.name}`,
      phase: "ai",
      status: "done",
      title: `اكتمل التحليل الذكي لجميع الصفحات: ${file.name}`,
      detail: `اكتملت جميع دفعات الذكاء الاصطناعي للملف بعد تحليل ${pageNumbers.length} صفحة.`,
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
    };
  }

  try {
    return {
      sourceType: "unknown",
      extractedText: await readTextLikeFile(file),
      detectedDocuments: [],
      notes: [],
    };
  } catch {
    return {
      sourceType: "unknown",
      extractedText: "",
      detectedDocuments: [],
      notes: [],
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

  const attachments = await Promise.all(
    files.map(async (file) => {
      const {
        sourceType,
        extractedText,
        detectedDocuments: seededDocuments,
        notes: seededNotes,
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

      return {
        id: buildAttachmentId(file),
        name: file.name,
        mimeType: file.type,
        size: file.size,
        sourceType,
        extractedText,
        excerpt: summarizeText(extractedText),
        detectedDocuments,
        notes,
      } satisfies UploadedAttachment;
    }),
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
