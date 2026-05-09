import { fetchJson } from "./http";

export type CadPageClassification = {
  pageNumber: number;
  relevance: "critical" | "supporting" | "ignore";
  reason: string;
  detectedDocuments: string[];
};

export type CadPageClassificationResult = {
  model: string;
  pages: CadPageClassification[];
};

export async function requestCadPageClassification(input: {
  fileName: string;
  mimeType: string;
  requiredDocuments: string[];
  pageImages: Array<{
    pageNumber: number;
    dataUrl: string;
  }>;
  localPageTexts: Array<{
    pageNumber: number;
    text: string;
  }>;
}): Promise<CadPageClassificationResult> {
  return fetchJson<CadPageClassificationResult>(
    "/api/classify-cad-pages",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
    "فشل تشغيل تصنيف صفحات ملف CAD.",
  );
}
