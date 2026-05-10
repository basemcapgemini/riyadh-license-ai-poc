import { getChecklistDocumentItem } from "./policyRequiredDocuments";

export type Locale = "ar" | "en";

const exactTextTranslations: Record<string, string> = {
  "أمانة منطقة الرياض": "Riyadh Municipality",
  "منصة تشغيل داخلية لمراجعة الرخص الهندسية":
    "Internal operating platform for engineering license review",
  الرياض: "Riyadh",
  "منصة إثبات مفهوم لاعتماد رخص البناء بمساعدة الذكاء الاصطناعي":
    "AI-assisted proof-of-concept platform for building license approval",
  "استقبال ومراجعة الطلبات": "Intake and application review",
  "تشغيل موحد لفرق المكتب والأمانة":
    "Unified workflow for office and municipality teams",
  "تشغيل موحد لرحلة المكتب والأمانة من الاستقبال حتى الاعتماد":
    "Unified office-to-municipality journey from intake to approval",
  "توحيد استقبال الطلبات الهندسية، فحص المرفقات، وإبراز مؤشرات الاكتمال والمخاطر قبل الإحالة إلى المراجع البلدي المختص.":
    "Unifies engineering application intake, attachment review, and completion and risk signals before routing to the responsible municipal reviewer.",
  "واجهة المكتب الهندسي": "Engineering office view",
  "واجهة الأمانة والمراجعة": "Municipality review view",
  المصدر: "Source",
  "إعداد الطلب": "Application setup",
  "املأ البيانات الأساسية وارفع الملفات، ثم راجع مؤشرات الاكتمال قبل الإرسال.":
    "Complete the basic information, upload the files, then review readiness indicators before submission.",
  "نوع السياسة": "Policy type",
  "نوع المشروع": "Project type",
  "اختر نوع المشروع": "Select a project type",
  "التصنيف التفصيلي للمشروع": "Detailed project classification",
  "اختر التصنيف التفصيلي": "Select the detailed classification",
  "اختر نوع المشروع أولاً": "Select the project type first",
  "تصنيف المشروع المعتمد للمراجعة": "Active project classification for review",
  "عدد المرفقات المطلوبة لهذا التصنيف":
    "Required attachments for this classification",
  "البيانات الأساسية للطلب": "Core application details",
  "اسم المستفيد": "Beneficiary name",
  "الهوية / السجل": "National ID / registration",
  "المكتب الهندسي": "Engineering office",
  "رقم ترخيص المكتب": "Office license number",
  الجوال: "Mobile",
  الحي: "District",
  "رقم القطعة / المخطط": "Plot / plan number",
  "وصف المشروع": "Project description",
  "ملاحظات المكتب للأمانة": "Office notes for the municipality",
  "الملفات المرفوعة ونتيجة الفحص": "Uploaded files and review result",
  "رفع ملف مستقل لكل متطلب": "Upload one file per requirement",
  "لكل مستند مطلوب خانة رفع منفصلة. سيجري فحص الملف المرفوع داخل هذه الخانة مقابل هذا المتطلب فقط، ثم تُعرض لك خلاصة واضحة عن مدى مناسبته.":
    "Each required document has its own upload slot. The uploaded file in that slot is checked only against that requirement, then a clear suitability summary is shown.",
  "مراجعة دفعة ملفات قبل رفعها وتوزيعها":
    "Review a batch of files before uploading and assigning them",
  "الأنواع المدعومة: PDF, DOCX, TXT, JSON, PNG, JPG, WebP. بعد اختيار الدفعة ستظهر معاينة توضح ربط كل ملف بالمتطلب المقترح مع إمكانية إعادة التوزيع يدوياً قبل بدء الرفع.":
    "Supported types: PDF, DOCX, TXT, JSON, PNG, JPG, WebP. After selecting the batch, a preview appears showing the suggested requirement mapping for each file, with the option to reassign files manually before upload starts.",
  "معاينة دفعة الرفع قبل البدء": "Bulk upload preview before start",
  "راجع ربط كل ملف بالمستند المطلوب. يمكن تعديل أي ملف يدوياً، وعند اختيار نفس المتطلب لملف جديد سيتم نقله من الملف السابق داخل هذه الدفعة.":
    "Review how each file is mapped to the required document. Any file can be reassigned manually, and selecting the same requirement for a new file will move that assignment from the previous file in this batch.",
  "جاهز للرفع": "Ready to upload",
  "لم يتم التعيين بعد": "Not assigned yet",
  "المتطلب الذي سيذهب إليه الملف": "Requirement this file will be assigned to",
  "اترك هذا الملف بدون رفع": "Leave this file unuploaded",
  "أقرب متطلب بالاسم": "Closest filename-based requirement",
  "لا يوجد تطابق تلقائي واضح لاسم هذا الملف.":
    "No clear automatic filename match was found for this file.",
  "تم تعديل هذا الربط يدوياً.": "This mapping was changed manually.",
  "إلغاء هذه الدفعة": "Cancel this batch",
  "جاري بدء الرفع": "Starting upload",
  "تأكيد المعاينة وبدء الرفع": "Confirm preview and start upload",
  "جاري فحص الملفات المرفوعة وتجهيز نتائجها...":
    "Reviewing uploaded files and preparing the results...",
  "آخر سجل معالجة": "Latest processing log",
  "يمكنك مراجعة ما تم على الملفات خطوة بخطوة مع ملخص المخرجات التشغيلية.":
    "You can review each processing step for the files along with a summary of the operational output.",
  النموذج: "Model",
  "ملخص الاستجابة": "Response summary",
  المحرك: "Engine",
  إزالة: "Remove",
  "جاري فحص الملف": "Reviewing file",
  "استبدال الملف": "Replace file",
  "جاري فحص الملف المرفوع لهذا المتطلب وإعداد نتيجة التحقق.":
    "Reviewing the uploaded file for this requirement and preparing the validation result.",
  الثقة: "Confidence",
  "نتائج فحص عناصر المخطط المعماري": "Architectural checklist review results",
  متوافق: "Compliant",
  "غير متوافق": "Non-compliant",
  "غير موجود": "Not found",
  "غير مرتبط تلقائياً": "Not automatically matched",
  "ما يلزم قبل الإرسال": "Required before submission",
  "إرسال الطلب إلى واجهة الأمانة": "Submit application to municipality view",
  "حالة التجهيز": "Readiness status",
  "عرض سريع للجاهزية قبل الإرسال إلى الأمانة.":
    "Quick readiness view before submission to the municipality.",
  المكتشف: "Detected",
  "المتحقق منه": "Validated",
  "غير الموجود": "Missing",
  الخلاصة: "Summary",
  "ملف السياسة المصدر": "Source policy file",
  "تم ربط ملف السياسة المصدر بهذه المعاملة.":
    "The source policy file is linked to this application.",
  "لم يتم ربط ملف مصدر بعد.": "No source file has been linked yet.",
  "معاينة الملف": "Preview file",
  "عرض المسار": "Show path",
  "مراجعة واضحة حسب كل ملف": "Clear review by file",
  "كل ملف أدناه يحمل ربطه الخاص بالمستندات والتنبيهات، بدلاً من تجميع الملاحظات في قائمة عامة واحدة.":
    "Each file below carries its own document matches and alerts instead of merging notes into one general list.",
  "ملفات واضحة": "Clear files",
  "ملفات تحتاج انتباهاً": "Files needing attention",
  "ملفات غير مرتبطة": "Unmatched files",
  "مراجع السياسة": "Policy references",
  "ملاحظات إضافية": "Additional notes",
  "لا توجد تنبيهات حرجة في هذه المرحلة.": "No critical alerts at this stage.",
  "تفاصيل التحقق": "Validation details",
  "المرفقات الناقصة": "Missing attachments",
  "جميع المرفقات الأساسية موجودة.": "All essential attachments are present.",
  "مسار التنفيذ حسب السياسة": "Policy workflow",
  "طابور المعاملات": "Application queue",
  "اختر معاملة ثم راجع الحالة المختصرة أولاً.":
    "Select an application and review the short status first.",
  "لا توجد معاملات في واجهة الأمانة بعد. أرسل طلباً من واجهة المكتب الهندسي ليظهر هنا بنفس البيانات الفعلية والمرفقات التي تم فحصها.":
    "No applications are in the municipality view yet. Submit one from the engineering office view and it will appear here with the reviewed files and actual data.",
  المستفيد: "Beneficiary",
  المكتب: "Office",
  الموقع: "Location",
  "وقت التقديم": "Submission time",
  المستلم: "Received",
  "ملخص المراجعة المساندة": "Assisted review summary",
  "المرفقات المستلمة": "Received attachments",
  "لم يتم اكتشاف مستندات مطابقة من الملفات المرفوعة.":
    "No matching documents were detected from the uploaded files.",
  "لا توجد نواقص.": "No missing items.",
  "المرجع الرسمي المستخدم": "Official reference used",
  "تم ربط مرجع رسمي بهذه المراجعة.":
    "An official reference was linked to this review.",
  "لا يوجد ملف مصدر مربوط لهذه السياسة.":
    "No source file is linked to this policy.",
  "لم يتم العثور على مستند مطلوب داخل هذا الملف.":
    "No required document was found in this file.",
  "ردود مقترحة للمكتب الهندسي":
    "Suggested responses for the engineering office",
  "الفحص الآلي لم يرصد تنبيهات إضافية.":
    "The automated review did not detect additional alerts.",
  "الملفات الفعلية التي تم فحصها": "Actual reviewed files",
  "الوصف والملاحظات": "Description and notes",
  "الرد المقترح إلى المكتب الهندسي":
    "Suggested reply to the engineering office",
  "نسخ الرد": "Copy reply",
  "المسار الإجرائي المقترح للبلدية": "Suggested municipality workflow",
  "طلب استكمال من المكتب": "Request completion from office",
  "إعادة للمدقق": "Return to reviewer",
  "اعتماد نهائي": "Final approval",
  "لا توجد معاملة محددة للمراجعة. بعد إرسال أول طلب من واجهة المكتب الهندسي سيظهر هنا ملف الأمانة المرتبط به.":
    "No application is selected for review. After the first submission from the engineering office view, the matching municipality record will appear here.",
  "منظومة داخلية تدعم فرق الاستقبال والتدقيق في فرز الطلبات، التحقق من اكتمال المستندات، وتسريع اتخاذ الإجراء المناسب.":
    "Internal system that supports intake and review teams in sorting applications, validating document completeness, and accelerating the right action.",
  "رخص هندسية": "Engineering licenses",
  "إدارة الطلب من الاستلام الأولي حتى قرار الاعتماد أو طلب الاستكمال":
    "Manage the application from first intake to approval or completion request.",
  "مراجعة مساندة": "Assisted review",
  "استخراج قرائن من الملفات والسياسات لمساندة المراجع دون استبدال القرار البشري":
    "Extract signals from files and policies to support reviewers without replacing human judgment.",
  "جاهزية تشغيلية": "Operational readiness",
  "عرض مركز للحالة والنواقص والتنبيهات بما يساعد على تقليل زمن المراجعة ورفع جودة القرار":
    "Centralized status, missing items, and alerts to reduce review time and improve decision quality.",
  "جميع الحقوق محفوظة لأمانة منطقة الرياض © 2026":
    "All rights reserved to Riyadh Municipality © 2026",
  "نسخة تشغيل داخلية للاستخدام المؤسسي والتطوير المستمر":
    "Internal operating version for enterprise use and continuous improvement",
  إغلاق: "Close",
  "جاري تجهيز معاينة الملف...": "Preparing file preview...",
  "المعاينة غير متاحة لهذا الملف.": "Preview is not available for this file.",
  مكتمل: "Complete",
  "يحتاج تدقيق": "Needs review",
  "غير متاح": "Unavailable",
  "من المراجعة الآلية": "From AI review",
  "من التحقق النظامي": "From rule-based validation",
  "عرض التفاصيل": "Show details",
  "شواهد من الورقة": "Evidence from the document",
  واضح: "Clear",
  "يحتاج انتباهاً": "Needs attention",
  "غير مرتبط": "Unmatched",
  "تم العثور عليه": "Found",
  "تم التحقق منه": "Validated",
  "لا يوجد تحقق مكتمل بعد لهذا الملف.":
    "No completed validation yet for this file.",
  "لا توجد عناصر مفتوحة لهذا الملف.": "There are no open items for this file.",
  "تفاصيل إضافية": "Additional details",
  ملاحظات: "Notes",
  "نتائج التحقق": "Validation results",
  "ما يدعمه الملف": "What the file supports",
  "لم يتم رفع ملفات بعد.": "No files have been uploaded yet.",
  "لا توجد ردود مقترحة إضافية حالياً.":
    "No additional suggested responses at the moment.",
  "نسخ الرد المقترح": "Copy suggested reply",
  "سجل المعالجة": "Processing log",
  "يعرض هذا القسم ما تم تنفيذه على الملفات وملخص المخرجات التشغيلية.":
    "This section shows what ran on the files and a summary of the operational output.",
  "خطوات مكتملة": "Completed steps",
  "خطوات قيد التنفيذ": "Running steps",
  "تقرير الامتثال المنظم": "Structured compliance report",
  "1. معلومات المشروع": "1. Project information",
  "مستوى الثقة": "Confidence level",
  "2. حالة المرفقات": "2. Attachment status",
  "الحالة العامة": "Overall status",
  المرفق: "Attachment",
  الحالة: "Status",
  الملاحظات: "Notes",
  "3. التحقق من اتساق البيانات": "3. Data consistency check",
  الحقل: "Field",
  الصك: "Deed",
  "المستندات الأخرى": "Other documents",
  "4. دقة المرفقات": "4. Attachment accuracy",
  "5. الامتثال المعماري": "5. Architectural compliance",
  "5.1 الامتثال للاشتراطات:": "5.1 Requirements compliance:",
  "5.2 عناصر التدقيق:": "5.2 Checklist items:",
  العنصر: "Item",
  التعليق: "Comment",
  "5.3 المخالفات:": "5.3 Violations:",
  "لم يتم العثور على مخالفات مؤكدة ضمن الأدلة الحالية.":
    "No confirmed violations were found in the current evidence.",
  "6. الملخص النهائي": "6. Final summary",
  "اتساق البيانات": "Data consistency",
  "الامتثال المعماري": "Architectural compliance",
  "القضايا الرئيسية:": "Key issues:",
  "لا توجد قضايا حرجة مسجلة.": "No critical issues are recorded.",
  "جاري استكمال المراجعة المساندة وربط نتائج الملفات بالمرجع التنظيمي.":
    "Completing the assisted review and linking file results to the regulatory reference.",
  "المراجعة المساندة": "Assisted review",
  "القرار المقترح": "Suggested decision",
  "المحرك المستخدم": "Engine used",
  "آخر توليد": "Last generated",
  "أسباب التوصية": "Reasoning",
  "لم يعرض النموذج أسباباً إضافية.":
    "The model did not provide additional reasoning.",
  "العناصر الناقصة": "Missing items",
  "لا توجد عناصر ناقصة إضافية وفق المراجعة اللغوية.":
    "No additional missing items were found by the language review.",
  "المخاطر والقيود": "Risks and limitations",
  "لا توجد مخاطر إضافية بارزة.": "No additional notable risks.",
  "الإجراءات المقترحة": "Suggested actions",
  "لا توجد إجراءات مقترحة إضافية.": "No additional suggested actions.",
  "شواهد المراجعة": "Review evidence",
  "لا توجد شواهد إضافية من مراجعة LLM.":
    "There is no additional evidence from the LLM review.",
  "تم نسخ الرد المقترح للمعاملة": "Suggested reply copied for application",
  "تعذر نسخ الرد المقترح تلقائياً من المتصفح الحالي.":
    "The suggested reply could not be copied automatically in the current browser.",
  "تم نسخ": "Copied",
  "تعذر نسخ النص المقترح تلقائياً من المتصفح الحالي.":
    "The suggested text could not be copied automatically in the current browser.",
  "تعذر تحميل معاينة الملف.": "Could not load the file preview.",
  "الطلب غير مكتمل بعد.": "The application is not complete yet.",
  "اختر نوع المشروع أولاً قبل رفع أي ملف.":
    "Select the project type before uploading any files.",
  "اختر التصنيف التفصيلي للمشروع قبل رفع أي ملف.":
    "Select the detailed project classification before uploading any files.",
  "يرجى رفع الملف أو إعادة الرفع بصيغة أوضح حتى يمكن التحقق من محتواه.":
    "Please upload the file or re-upload a clearer version so its contents can be verified.",
  "الملف شبه مكتمل ويمكن إحالة المعاملة للمشرف مع تدقيق نهائي سريع.":
    "The file is nearly complete and the application can be escalated to the supervisor with a quick final review.",
  "الملف قابل للمعالجة لكن يحتاج استكمالات قبل التوصية بالاعتماد.":
    "The file can be processed but still needs completion before approval can be recommended.",
  "المخاطر مرتفعة والنواقص تمنع التوصية بالاعتماد في هذه المرحلة.":
    "The risks are high and the gaps prevent an approval recommendation at this stage.",
  "إحالة إلى المشرف للاعتماد النهائي مع الاحتفاظ بتوصية الذكاء الاصطناعي في الملف.":
    "Escalate to the supervisor for final approval while keeping the AI recommendation in the file.",
  "إرجاع للمكتب الهندسي بطلب استكمال المرفقات الموضحة في التقرير.":
    "Return the application to the engineering office and request the attachments listed in the report.",
  "إيقاف المعاملة مؤقتاً وطلب استكمال الوثائق الأساسية قبل إعادة الفحص.":
    "Pause the application temporarily and request the core documents before re-review.",
  "لم يتم رفع أي ملفات فعلية للتحليل حتى الآن.":
    "No actual files have been uploaded for analysis yet.",
  "وصف المشروع قصير ولا يكفي لتقييم المخاطر الهندسية.":
    "The project description is too short to assess engineering risks.",
  "بيانات الموقع غير مكتملة ويجب توضيح الحي ورقم القطعة.":
    "Site details are incomplete and the district and plot number must be clarified.",
  "بعض الملفات المرفوعة لم يتم التعرف عليها بالكامل وتحتاج مراجعة بشرية.":
    "Some uploaded files were not fully recognized and need human review.",
  "وثيقة التأمين غير مرفقة رغم أنها عنصر حرج في رخص البناء.":
    "The insurance document is missing even though it is a critical requirement for building licenses.",
  "المخطط الإنشائي مفقود ويمنع رفع التوصية النهائية للاعتماد.":
    "The structural plan is missing and prevents a final approval recommendation.",
  "لا يمكن تمرير رخصة الهدم دون خطابات تصفية الخدمات.":
    "A demolition license cannot proceed without service clearance letters.",
  "الموافقات الخارجية غير مرفقة، وهي مطلوبة قبل اكتمال رخصة تجهيز الموقع.":
    "External approvals are missing, and they are required before the site preparation license can be completed.",
  "معاملة نقل الملكية تحتاج وكالة شرعية عند وجود ممثل عن المالك.":
    "An ownership transfer application requires a power of attorney when someone represents the owner.",
  "طلب استكمال المخططات المعمارية": "Request architectural plans completion",
  "يرجى تزويدنا بالمخططات المعمارية بصيغة أوضح تشمل المساقط والواجهات والقطاعات المعمارية، لأن الملف الحالي لا يكفي لتأكيد اكتمال المراجعة المعمارية.":
    "Please provide clearer architectural plans including floor plans, elevations, and sections, because the current file is not sufficient to confirm a complete architectural review.",
  "التحقق الحالي أظهر أن الملف المعماري موجود أو متوقع، لكن عناصره الأساسية غير مثبتة بشكل كاف.":
    "The current validation shows that the architectural file is present or expected, but its core elements are not sufficiently confirmed.",
  "طلب استكمال المخطط الإنشائي": "Request structural plan completion",
  "يرجى استكمال المخطط الإنشائي مع إظهار العناصر الأساسية مثل القواعد والأعمدة والكمرات أو ما يعادلها، حيث لم تتوفر مؤشرات كافية داخل الملف الحالي لاعتماد المراجعة الإنشائية.":
    "Please complete the structural plan and clearly show core elements such as foundations, columns, beams, or their equivalents, as the current file does not contain enough indicators for structural approval.",
  "الشواهد الحالية لا تكفي لاعتماد المراجعة الإنشائية دون استكمال.":
    "The current evidence is not sufficient to approve the structural review without completion.",
  "طلب استكمال الموقع العام": "Request site plan completion",
  "يرجى إعادة رفع الموقع العام بشكل يظهر حدود الأرض والارتدادات والمواقف والعلاقات المكانية الأساسية، لأن الملف الحالي لا يؤكد اكتمال بيانات الموقع العام.":
    "Please re-upload the site plan in a way that clearly shows plot boundaries, setbacks, parking, and the main spatial relationships, because the current file does not confirm complete site data.",
  "المراجعة الحالية لم تثبت جميع عناصر الموقع العام المطلوبة.":
    "The current review did not confirm all required site plan elements.",
  "إعادة للمدقق الكهربائي": "Return to the electrical reviewer",
  "يرجى استكمال المخطط الكهربائي مع بيان اللوحات والأحمال والإنارة بوضوح، إذ لم تظهر في الملف الحالي مؤشرات كافية لاعتماد المراجعة الكهربائية.":
    "Please complete the electrical plan and clearly show the panels, loads, and lighting, as the current file does not provide enough indicators for electrical approval.",
  "من المناسب إعادة الملف لمدقق التخصص بعد استكمال البيانات الكهربائية.":
    "The file should be returned to the specialist reviewer after the electrical information is completed.",
  "إعادة لمدقق السلامة": "Return to the safety reviewer",
  "يرجى تزويدنا بمخطط الأمن والسلامة بصورة أوضح تبين مخارج الطوارئ ووسائل الإنذار والإطفاء، لأن الشواهد الحالية لا تكفي لاعتماد السلامة.":
    "Please provide a clearer safety and security plan showing emergency exits, alarm systems, and fire-fighting measures, because the current evidence is not sufficient for safety approval.",
  "السلامة تحتاج تحقق تخصصي بعد اكتمال الشواهد داخل اللوحة.":
    "Safety requires specialist verification after the evidence in the sheet is completed.",
  "إحالة إلى المشرف": "Escalate to the supervisor",
  "لا توجد نواقص حرجة تمنع رفع المعاملة للمستوى الإشرافي.":
    "There are no critical gaps preventing the application from being escalated to the supervisory level.",
  "إعادة للمراجع البلدي": "Return to the municipal reviewer",
  "يرجى مراجعة التنبيهات الظاهرة في الملف واستكمال أي ملاحظات تشغيلية قبل إعادة الإحالة للمراجع البلدي.":
    "Please review the alerts shown in the file and complete any operational notes before re-routing it to the municipal reviewer.",
  "لا يوجد إجراء نوعي أوضح من إعادة الملف إلى مسار المراجعة التشغيلية الحالية.":
    "No clearer action is available than returning the file to the current operational review flow.",
  "تعذر استكمال قراءة هذا الملف آلياً في الوقت الحالي.":
    "This file could not be fully read automatically at the moment.",
  "بعد مراجعة الطلب، يظهر أن المعاملة قابلة للاستكمال النهائي مع تحقق بلدي أخير.":
    "After reviewing the application, it appears ready for final completion with a final municipal check.",
  "بعد مراجعة الطلب، تحتاج المعاملة إلى استكمالات قبل المتابعة للاعتماد.":
    "After reviewing the application, it needs completion before it can proceed to approval.",
  "بعد مراجعة الطلب، لا يمكن متابعة المعاملة حالياً قبل معالجة النواقص النظامية الأساسية.":
    "After reviewing the application, it cannot proceed at the moment until the core regulatory gaps are resolved.",
  "قابل للاعتماد": "Ready for approval",
  "بانتظار الاستكمال": "Waiting for completion",
  "يتطلب معالجة": "Needs action",
  "مناسب للاعتماد مع تحقق بشري": "Suitable for approval with human review",
  "بحاجة إلى استكمال معلومات": "Needs more information",
  "غير مناسب حالياً": "Not suitable at the moment",
  "طلب استكمال": "Request completion",
  "إحالة للمشرف": "Escalate to supervisor",
  "اختيار السياسة": "Select policy",
  "إدخال البيانات": "Enter data",
  "رفع الملفات": "Upload files",
  "إرسال الطلب": "Submit application",
  الاستلام: "Intake",
  التدقيق: "Review",
  "طلب استكمال أو اعتماد": "Completion request or approval",
};

