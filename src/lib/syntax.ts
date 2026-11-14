// Lightweight, line-based highlighting. Keep the existing languages' token rules.
const legacyPattern =
  /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`|\/\/.*|\b(?:const|let|return|export|function|import|from|true|false|null|new|if|type|interface|async|await)\b)/g;
const cKeywords = `auto break case char const continue default do double else enum extern float for goto if
  inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while
  _Alignas _Alignof _Atomic _Bool _Complex _Generic _Imaginary _Noreturn _Static_assert _Thread_local`;
const keywords = {
  kotlin: `as break class continue do else false for fun if in interface is null object package return super this throw true try
    typealias typeof val var when while by catch constructor delegate dynamic field file finally get import init param property
    receiver set setparam where actual abstract annotation companion const crossinline data enum expect external final infix inline
    inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg`,
  java: `abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally
    float for goto if implements import instanceof int interface long native new package private protected public return short static
    strictfp super switch synchronized this throw throws transient try void volatile while true false null var record sealed permits yield`,
  csharp: `abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum
    event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new
    null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static
    string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while add alias and
    ascending async await by descending dynamic equals file from get global group init into join let managed nameof not notnull on or
    orderby partial record remove required scoped select set unmanaged value var when where with yield`,
  c: cKeywords,
  cpp: `${cKeywords} alignas alignof and and_eq asm bitand bitor bool catch char8_t char16_t char32_t class compl concept consteval
    constexpr constinit const_cast co_await co_return co_yield decltype delete dynamic_cast explicit export false friend import module
    mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public reinterpret_cast requires static_assert
    static_cast template this thread_local throw true try typeid typename using virtual wchar_t xor xor_eq`,
};

const patterns = Object.fromEntries(
  Object.entries(keywords).map(([language, words]) => [
    language,
    // Recognize strings before comments, including C# verbatim/interpolated strings.
    new RegExp(
      String.raw`((?:\$@|@\$|@)"(?:[^"]|"")*"|\$?"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|` +
        String.raw`\x60[^\x60]*\x60|\/\/.*|\/\*.*?(?:\*\/|$)|\b(?:${words.trim().split(/\s+/).join("|")})\b)`,
      "g",
    ),
  ]),
) as Record<keyof typeof keywords, RegExp>;

const extensions: Record<string, RegExp> = {
  ts: legacyPattern,
  tsx: legacyPattern,
  js: legacyPattern,
  jsx: legacyPattern,
  json: legacyPattern,
  css: legacyPattern,
  rs: legacyPattern,
  kt: patterns.kotlin,
  kts: patterns.kotlin,
  java: patterns.java,
  cs: patterns.csharp,
  csx: patterns.csharp,
  c: patterns.c,
  h: patterns.cpp,
  cc: patterns.cpp,
  cpp: patterns.cpp,
  cxx: patterns.cpp,
  "c++": patterns.cpp,
  hh: patterns.cpp,
  hpp: patterns.cpp,
  hxx: patterns.cpp,
  "h++": patterns.cpp,
  ipp: patterns.cpp,
  tpp: patterns.cpp,
  inl: patterns.cpp,
};

export function syntaxPatternForFile(path: string): RegExp | undefined {
  // Git quotes paths containing special characters; the extension is still usable.
  const extension = path.replace(/"$/, "").match(/\.([^./\\]+)$/)?.[1];
  if (extension === "C") return patterns.cpp;
  const key = extension?.toLowerCase();
  return key && Object.hasOwn(extensions, key) ? extensions[key] : undefined;
}
