import type { LicensePolicy } from "../types";

export type ChecklistDocumentItem = {
  number: string;
  title: string;
};

const checklistDocumentCatalog: ChecklistDocumentItem[] = [
  { number: "1", title: "صورة بطاقة الأحوال المدنية" },
  { number: "2", title: "صورة الصك" },
  {
    number: "3",
    title: "الرفع المساحي موضحًا المناسيب للشوارع المحيطة",
  },
  { number: "3", title: "تقرير مساحي في القطاع مع منسوب" },
  { number: "4", title: "صورة جزئية من المخطط التنظيمي" },
  { number: "7", title: "اقرارات" },
  {
    number: "7",
    title:
      "اقرار من مكتب الهندسي لتحمل مسؤولية الدراسة المعمارية والانشائية والكهربائية والميكانيكية بموجب اتفاقية بين المالك والمكتب الهندسي المصمم والامانة",
  },
  { number: "8", title: "إيصال سداد الرسوم" },
  { number: "9", title: "نموذج تدقيق نظام اشتراطات" },
  { number: "15", title: "شهادة الإشغال" },
  { number: "16", title: "صورة جزئية للموقع (كروكي)" },
  { number: "21", title: "إقرار المالك بتنفيذ لائحة الضوابط 9" },
  {
    number: "21",
    title: "إقرار المالك بتنفيذ لائحة الضوابط والشروط",
  },
  { number: "22", title: "تعهد المكتب الهندسي المشرف" },
  { number: "24", title: "صورة رخصة البناء" },
  { number: "26", title: "محضر تجزئة" },
  { number: "30", title: "شهادة تحمل" },
  { number: "31", title: "صورة من الوكالة الشرعية" },
  { number: "34", title: "صورة لواجهة المبنى" },
  { number: "37", title: "السجل التجاري" },
  { number: "44", title: "تقرير فني" },
  { number: "46", title: "مخططات الدفاع المدني" },
  { number: "48", title: "المخططات المعمارية" },
  { number: "60", title: "موافقة التربية والتعليم" },
  { number: "63", title: "تعهد المخلفات" },
  {
    number: "63",
    title: "تعهد إزالة النفايات ونواتج الحفر بالموقع",
  },
  { number: "64", title: "عقد اشراف" },
  { number: "64", title: "العقد بين مالك العقار ومقدم الطلب" },
  { number: "69", title: "تقرير دراسة التربة" },
  { number: "70", title: "الرفع المساحي من مكتب هندسي" },
  { number: "76", title: "خطاب توجيه" },
  { number: "77", title: "خطاب موافقة الزراعة" },
  { number: "78", title: "ملاحظات بلدية" },
  { number: "79", title: "الموقع العام" },
  { number: "79", title: "صورة الموقع العام" },
  { number: "80", title: "محضر لجنة فنية" },
  { number: "82", title: "المخطط المقترح بعد التعديل" },
  { number: "83", title: "تعهد تنفيذ العزل الحراري" },
  { number: "84", title: "مخطط الوضع القائم" },
  { number: "86", title: "صورة الرخصة القديمة" },
  { number: "87", title: "المخطط المعتمد" },
  { number: "88", title: "خطاب الدفاع المدني" },
  { number: "98", title: "وثيقة التأمين" },
  { number: "100", title: "عقد تفويض المالك للمقاول المنفذ للمشروع" },
  { number: "102", title: "المخطط الكهربائي" },
  { number: "103", title: "المخطط الإنشائي" },
  { number: "106", title: "رخصة هدم" },
  { number: "107", title: "مخططات كفاءة الطاقة" },
  { number: "108", title: "المخططات الميكانيكية" },
  { number: "117", title: "صورة من الطبيعة" },
  { number: "118", title: "عقد الإيجار" },
  { number: "125", title: "شهادة تسجيل وقف" },
  { number: "133", title: "تعهد إغلاق فتحات الخزان" },
  {
    number: "133",
    title: "تعهد اغلاق فتحات خزانات المياه تحت الانشاء",
  },
  { number: "135", title: "نموذج الواجهات" },
];

const checklistDocumentByTitle = new Map(
  checklistDocumentCatalog.map((item) => [item.title, item]),
);

export function getChecklistDocumentItem(
  title: string,
): ChecklistDocumentItem | undefined {
  return checklistDocumentByTitle.get(title);
}

export function formatChecklistDocumentLabel(title: string): string {
  const documentItem = getChecklistDocumentItem(title);
  return documentItem
    ? `${documentItem.number} - ${documentItem.title}`
    : title;
}

export function resolveSubtypeRequiredDocumentItems(
  policy: LicensePolicy,
  projectTypeGroupId: string,
  projectSubtypeId: string,
): ChecklistDocumentItem[] {
  return resolveSubtypeRequiredDocuments(
    policy,
    projectTypeGroupId,
    projectSubtypeId,
  ).map((title) => getChecklistDocumentItem(title) ?? { number: "", title });
}

export function resolveSubtypeRequiredDocuments(
  policy: LicensePolicy,
  projectTypeGroupId: string,
  projectSubtypeId: string,
): string[] {
  const selectedGroup = (policy.projectTypes ?? []).find(
    (group) => group.id === projectTypeGroupId,
  );
  const selectedSubtype = selectedGroup?.subtypes.find(
    (subtype) => subtype.id === projectSubtypeId,
  );

  return selectedSubtype?.requiredDocuments?.length
    ? selectedSubtype.requiredDocuments
    : policy.requiredDocuments;
}

export function buildPolicyWithResolvedDocuments(
  policy: LicensePolicy,
  projectTypeGroupId: string,
  projectSubtypeId: string,
): LicensePolicy {
  return {
    ...policy,
    requiredDocuments: resolveSubtypeRequiredDocuments(
      policy,
      projectTypeGroupId,
      projectSubtypeId,
    ),
  };
}