const termTranslations: Record<string, string> = {
  "إصدار رخصة بناء إلكترونية": "Electronic Building License Issuance",
  "تجديد وتعديل رخصة البناء": "Building License Renewal and Amendment",
  "تصحيح وضع مبنى قائم": "Existing Building Status Correction",
  "نقل ملكية": "Ownership Transfer",
  "إصدار رخصة هدم": "Demolition License Issuance",
  "إصدار رخصة ترميم": "Renovation License Issuance",
  "إصدار رخصة هدم حكومي": "Government Demolition License Issuance",
  "إصدار رخصة ترميم حكومي": "Government Renovation License Issuance",
  "إصدار رخصة بناء بالتزامن": "Concurrent Building License Issuance",
  "إصدار رخصة بناء استثماري": "Investment Building License Issuance",
  "إصدار رخصة بناء حكومي استثماري":
    "Government Investment Building License Issuance",
  "رخصة تجهيز الموقع": "Site Preparation License",
  "اشتراطات المباني السكنية": "Residential building requirements",
  "الفلل السكنية": "Residential villas",
  "المباني السكنية مفردة الوحدات (تاون هاوس)":
    "Single-unit residential buildings (townhouses)",
  "مجمع الفلل المغلق (كمباوند)": "Gated villa compound",
  "اشتراطات العمائر": "Mid-rise building requirements",
  "العمائر السكنية": "Residential apartment buildings",
  "العمائر المكتبية": "Office buildings",
  "العمائر التجارية": "Commercial buildings",
  "عمائر الشقق المخدومة": "Serviced apartment buildings",
  "اشتراطات المشاريع التجارية": "Commercial project requirements",
  "محطات الوقود فئة (ب)": "Category B fuel stations",
  "اكشاك طلبات السيارات": "Drive-thru kiosks",
  "اشتراطات المدارس": "Schools",
  "اشتراطات قاعات (قصور الأفراح)": "Wedding halls",
  "اشتراطات الاستراحات (الشاليهات)": "Chalets and rest houses",
  "اشتراطات معارض السيارات": "Car showrooms",
  "اشتراطات مراكز بيع مواد البناء": "Building material centers",
  "اشتراطات مراكز بيع أسطوانات الغاز": "Gas cylinder centers",
  "اشتراطات المستودعات": "Warehouses",
  "اشتراطات المخازن": "Storage facilities",
  "اشتراطات وحدات التخزين الذاتي": "Self-storage units",
  "اشتراطات الورش": "Workshops",
  "اشتراطات الأسواق المركزية (هيبر ماركت)": "Hypermarkets",
  "كود البناء السعودي": "Saudi Building Code",
  "الدليل الموحد لاشتراطات رخص البناء":
    "Unified guide for building license requirements",
  "التعاميم الوزارية": "Ministerial circulars",
  "لائحة أنظمة البناء في مدينة الرياض": "Riyadh building regulations",
  "الوثيقة الاسترشادية لإصدار الرخص الإنشائية":
    "Reference guide for construction permit issuance",
  "أكواد البناء الصادرة من الهيئة الملكية لمدينة الرياض":
    "Building codes issued by the Royal Commission for Riyadh City",
  "اللوائح الوزارية": "Ministerial regulations",
  التعاميم: "Circulars",
  "الأدلة الإرشادية للمواقف": "Parking guidance manuals",
  "بوابة أنظمة الأمانة – منصة التصاريح الموحدة (UPS)":
    "Municipality systems portal - Unified Permit System (UPS)",
  "بوابة أنظمة الأمانة": "Municipality systems portal",
  "بوابة الأمانة الإلكترونية": "Municipality e-portal",
  "صورة بطاقة الأحوال المدنية": "National ID copy",
  "صورة بطاقة الأحوال": "National ID copy",
  "صورة الصك": "Deed copy",
  "صك الملكية": "Ownership deed",
  "تقرير مساحي في القطاع مع منسوب": "Sector survey report with elevation level",
  "تقرير مساحي من مكتب معتمد": "Survey report from an accredited office",
  "التقرير المساحي من مكتب هندسي معتمد":
    "Survey report from an accredited engineering office",
  "صورة جزئية من المخطط التنظيمي": "Partial copy of the regulatory plan",
  اقرارات: "Declarations",
  "إيصال سداد الرسوم": "Fee payment receipt",
  "نموذج تدقيق نظام اشتراطات": "Requirements audit form",
  "شهادة الإشغال": "Occupancy certificate",
  "شهادة الاشغال": "Occupancy certificate",
  "صورة جزئية للموقع (كروكي)": "Partial site sketch",
  "إقرار المالك بتنفيذ لائحة الضوابط 9":
    "Owner declaration to comply with Regulation 9",
  "تعهد المكتب الهندسي المشرف": "Supervising engineering office undertaking",
  "صورة رخصة البناء": "Building license copy",
  "محضر تجزئة": "Subdivision minutes",
  "شهادة تحمل": "Structural capacity certificate",
  "صورة من الوكالة الشرعية": "Power of attorney copy",
  "صورة لواجهة المبنى": "Building facade image",
  "السجل التجاري": "Commercial registration",
  "تقرير فني": "Technical report",
  "مخططات الدفاع المدني": "Civil defense plans",
  "المخططات المعمارية": "Architectural plans",
  "مخطط معماري": "Architectural plan",
  "موافقة التربية والتعليم": "Ministry of Education approval",
  "تعهد المخلفات": "Waste undertaking",
  "تعهد إزالة المخلفات": "Waste removal undertaking",
  "عقد اشراف": "Supervision contract",
  "تقرير دراسة التربة": "Soil study report",
  "تقرير التربة": "Soil report",
  "الرفع المساحي من مكتب هندسي": "Engineering office survey",
  "خطاب توجيه": "Routing letter",
  "خطاب موافقة الزراعة": "Agriculture approval letter",
  "ملاحظات بلدية": "Municipal notes",
  "الموقع العام": "Site plan",
  "محضر لجنة فنية": "Technical committee minutes",
  "المخطط المقترح بعد التعديل": "Proposed plan after amendment",
  "تعهد تنفيذ العزل الحراري": "Thermal insulation undertaking",
  "مخطط الوضع القائم": "Existing condition plan",
  "صورة الرخصة القديمة": "Old license copy",
  "المخطط المعتمد": "Approved plan",
  "خطاب الدفاع المدني": "Civil defense letter",
  "وثيقة التأمين": "Insurance document",
  "عقد تفويض المالك للمقاول المنفذ للمشروع":
    "Owner authorization contract for the executing contractor",
  "المخطط الكهربائي": "Electrical plan",
  "مخطط كهرباء": "Electrical plan",
  "المخطط الإنشائي": "Structural plan",
  "مخطط انشائي": "Structural plan",
  "رخصة هدم": "Demolition license",
  "مخططات كفاءة الطاقة": "Energy efficiency plans",
  "مخطط كفاءة الطاقة": "Energy efficiency plan",
  "المخططات الميكانيكية": "Mechanical plans",
  "مخطط ميكانيكي": "Mechanical plan",
  "صورة من الطبيعة": "Site photograph",
  "عقد الإيجار": "Lease contract",
  "شهادة تسجيل وقف": "Endowment registration certificate",
  "تعهد إغلاق فتحات الخزان": "Undertaking to close tank openings",
  "نموذج الواجهات": "Facade form",
  "خطاب المناسب": "Utility suitability letter",
  "اشتراطات مكانية": "Spatial requirements",
  "نظام البناء": "Building regulations",
  "نظام البناء المعتمد من إدارة الرخص":
    "Approved building regulations from the licensing department",
  "تعهد التسوير": "Fencing undertaking",
  "مخطط الأمن والسلامة": "Safety and security plan",
  "شهادة اعتماد المكتب في بوابه سلامه للدفاع المدني":
    "Office accreditation certificate in the Salamah civil defense portal",
  "السجل العقاري": "Real estate registry",
  "مخطط السور الموقت": "Temporary fence plan",
  "مسودة رخصة بناء يتم اعدادها من قبل المكتب الهندسي":
    "Draft building license prepared by the engineering office",
  "النموذج الخاص بالترميم": "Renovation form",
  "فاتورة الحاوية": "Container invoice",
  "خطاب تصفية (كهرباء، مياه، هاتف)":
    "Clearance letter (electricity, water, phone)",
  "مخطط التسوير": "Fencing plan",
  "تعهد المكتب الهندسي بالالتزام بكود البناء السعودي":
    "Engineering office undertaking to comply with the Saudi Building Code",
  "خطاب المنسوب الأرضي يوضح فرق المنسوب إن وجد":
    "Ground level letter showing elevation difference if any",
  "الموافقات الخارجية حسب نوع المعاملة":
    "External approvals based on application type",
  "المكتب الهندسي": "Engineering office",
  الموزع: "Distributor",
  "مهندس مدقق": "Review engineer",
  المهندس: "Engineer",
  "المهندس المدقق": "Review engineer",
  المشرف: "Supervisor",
  "المشرف الفني": "Technical supervisor",
  "المراقب الفني": "Technical inspector",
  المستفيد: "Beneficiary",
  "فريق الأمانة": "Municipality team",
  "ممثل المكتب الهندسي": "Engineering office representative",
  "الجهة الحكومية / المكتب": "Government entity / office",
  "رفع الطلب وإرفاق المستندات":
    "Upload the application and attach the documents",
  "فرز المعاملة حسب نوع المشروع": "Sort the application by project type",
  "توزيع المعاملة على المهندسين": "Assign the application to engineers",
  "تدقيق ومراجعة الوثائق والاشتراطات": "Review documents and requirements",
  "إرجاع المعاملة للمكتب عند وجود ملاحظات":
    "Return the application to the office when notes exist",
  "إحالة المعاملة للمشرف للاعتماد":
    "Forward the application to the supervisor for approval",
  "مراجعة نهائية": "Final review",
  "اعتماد نهائي أو إعادة للمدقق": "Final approval or return to reviewer",
  "تحديث بيانات الرخصة وإرفاق المستندات":
    "Update license data and attach documents",
  "فرز وتوزيع المعاملة": "Sort and distribute the application",
  "تدقيق ومراجعة": "Review and audit",
  "إحالة للمشرف عند اكتمال الاشتراطات":
    "Forward to supervisor when requirements are complete",
  "مراجعة واعتماد نهائي أو إعادة": "Final review and approval or return",
  "رفع طلب تصحيح وضع المبنى": "Submit existing building correction request",
  "رفع طلب نقل الملكية": "Submit ownership transfer request",
  "التحقق من الوثائق النظامية": "Verify the regulatory documents",
  "اعتماد نهائي أو إعادة للمستفيد": "Final approval or return to beneficiary",
  "رفع الطلب واستكمال المستندات الأساسية":
    "Submit the application and complete the core documents",
  "تحويل المعاملة للمراقب الفني":
    "Forward the application to the technical inspector",
  "التدقيق والمراجعة": "Audit and review",
  "إعداد أرقام الخطابات للجهات الخدمية":
    "Prepare letter numbers for utility الجهات",
  "استكمال خطابات التصفية مع الجهات المعنية":
    "Complete clearance letters with the relevant entities",
  "رفع الطلب وإرفاق نموذج الترميم":
    "Submit the application and attach the renovation form",
  "اعتماد نهائي أو إعادة للمراقب": "Final approval or return to inspector",
  "رفع الطلب واستكمال خطابات التصفية":
    "Submit the application and complete the clearance letters",
  "تحويل ومتابعة": "Forward and follow up",
  "رفع الطلب بالتزامن مع التجهيزات المطلوبة":
    "Submit the application in parallel with the required preparations",
  "مراجعة متطلبات التزامن": "Review concurrency requirements",
  "اعتماد أو إعادة": "Approve or return",
  "رفع الطلب الاستثماري": "Submit the investment application",
  "مراجعة اشتراطات الاستثمار": "Review investment requirements",
  "رفع الطلب الاستثماري الحكومي":
    "Submit the government investment application",
  "مراجعة اشتراطات الاستثمار الحكومي":
    "Review government investment requirements",
  "الدخول لبوابة الأمانة عبر النفاذ الوطني":
    "Sign in to the municipality portal via national access",
  "تسجيل البيانات واختيار القطعة ورفع المستندات":
    "Enter data, select the plot, and upload the documents",
  "مراجعة المتطلبات الهندسية والموافقات الخارجية":
    "Review engineering requirements and external approvals",
  "حسب المكتب": "Depends on the office",
  "5 دقائق": "5 minutes",
  "10 دقائق": "10 minutes",
  "15 دقيقة": "15 minutes",
  "20 دقيقة": "20 minutes",
  "حسب المستفيد": "Depends on the beneficiary",
  "حسب الجهة": "Depends on the entity",
  ساعة: "1 hour",
  متغير: "Variable",
};

