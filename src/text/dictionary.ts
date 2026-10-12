/**
 * Optional dictionary check (subpath `@drmoyassine/liteparse/dictionary`, off by
 * default). Catches letter swaps the glyph-level quality check can't see, e.g.
 * "Accrtditation" — an unknown word that is ONE substitution/transposition away from
 * a known word. It only flags pages; it never rewrites text. With `escalate: true`
 * flagged native pages are re-read through the cascade.
 *
 * Built-in lists are compact (long English words + common Arabic words); pass your
 * own via `words` / `wordList` for domain vocabularies, and `ignore` for proper nouns
 * that sit one letter away from a dictionary word.
 */
import type { DictionaryCheck, DictionaryReport } from "../types.js";

const EN_WORDS = `
accreditation accredited accrediting accountability accounting accomplishment achievement achievements
activities activity additional address administration administrative admission admissions advanced
advantage advisory agreement allocation alternative analysis analytical announcement application
applications appointment appropriate approval approximately arrangement assessment assessments
assignment assistance assistant associate association attendance attention authority available
average background beginning behavioral benefits beneficiary bibliography biological business
calculation calendar candidate candidates capability capacity category certificate certification
chairman chairperson challenge challenges chapter character characteristics chemistry citizenship
classroom clinical collaboration colleague colleagues collection college combination commission
commitment committee communication communications community company comparison competence competency
competition complete completed completion compliance component components comprehensive computer
concentration concept conclusion condition conditions conference confidential confirmation connection
consideration consistent construction consultant consultation contact content context continuing
continuous contract contribution control coordination coordinator corporate correspondence council
counseling country courses coverage creative criteria criterion critical curriculum customer database
december decision definition degrees delivery department departments describe description design
development developmental different difficult direction director discipline discussion distribution
doctoral document documentation documents economic economics education educational effective
effectiveness efficiency electrical electronic element elements eligibility employee employees
employment engineering environment environmental equipment especially establish established
establishment evaluation evaluations evidence examination examinations example excellence executive
exercise expected expenditure experience experimental expertise explanation extension external
facilities facility faculty february feedback financial following foundation framework frequency
function functions fundamental general government graduate graduates graduation guidance guidelines
headquarters healthcare hospital however identification implementation importance improvement
improvements including independent indicator indicators individual industrial industry information
infrastructure initiative initiatives inspection institute institution institutional institutions
instruction instructional instructor integrated integration integrity intellectual interaction
internal international internship interpretation interview introduction investigation investment
involvement january knowledge laboratory language leadership learning lecture lecturer legislation
library license literature location maintenance management manager manufacturing marketing material
materials mathematics measurement measures mechanical mechanism medical medicine meeting membership
methodology methods minimum ministry monitoring national necessary network november objective
objectives observation occupational october official operation operational opportunities opportunity
organization organizational orientation outcome outcomes overview participant participants
participation particular partnership pathology percentage performance period permission personal
personnel pharmacy philosophy physical physician physics placement planning policies policy
population portfolio position possible postgraduate potential practical practice practices
preparation presentation president prevention primary principal principles priority procedure
procedures process processes production profession professional professor proficiency profile
program programme programmes programs progress project projects promotion proposal protection
provided provider psychology publication publications purpose qualification qualifications quality
quarterly question questionnaire questions recognition recommendation recommendations recruitment
reference regarding regional registration registrar regulation regulations relationship relevant
reliability report reporting representative requirement requirements research researcher resource
resources response responsibilities responsibility responsible results retention review revision
safety satisfaction schedule scholarship science sciences scientific secretary section security
selection semester september service services session significant situation specialist
specialization specialized specific specification standard standards statement statistical
statistics strategic strategies strategy strength strengths structure student students studies
subject submission submitted successful summary supervision supervisor support surgery survey
sustainability sustainable syllabus system systems teaching technical technique techniques technology
telephone therapeutic therapy throughout together training transfer transition treatment
undergraduate understanding university validation validity various verification within workshop
workshops yourself
`;

const AR_WORDS = `
الاعتماد الأكاديمي الجامعة الجامعات الكلية الكليات الطلاب الطالب الطالبة الطالبات التعليم التعليمية
البرنامج البرامج المقرر المقررات الدراسية الدراسات الدراسي الجودة التقييم التقويم المعايير المعيار
الأداء التدريس هيئة أعضاء عضو التدريب البحث العلمي العلمية الإدارة الإدارية المؤسسة المؤسسات
التعلم مخرجات المخرجات المناهج المنهج الخطة الاستراتيجية التطوير التحسين المستمر الوزارة وزارة
التقرير التقارير السنوي السنوية الفصل الدراسي الأول الثاني الثالث الرابع الامتحانات الامتحان
الاختبار الاختبارات الدرجة الدرجات الشهادة الشهادات البكالوريوس الماجستير الدكتوراه القسم الأقسام
المسؤولية المسؤوليات المتطلبات المتطلب الموارد المكتبة المختبر المختبرات الخدمات المجتمع المجتمعية
الشراكة الشراكات المراجعة المراجع الداخلية الخارجية اللجنة اللجان الاجتماع الاجتماعات المجلس
الرئيس العميد الوكيل المدير الإجراءات السياسات السياسة اللوائح اللائحة التنظيمية المعلومات
المعرفة المهارات المهارة الكفاءة الكفاءات الصحة الطبية الطب الصيدلة الهندسة العلوم الإنسانية
الاقتصاد المالية الميزانية التمويل الإحصاء الإحصائية النتائج النتيجة الأهداف الهدف الرسالة الرؤية
القيم المبادئ التوصيات التوصية الملاحظات الإنجازات التحديات الفرص نقاط القوة الضعف المؤشرات المؤشر
الاستبيان الاستبانة المشاركة المشاركين الأنشطة النشاط البيانات قاعدة الوثائق الوثيقة المستندات
بالإضافة وبالتالي حيث والتي الذي التي الذين على إلى من في عن مع هذا هذه ذلك تلك كما أيضا خلال
`;

