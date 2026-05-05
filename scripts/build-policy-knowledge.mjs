import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const sourcesRoot = path.join(projectRoot, "sources");
const sourceRoot = path.join(sourcesRoot, "policies");
const supplementalRoot = path.join(sourcesRoot, "supplemental");
const supplementalIndexPath = path.join(supplementalRoot, "ss.docx");
const supplementalPdfPaths = [
  path.join(
    supplementalRoot,
    "الدليل الموحد لاشتراطات رخص البناء - النسخة 2.pdf",
  ),
];
const outputPath = path.join(
  projectRoot,
  "src",
  "data",
  "policyKnowledgeBase.generated.json",
);

const policyFiles = {
  "electronic-building-license": "(1)اصدار رخصة بناء الكترونية.docx",
  "building-renewal-amendment": "(2) تجديد وتعديل رخصة البناء.docx",
  "existing-building-correction": "(3) تصحيح وضع مبني قائم.docx",
  "ownership-transfer": "(4) نقل ملكيه.docx",
  "demolition-license": "(5) اصدار رخصة هدم.docx",
  "renovation-license": "(6) اصدار رخصة ترميم.docx",
  "government-demolition-license": "(7) اصدار رخصة هدم حكومي.docx",
  "government-renovation-license": "(8) اصدار رخصة ترميم حكومي.docx",
  "concurrent-building-license": "(9) اصدار رخصة بناء بالتزامن.docx",
  "investment-building-license": "(10) اصدار رخصة بناء استثماري.docx",
  "government-investment-building-license":
    "(11) اصدار رخصة بناء حكومي استثمار.docx",
  "site-preparation-license": "(12) رخصة تجهيز الموقع.docx",
};

function readDocxText(filePath) {
  return execFileSync("textutil", ["-convert", "txt", "-stdout", filePath], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function compactText(value) {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readPdfText(filePath) {
  const data = new Uint8Array(readFileSync(filePath));
  const document = await pdfjsLib.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
  }).promise;
  const pages = [];

  for (let index = 1; index <= document.numPages; index += 1) {
    const page = await document.getPage(index);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (pageText) {
      pages.push(pageText);
    }
  }

  return pages.join("\n\n");
}

function firstNonEmptyLine(text) {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function extractSummarySnippet(text) {
  const markers = ["المستندات المطلوبة", "خطوات تنفيذ العملية", "اسم السياسة"];
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index >= 0) {
      const start = Math.max(0, index - 80);
      const end = Math.min(text.length, index + 320);
      return text.slice(start, end).replace(/\s+/g, " ").trim();
    }
  }
  return text.slice(0, 320).replace(/\s+/g, " ").trim();
}

function toProjectRelative(filePath) {
  return path.relative(projectRoot, filePath).split(path.sep).join("/");
}

const policies = Object.fromEntries(
  Object.entries(policyFiles).map(([policyId, fileName]) => {
    const sourcePath = path.join(sourceRoot, fileName);
    const text = compactText(readDocxText(sourcePath));
    return [
      policyId,
      {
        sourcePath: toProjectRelative(sourcePath),
        sourceFileName: path.basename(sourcePath),
        titleLine: firstNonEmptyLine(text),
        summarySnippet: extractSummarySnippet(text),
        text,
      },
    ];
  }),
);

const supplementalSources = [];

for (const sourcePath of supplementalPdfPaths) {
  const text = compactText(await readPdfText(sourcePath));
  supplementalSources.push({
    sourcePath: toProjectRelative(sourcePath),
    sourceFileName: path.basename(sourcePath),
    titleLine: firstNonEmptyLine(text),
    summarySnippet: extractSummarySnippet(text),
    text,
  });
}

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      sourceRoot: toProjectRelative(sourceRoot),
      supplementalIndexPath: toProjectRelative(supplementalIndexPath),
      supplementalSources,
      policies,
    },
    null,
    2,
  ),
  "utf8",
);

console.log(`Wrote knowledge base to ${outputPath}`);