const orderedTerms = Object.entries(termTranslations).sort(
  (left, right) => right[0].length - left[0].length,
);

function replaceKnownTerms(value: string): string {
  let result = value;

  for (const [arabic, english] of orderedTerms) {
    result = result.split(arabic).join(english);
  }

  return result;
}

function translateDelimitedList(value: string): string {
  return value
    .split(/\s*،\s*/u)
    .map((item) => translateDisplayText(item, "en"))
    .join(", ");
}

function translatePattern(value: string): string | null {
  let match = value.match(/^يرجى تزويدنا بـ: (.+)\.$/u);
  if (match) {
    return `Please provide: ${translateDelimitedList(match[1])}.`;
  }

  match = value.match(/^الإجراء المقترح: (.+)\.$/u);
  if (match) {
    return `Suggested action: ${translateDisplayText(match[1], "en")}.`;
  }

  match = value.match(/^المرجع المستخدم في المراجعة: (.+)\.$/u);
  if (match) {
    return `Reference used in the review: ${translateDisplayText(match[1], "en")}.`;
  }

  match = value.match(/^تم ربط الملف مع (.+)\.$/u);
  if (match) {
    return `This file was matched with ${translateDisplayText(match[1], "en")}.`;
  }

  match = value.match(/^(.+) يحمل مؤشرات كافية داخل هذا الملف\.$/u);
  if (match) {
    return `${translateDisplayText(match[1], "en")} has sufficient indicators in this file.`;
  }

  match = value.match(
    /^(.+) موجود في هذا الملف لكنه ما زال يحتاج تدقيقاً بشرياً\.$/u,
  );
  if (match) {
    return `${translateDisplayText(match[1], "en")} is present in this file but still needs human review.`;
  }

  match = value.match(
    /^تم العثور على (.+) لكن الشواهد النصية داخله ما زالت غير كافية لتأكيد اكتمال عناصره الأساسية\.$/u,
  );
  if (match) {
    return `${translateDisplayText(match[1], "en")} was found, but the textual evidence is still not sufficient to confirm that its core elements are complete.`;
  }

  match = value.match(
    /^تم رصد مؤشرات كافية داخل (.+) تدعم أن الملف يحتوي على العناصر المتوقعة للمراجعة\.$/u,
  );
  if (match) {
    return `Sufficient indicators were found in ${translateDisplayText(match[1], "en")} to support that the file contains the expected review elements.`;
  }

  match = value.match(
    /^لم يتم العثور على (.+) ضمن الملفات المرفوعة أو لم يتم ربطه آلياً بهذه المعاملة\.$/u,
  );
  if (match) {
    return `${translateDisplayText(match[1], "en")} was not found in the uploaded files, or it was not automatically matched to this application.`;
  }

  match = value.match(/^تم العثور على مؤشرات مرتبطة بـ (.+)\.$/u);
  if (match) {
    return `Indicators related to ${translateDisplayText(match[1], "en")} were found.`;
  }

  match = value.match(/^ظهر في الملف ما يشير إلى (.+)\.$/u);
  if (match) {
    return `The file includes signals pointing to ${translateDisplayText(match[1], "en")}.`;
  }

  match = value.match(/^لم يظهر بوضوح ما يؤكد وجود (.+)\.$/u);
  if (match) {
    return `The file does not clearly confirm the presence of ${translateDisplayText(match[1], "en")}.`;
  }

  match = value.match(/^OCR احتياطي لملف (.+)$/u);
  if (match) {
    return `Fallback OCR for ${match[1]}`;
  }

  match = value.match(/^اكتمل OCR الاحتياطي: (.+)$/u);
  if (match) {
    return `Fallback OCR completed: ${match[1]}`;
  }

  match = value.match(/^يوجد (\d+) مرفقات ناقصة مقارنة بسياسة (.+)\.$/u);
  if (match) {
    return `There are ${match[1]} missing attachments compared with the ${translateDisplayText(match[2], "en")} policy.`;
  }

  match = value.match(
    /^التحقق التفصيلي من (.+) ما زال يحتاج مراجعة بشرية لأن مؤشرات الاكتمال داخل الملف غير كافية\.$/u,
  );
  if (match) {
    return `Detailed validation of ${translateDisplayText(match[1], "en")} still requires human review because the completion indicators in the file are insufficient.`;
  }

  match = value.match(/^(.+) غير متاح للتحقق التفصيلي ضمن الملفات الحالية\.$/u);
  if (match) {
    return `${translateDisplayText(match[1], "en")} is not available for detailed validation within the current files.`;
  }

  match = value.match(
    /^تمت مراجعة المعاملة وفق سياسة (.+)، والملف الحالي يظهر جاهزية مبدئية للإحالة إلى المشرف مع استمرار التحقق البلدي النهائي\.$/u,
  );
  if (match) {
    return `The application was reviewed under the ${translateDisplayText(match[1], "en")} policy, and the current file shows initial readiness for escalation to the supervisor while the final municipal review continues.`;
  }

  return null;
}

export function formatChecklistDocumentLabelLocalized(
  title: string,
  locale: Locale,
): string {
  if (locale === "ar") {
    const item = getChecklistDocumentItem(title);
    return item ? `${item.number} - ${item.title}` : title;
  }

  const item = getChecklistDocumentItem(title);
  if (!item) {
    return translateDisplayText(title, locale);
  }

  return `${item.number} - ${translateDisplayText(item.title, locale)}`;
}

export function translateDisplayText(value: string, locale: Locale): string {
  if (locale === "ar" || !value) {
    return value;
  }

  const normalizedValue = value.trim();
  const exactMatch = exactTextTranslations[normalizedValue];
  if (exactMatch) {
    return exactMatch;
  }

  const numberedMatch = normalizedValue.match(/^(\d+\s*-\s*)(.+)$/u);
  if (numberedMatch) {
    return `${numberedMatch[1]}${translateDisplayText(numberedMatch[2], locale)}`;
  }

  const patternMatch = translatePattern(normalizedValue);
  if (patternMatch) {
    return patternMatch;
  }

  return replaceKnownTerms(normalizedValue).replace(/،/gu, ",");
}