function normalizeArabic(w: string): string {
  return w
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "") // tashkeel + tatweel
    .replace(/[إأآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}

function normalize(w: string): string {
  return /[\u0600-\u06FF]/.test(w) ? normalizeArabic(w) : w.toLowerCase();
}

const EN_SUFFIXES = ["ies", "es", "s", "ed", "ing", "ly", "al"];

/**
 * Parse a word-list file: one word per line (or whitespace/comma separated),
 * `#` comments ignored. Lets an AMS feed its own vocabulary (institution names,
 * programme titles, Arabic terms) straight from a text file.
 */
export function parseWordList(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .flatMap((l) => l.split(/[\s,;]+/))
    .filter(Boolean);
}

export interface DictionaryOptions {
  /** Extra / replacement vocabulary. */
  words?: Iterable<string>;
  /** Word-list file contents (see {@link parseWordList}) — merged with `words`. */
  wordList?: string;
  /** Words never flagged, even when one letter away from a known word (e.g. "Qassim" vs "Qassam"). */
  ignore?: Iterable<string>;
  /** Built-in lists to include. Default both. Pass [] to use only `words`. */
  builtIn?: Array<"en" | "ar">;
  /** Minimum word length checked (shorter words have too many near-neighbours). Default 7. */
  minWordLength?: number;
  /** Suspect words needed to flag a page. Default 1. */
  minSuspects?: number;
  /** Flag only when suspects / checked words ≥ this share (0 = ignore). Default 0. */
  minSuspectRatio?: number;
  /** Re-read flagged pages through the cascade. Default false (flag only). */
  escalate?: boolean;
}

/** Build a dictionary check (substitution/transposition distance 1 against a word list). */
export function createDictionaryCheck(opts: DictionaryOptions = {}): DictionaryCheck {
  const builtIn = opts.builtIn ?? ["en", "ar"];
  const minLen = opts.minWordLength ?? 7;
  const minSuspects = opts.minSuspects ?? 1;
  const minRatio = opts.minSuspectRatio ?? 0;
  const known = new Set<string>();
  const add = (w: string) => w && known.add(normalize(w));
  if (builtIn.includes("en")) EN_WORDS.split(/\s+/).forEach(add);
  if (builtIn.includes("ar")) AR_WORDS.split(/\s+/).forEach(add);
  for (const w of opts.words ?? []) add(w);
  if (opts.wordList) parseWordList(opts.wordList).forEach(add);
  const ignore = new Set<string>();
  for (const w of opts.ignore ?? []) if (w) ignore.add(normalize(w));

  // Same-length neighbourhood keys → the known word they came from: position i wildcarded
  // (substitution) and adjacent-swap forms (transposition).
  const subKeys = new Map<string, string>();
  const swaps = new Map<string, string>();
  for (const w of known) {
    for (let i = 0; i < w.length; i++) {
      const k = `${w.slice(0, i)}\u0000${w.slice(i + 1)}`;
      if (!subKeys.has(k)) subKeys.set(k, w);
    }
    for (let i = 0; i + 1 < w.length; i++) {
      const k = w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);
      if (!swaps.has(k)) swaps.set(k, w);
    }
  }

  const isKnown = (w: string): boolean => {
    if (known.has(w) || ignore.has(w)) return true;
    for (const suf of EN_SUFFIXES) {
      if (w.endsWith(suf) && (known.has(w.slice(0, -suf.length)) || ignore.has(w.slice(0, -suf.length)))) return true;
      if (suf === "ies" && w.endsWith(suf) && known.has(w.slice(0, -3) + "y")) return true;
    }
    return false;
  };

  const nearest = (w: string): string | undefined => {
    const swap = swaps.get(w);
    if (swap) return swap;
    for (let i = 0; i < w.length; i++) {
      const hit = subKeys.get(`${w.slice(0, i)}\u0000${w.slice(i + 1)}`);
      if (hit) return hit;
    }
    return undefined;
  };

  return {
    escalate: opts.escalate ?? false,
    check(text: string): DictionaryReport {
      const suspects: string[] = [];
      const suggestions: Record<string, string> = {};
      let words = 0;
      for (const raw of text.match(/[\p{L}\p{M}]+/gu) ?? []) {
        if (raw.length < minLen) continue;
        if (/^\p{Lu}+$/u.test(raw)) continue; // acronyms
        const w = normalize(raw);
        words++;
        if (isKnown(w)) continue;
        const near = nearest(w);
        if (near) {
          suspects.push(raw);
          suggestions[raw] = near;
        }
      }
      const ratio = words ? suspects.length / words : 0;
      return { words, suspects, suggestions, ratio, flagged: suspects.length >= minSuspects && ratio >= minRatio };
    },
  };
}
