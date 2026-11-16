// swiftmark-r4: a fast, dependency-free Markdown renderer that returns
// byte-for-byte the HTML marked 18.1.3 produces with its default options
// (GFM on). Single-pass block parser + direct-to-HTML inline renderer.
//
// Written fresh for the make.fun markdown-render-speed-02 bounty.
// Behaviour follows the CommonMark 0.31.2 spec + GFM 0.29 extensions as
// marked implements them, including marked's edge-case quirks.

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_ALL_TEST = /[&<>"']/;
const ESCAPE_ALL_REPLACE = /[&<>"']/g;
const ESCAPE_NO_ENCODE_TEST = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_NO_ENCODE_REPLACE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NUMERIC_REF_TEST = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const MULTI_SPACE = /\s+/g;
const BLANK_LINE = /^[ \t]*$/;

// Escape HTML special chars. When encodeAll is false, leave valid character
// references (&copy; &#65; &#x41;) untouched.
function esc(s, encodeAll) {
  if (encodeAll) {
    if (ESCAPE_ALL_TEST.test(s)) return s.replace(ESCAPE_ALL_REPLACE, (c) => ESCAPE_MAP[c]);
  } else if (ESCAPE_NO_ENCODE_TEST.test(s)) {
    return s.replace(ESCAPE_NO_ENCODE_REPLACE, (c) => ESCAPE_MAP[c]);
  }
  return s;
}

// Decode numeric character references; a stray & becomes &amp;. Named
// references pass through untouched (the renderer leaves them as-is).
function unesc(s) {
  if (!NUMERIC_REF_TEST.test(s)) return s;
  return s.replace(NUMERIC_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

// Clean a link/image URL the way marked does: encodeURI, keeping % intact.
function cleanUrl(s) {
  try {
    return encodeURI(s).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Split a table row on unescaped pipes, trimming cells and unescaping \|.
function splitCells(row, count) {
  const t = row.replace(/\|/g, (m, off, str) => {
    let escaped = false;
    let p = off;
    while (--p >= 0 && str[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(/ \|/);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1]?.trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Remove trailing copies of ch from s.
function rtrimChar(s, ch) {
  let n = s.length;
  while (n > 0 && s.charAt(n - 1) === ch) n--;
  return s.slice(0, n);
}

// Drop trailing blank lines, keeping at most one trailing newline's worth.
function trimBlankTail(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && BLANK_LINE.test(lines[t])) t--;
  if (lines.length - t <= 2) return s;
  return lines.slice(0, t + 1).join('\n');
}

// Normalize a link reference label: trim, collapse whitespace, fold case.
function normLabel(s) {
  return s.trim().replace(MULTI_SPACE, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Check parenthesis balance in a URL: -1 balanced, -2 too many opens,
// otherwise the index of the first unmatched close paren.
function parenBalance(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, tab stops every 4 columns from startCol.
function expandTabs(s, startCol = 0) {
  let col = startCol;
  let out = '';
  for (const ch of s) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// ---- Regex composition helper -------------------------------------------
// Lets big grammar rules be built from named pieces, like a small template
// engine. Inserted patterns lose their ^ anchors (they stop being
// start-of-string once embedded in a lookahead or group).
const CARET = /(^|[^\[])\^/g;
function rx(src, flags = '') {
  let s = typeof src === 'string' ? src : src.source;
  const api = {
    rep(find, replacement) {
      let r = typeof replacement === 'string' ? replacement : replacement.source;
      r = r.replace(CARET, '$1');
      s = s.replace(find, r);
      return api;
    },
    get() { return new RegExp(s, flags); },
  };
  return api;
}

// HTML block tags (CommonMark condition 6) + the script/pre/style family.
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// ---- Block rules (GFM) ---------------------------------------------------
const R_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const R_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const R_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const R_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const R_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const R_TEXT = /^[^\n]+/;
const R_BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const R_LIST = rx(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).rep(/bull/g, R_BULLET).get();
const R_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// Small shared patterns used inside the composed rules.
const P_HEADING_LINE = ' {0,3}#{1,6}(?:\\s|$)';
const P_FENCES_LINE = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const P_HTML_START = ' {0,3}(?:</?(?:TAG)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';

// Indent-sensitive helpers for list continuation lines. The indent argument
// is clamped to 0..3 after subtracting 1, matching marked's behaviour.
// The continuation regexes are memoized per clamped indent (marked does the
// same); rebuilding them per item was a measurable cost.
function clampIndent(n) { return Math.max(0, Math.min(3, n - 1)); }
function listItemRe(bullet) {
  return new RegExp(`^( {0,3}${bullet})((?:[\t ][^\n]*)?(?:\n|$))`);
}
const _listContCache = [];
function listContRes(indent) {
  const n = clampIndent(indent);
  let c = _listContCache[n];
  if (!c) {
    c = {
      bullet: new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`),
      hr: new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`),
      fences: new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`),
      heading: new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`),
      html: new RegExp(`^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'),
      blockquote: new RegExp(`^ {0,${n}}>`),
    };
    _listContCache[n] = c;
  }
  return c;
}

// Misc block-level helpers.
const CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const INDENT_CODE_COMPENSATION = /^(\s+)(?:```)/;
const BEGINNING_SPACE = /^\s+/;
const ENDING_HASH = /#$/;
const ENDING_SPACE_TAB = /[ \t]$/;
const NON_SPACE = /[^ ]/;
const LEADING_SPACE_TAB = /^[ \t]+/;
const DOUBLE_BLANK_LINE = /\n[ \t]*\n[ \t]*$/;
const BLOCKQUOTE_START = /^ {0,3}>/;
const BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BQ_STRIP_MARKER = /^ {0,3}>[ \t]?/gm;
const BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const LIST_NESTING = /^ {1,4}(?=( {4})*[^ ])/g;
const LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const LIST_TASK_STRIP = /^\[[ xX]\][ \t]+/;
const LIST_TASK_BOX = /\[[ xX]\]/;
const ANY_LINE = /\n.*\n/;
const HREF_BRACKETS = /^<(.*)>$/;
const TABLE_DELIM = /[:|]/;
const TABLE_ALIGN_CHARS = /^\||\| *$/g;
const TABLE_ROW_BLANK = /\n[ \t]*$/;
const TABLE_ALIGN_RIGHT = /^ *-+: *$/;
const TABLE_ALIGN_CENTER = /^ *:-+: *$/;
const TABLE_ALIGN_LEFT = /^ *:-+ *$/;
const SETEXT_LINE = /^ {0,3}(?:=+|-+) *$/;

// ---- Composed block rules -------------------------------------------------
const R_TABLE = rx('^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .rep('hr', R_HR)
  .rep('heading', P_HEADING_LINE)
  .rep('blockquote', ' {0,3}>')
  .rep('code', '(?: {4}| {0,3}\t)[^\\n]')
  .rep('fences', P_FENCES_LINE)
  .rep('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .rep('html', P_HTML_START)
  .rep('TAG', BLOCK_TAGS)
  .get();

const PARA_BASE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function buildParagraph(listPattern, tablePattern) {
  let b = rx(PARA_BASE)
    .rep('hr', R_HR)
    .rep('heading', P_HEADING_LINE)
    .rep('|lheading', '');
  if (tablePattern) b = b.rep('table', tablePattern);
  else b = b.rep('|table', '');
  return b
    .rep('blockquote', ' {0,3}>')
    .rep('fences', P_FENCES_LINE)
    .rep('list', listPattern)
    .rep('html', P_HTML_START)
    .rep('TAG', BLOCK_TAGS)
    .get();
}
// GFM paragraph: only a `1.`/`1)` ordered item (or any bullet) interrupts.
const R_PARAGRAPH = buildParagraph(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/, R_TABLE);
// Blockquote-internal paragraph: any list item interrupts.
const R_PARAGRAPH_ANY_LIST = buildParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/, null);

const R_LHEADING = rx(/^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/)
  .rep(/bull/g, R_BULLET)
  .rep(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .rep(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .rep(/blockquote/g, / {0,3}>/)
  .rep(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .rep(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .rep(/html/g, / {0,3}<[^\n>]+>\n/)
  .rep(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .get();

const R_BLOCKQUOTE = rx(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).rep('paragraph', R_PARAGRAPH_ANY_LIST).get();

const R_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const R_DEF = rx(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .rep('label', R_LABEL)
  .rep('title', /(?:\"(?:\\[\s\S]|[^\"\\])*\"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .get();

const R_HTML = rx('^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', 'i')
  .rep('comment', R_COMMENT)
  .rep('tag', BLOCK_TAGS)
  .rep('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .get();

// ---- Inline rules (GFM) --------------------------------------------------
// Unicode character classes for emphasis delimiter rules (CommonMark).
const CLS_PUNCT = /[\p{P}\p{S}]/u;
const CLS_PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const CLS_NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const CLS_PUNCT_NO_TILDE = /(?!~)[\p{P}\p{S}]/u;
const CLS_PUNCT_SPACE_NO_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const CLS_NOT_PUNCT_SPACE_OR_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;
const CLS_ALNUM = /[\p{L}\p{N}]/u;
const R_PUNCTUATION = rx(/^((?![*_])punctSpace)/, 'u').rep(/punctSpace/g, CLS_PUNCT_SPACE).get();

const I_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const I_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const I_BR = /^( {2,}|[\\])\n(?!\s*$)[ \t]*/;

// Emphasis left delimiter (GFM: ~ is not punctuation here).
const I_EM_LDELIM = rx(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u')
  .rep(/punct/g, CLS_PUNCT_NO_TILDE).get();

// Emphasis right-delimiter scanners. Alternatives: (1) skip __...__ / **...**
// decoys, (2) skip plain text, (3-6) delimiter runs in each flank context.
const EM_R_AST = '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
const I_EM_RDELIM_AST = rx(EM_R_AST, 'gu')
  .rep(/notPunctSpace/g, CLS_NOT_PUNCT_SPACE_OR_TILDE)
  .rep(/punctSpace/g, CLS_PUNCT_SPACE_NO_TILDE)
  .rep(/punct/g, CLS_PUNCT_NO_TILDE).get();
const EM_R_UND = '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
const I_EM_RDELIM_UND = rx(EM_R_UND, 'gu')
  .rep(/notPunctSpace/g, CLS_NOT_PUNCT_SPACE)
  .rep(/punctSpace/g, CLS_PUNCT_SPACE)
  .rep(/punct/g, CLS_PUNCT).get();

// Strikethrough delimiters.
const I_DEL_LDELIM = rx(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').rep(/punct/g, CLS_PUNCT).get();
const DEL_R = '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)';
const I_DEL_RDELIM = rx(DEL_R, 'gu')
  .rep(/notPunctSpace/g, CLS_NOT_PUNCT_SPACE)
  .rep(/punctSpace/g, CLS_PUNCT_SPACE)
  .rep(/punct/g, CLS_PUNCT).get();

// Backslash-escaped punctuation, and code spans (for masking).
const I_ANY_PUNCT = rx(/\\(punct)/, 'gu').rep(/punct/g, CLS_PUNCT).get();
const I_ANY_PUNCT_OUTSIDE_CODE = rx(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').rep(/punct/g, CLS_PUNCT).get();

// Autolinks <scheme:...> and <email>.
const R_EMAIL_IN_AUTOLINK = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
const I_AUTOLINK = rx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .rep('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .rep('email', R_EMAIL_IN_AUTOLINK).get();

// Inline HTML tags and comments (comment must close with -->).
const R_COMMENT_CLOSED = rx(R_COMMENT).rep('(?:-->|$)', '-->').get();
const I_TAG = rx('^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .rep('comment', R_COMMENT_CLOSED)
  .rep('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .get();

// Link label grammar (nested brackets, escapes, code spans).
const R_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const R_LINK_LABEL = rx(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).rep('brackets', R_BRACKETS).get();
const I_LINK = rx(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .rep('label', R_LINK_LABEL)
  .rep('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .rep('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/).get();
const I_REFLINK = rx(/^!?\[(label)\]\[(ref)\]/).rep('label', R_LINK_LABEL).rep('ref', R_LABEL).get();
const I_NOLINK = rx(/^!?\[(ref)\](?:\[\])?/).rep('ref', R_LABEL).get();

// Reference search (bounded, for emphasis masking).
const R_REF_BOUNDED = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const R_LABEL_BOUNDED = rx(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).rep('brackets', R_BRACKETS).get();
const I_REFLINK_SEARCH = rx('reflink|nolink(?!\\()', 'g')
  .rep('reflink', rx(/^!?\[(label)\]\[(ref)\]/).rep('label', R_LABEL_BOUNDED).rep('ref', R_REF_BOUNDED).get())
  .rep('nolink', rx(/^!?\[(ref)\](?:\[\])?/).rep('ref', R_REF_BOUNDED).get()).get();

// Link / code span / tag skipper (for emphasis masking).
const R_BLOCK_SKIP = rx(/link|precode-code|html/, 'g')
  .rep('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .rep('precode-', '(?<!`)()')
  .rep('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .rep('html', /<(?! )[^<>]*?>/).get();

// GFM autolinks: www., scheme://, bare email, mailto:/xmpp:.
const R_SCHEME_WORD = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const R_EMAIL_BARE = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const R_EMAIL_PROTOCOL = rx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).rep(/email/g, R_EMAIL_BARE).get();
const I_URL = rx(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .rep('emailProtocol', R_EMAIL_PROTOCOL)
  .rep('protocol', R_SCHEME_WORD)
  .rep('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/).get();
const I_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// Inline text: consumes up to the next construct, stopping before emails,
// urls, hard breaks and emphasis openers.
const I_TEXT = rx(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .rep('protocol', R_SCHEME_WORD)
  .rep(/emailProtocol/g, /(?:mailto|xmpp):/)
  .rep('wwwStart', '(?<![^\\s*_~(])www\\.').get();

// Tag-state tests for the inline <a>/<pre> tracking.
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_PRE_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
const START_ANGLE = /^</;
const END_ANGLE = />$/;
const OUTPUT_LINK_REPLACE = /\\([\[\]])/g;

// ---- Emphasis masking ----------------------------------------------------
// Before scanning for emphasis closers, marked masks links, code spans and
// tags (same length, so indices still line up) so a `*` inside them can
// never act as a delimiter.

// Does this text contain a link (inline or reference) anywhere?
function linkInText(st, src) {
  if (!src.includes('[')) return false;
  for (const m of src.matchAll(R_BLOCK_SKIP)) {
    if (I_LINK.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(I_REFLINK_SEARCH)) {
    const s = m[0];
    const r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(st.links, normLabel(s.slice(r + 1, -1)))) && !(r > 1 && linkInText(st, s.slice(1, r - 1)))) return true;
  }
  return false;
}

function maskSrc(st, src) {
  // Without [, `, < or \, every masking replacement is the identity.
  if (!src.includes('[') && !src.includes('`') && !src.includes('<') && !src.includes('\\')) return src;
  let t = src;
  if (src.includes('[')) {
    const maskRef = (m) => {
      const o = m.lastIndexOf('[');
      if (!Object.hasOwn(st.links, normLabel(m.slice(o + 1, -1)))) return m;
      if (o > 1 && m.charAt(0) !== '!') {
        const inner = m.slice(1, o - 1);
        if (linkInText(st, inner)) return '[' + inner.replace(I_REFLINK_SEARCH, maskRef) + '][' + 'a'.repeat(m.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(m.length - 2) + ']';
    };
    t = t.replace(I_REFLINK_SEARCH, maskRef);
  }
  t = t.replace(I_ANY_PUNCT_OUTSIDE_CODE, (m, ticks, punct) => {
    if (punct) return '+'.repeat(m.length);
    if (ticks) return ticks + m.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks;
    return m;
  });
  t = t.replace(R_BLOCK_SKIP, (m) => '[' + 'a'.repeat(m.length - 2) + ']');
  return t;
}

// Last index where each delimiter could close (a run preceded by a
// non-whitespace character), used to bound the closer search.
function scanClosers(s) {
  let lastStar = -1, lastUnd = -1, lastTilde = -1;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const ch = s[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : s[i - 1];
    let j = i + 1;
    while (j < n && s[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastTilde = i;
      else if (ch === '*') lastStar = i;
      else lastUnd = i;
    }
    i = j - 1;
  }
  return { lastStar, lastUnd, lastTilde };
}

// Does the link label contain a `<` starting a tag/autolink that runs past
// the label's end? Such a label can never be a link.
function hasUnclosedTagInLabel(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const cm = I_CODE.exec(label.slice(i));
      if (cm) { i += cm[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const rest = src.slice(offset + i);
    const tm = I_TAG.exec(rest) || I_AUTOLINK.exec(rest);
    if (tm) {
      if (tm[0].length > label.length - i) return true;
      i += tm[0].length - 1;
    }
  }
  return false;
}

// Render an <a> tag; a URL that will not encode renders as bare text.
function renderLink(href, title, inner, autolink) {
  const cleaned = cleanUrl(href);
  if (cleaned === null) return inner;
  let out = '<a href="' + esc(cleaned, autolink) + '"';
  if (title) out += ' title="' + esc(title) + '"';
  return out + '>' + inner + '</a>';
}

// Build a link/image from a matched link token: lex the label text (with
// links disabled inside), reject a link whose label itself holds a link.
function makeLinkToken(st, m, dest, raw, wantH, wantP) {
  const labelText = m[1].replace(OUTPUT_LINK_REPLACE, '$1');
  const isImage = m[0].charAt(0) === '!';
  const savedInLink = st.inLink;
  const savedEmitted = st.linkEmitted;
  const savedRaw = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const inner = isImage
    ? inlineRender(st, labelText, false, true)
    : inlineRender(st, labelText, wantH, wantP);
  const innerEmitted = st.linkEmitted;
  st.linkEmitted = savedEmitted;
  st.inLink = savedInLink;
  if (!isImage) {
    if (innerEmitted) { st.inRawBlock = savedRaw; return null; }
    st.linkEmitted = true;
    return { rawLen: raw.length, h: wantH ? renderLink(dest.href, dest.title, inner.h, false) : null, p: wantP ? inner.p : null };
  }
  const alt = inner.p;
  let h = null;
  if (wantH) {
    const cleaned = cleanUrl(dest.href);
    if (cleaned === null) h = esc(alt);
    else {
      h = '<img src="' + esc(cleaned) + '" alt="' + esc(alt) + '"';
      if (dest.title) h += ' title="' + esc(dest.title) + '"';
      h += '>';
    }
  }
  return { rawLen: raw.length, h, p: wantP ? alt : null };
}

// Inline link [label](href "title") or image ![label](href "title").
function tryLink(st, e, wantH, wantP) {
  if (st.linkParenPossible === false) return null;
  const m = I_LINK.exec(e);
  if (!m) return null;
  const labelStart = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasUnclosedTagInLabel(e, m[1], labelStart)) return null;
  let hrefPart = m[2];
  let titlePart = m[3];
  let raw = m[0];
  const hrefTrimmed = m[2].trim();
  if (START_ANGLE.test(hrefTrimmed)) {
    if (!END_ANGLE.test(hrefTrimmed)) return null;
    const stripped = rtrimChar(hrefTrimmed.slice(0, -1), '\\');
    if ((hrefTrimmed.length - stripped.length) % 2 === 0) return null;
  } else {
    const bal = parenBalance(m[2]);
    if (bal === -2) return null;
    if (bal > -1) {
      const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + bal;
      hrefPart = m[2].substring(0, bal);
      raw = m[0].substring(0, cut).trim();
      titlePart = '';
    }
  }
  const beforeClose = rtrimChar(raw.slice(0, -1), '\\');
  if ((raw.length - beforeClose.length) % 2 === 0) return null;
  let href = hrefPart.trim();
  if (START_ANGLE.test(href)) href = href.slice(1, -1);
  const title = titlePart ? titlePart.slice(1, -1) : '';
  return makeLinkToken(st, m, {
    href: href && href.replace(I_ANY_PUNCT, '$1'),
    title: title && title.replace(I_ANY_PUNCT, '$1'),
  }, raw, wantH, wantP);
}

// Reference link [label][ref] / [label][] / [label].
function tryReflink(st, e, wantH, wantP) {
  const m = I_REFLINK.exec(e) || I_NOLINK.exec(e);
  if (!m) return null;
  const labelStart = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasUnclosedTagInLabel(e, m[1], labelStart)) return null;
  const dest = st.links[normLabel(m[2] || m[1])];
  if (!dest) {
    const ch = m[0].charAt(0);
    return { rawLen: 1, h: wantH ? esc(ch) : null, p: wantP ? ch : null };
  }
  return makeLinkToken(st, m, dest, m[0], wantH, wantP);
}

// Emphasis / strong emphasis. Returns null when this run cannot open.
function tryEmStrong(st, e, masked, prevChar, lastStar, lastUnd, wantH, wantP) {
  const s = I_EM_LDELIM.exec(e);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const delim = s[0][0];
  const prevIsSame = prevChar === delim;
  const idx = masked.length - e.length;
  let runStart = idx;
  while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
  const before = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const beforeIsPunct = before === '*' || before === '_' || !!R_PUNCTUATION.exec(before);
  let n = prevChar;
  if (runStart < idx) n = before;
  const prevPunct = runStart < idx ? beforeIsPunct : !!R_PUNCTUATION.exec(n);
  if (s[4] && CLS_ALNUM.test(n)) return null;
  const afterPunct = s[1] || s[3] || '';
  if (!afterPunct || !n || prevPunct) {
    const k = [...s[0]].length - 1;
    let m = k;
    let f = 0;
    const y = idx - runStart + k;
    const R = !!before.trim() && (!!afterPunct || (delim === '*' && !beforeIsPunct));
    const re = delim === '*' ? I_EM_RDELIM_AST : I_EM_RDELIM_UND;
    const lastCloser = delim === '*' ? lastStar : lastUnd;
    const q = idx + k;
    if (lastCloser < q) return null;
    const tail = masked.slice(-e.length + k);
    const maxIdx = lastCloser - q;
    re.lastIndex = 0;
    let mm;
    while ((mm = re.exec(tail)) !== null && !(mm.index > maxIdx)) {
      const g = mm[1] || mm[2] || mm[3] || mm[4] || mm[5] || mm[6];
      if (!g) continue;
      let b = [...g].length;
      if (mm[3] || mm[4]) { m += b; continue; }
      if (mm[5] || mm[6] || R) {
        if (prevIsSame && (mm[5] || mm[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      b = Math.min(b, b + m + f);
      const firstLen = [...mm[0]][0].length;
      const raw = e.slice(0, k + mm.index + firstLen + b);
      if (Math.min(k, b) % 2) {
        const inner = inlineRender(st, raw.slice(1, -1), wantH, wantP);
        return { rawLen: raw.length, h: wantH ? '<em>' + inner.h + '</em>' : null, p: wantP ? inner.p : null };
      }
      const inner = inlineRender(st, raw.slice(2, -2), wantH, wantP);
      return { rawLen: raw.length, h: wantH ? '<strong>' + inner.h + '</strong>' : null, p: wantP ? inner.p : null };
    }
  }
  return null;
}

// Strikethrough ~~text~~ (single ~ also works).
function tryDel(st, e, masked, prevChar, lastTilde, wantH, wantP) {
  const s = I_DEL_LDELIM.exec(e);
  if (!s) return null;
  if (!s[1] || !prevChar || R_PUNCTUATION.exec(prevChar)) {
    const o = [...s[0]].length - 1;
    let p = o;
    const d = masked.length - e.length + o;
    if (lastTilde < d) return null;
    const tail = masked.slice(-e.length + o);
    const maxIdx = lastTilde - d;
    I_DEL_RDELIM.lastIndex = 0;
    let m;
    while ((m = I_DEL_RDELIM.exec(tail)) !== null && !(m.index > maxIdx)) {
      const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!g) continue;
      let l = [...g].length;
      if (l !== o) continue;
      if (m[3] || m[4]) { p += l; continue; }
      p -= l;
      if (p > 0) continue;
      l = Math.min(l, l + p);
      const firstLen = [...m[0]][0].length;
      const raw = e.slice(0, o + m.index + firstLen + l);
      const inner = inlineRender(st, raw.slice(o, -o), wantH, wantP);
      return { rawLen: raw.length, h: wantH ? '<del>' + inner.h + '</del>' : null, p: wantP ? inner.p : null };
    }
  }
  return null;
}

// GFM autolink: www., scheme://, bare email, mailto:/xmpp:.
function tryUrl(e) {
  const m = I_URL.exec(e);
  if (!m) return null;
  let text;
  let href;
  let rawLen;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
    rawLen = m[0].length;
  } else {
    let raw = m[0];
    let prev;
    do {
      prev = raw;
      raw = I_BACKPEDAL.exec(raw)?.[0] ?? '';
    } while (prev !== raw);
    text = raw;
    href = m[1] === 'www.' ? 'http://' + raw : raw;
    rawLen = raw.length;
  }
  return { rawLen, h: renderLink(href, null, esc(text, true), true), p: text };
}

// Render inline Markdown to HTML (h) and/or plain text (p), per flags.
// Plain text is the image-alt rendering: no tags, no escaping.
function inlineRender(st, src, wantH, wantP) {
  const saved = st.linkParenPossible;
  st.linkParenPossible = saved && src.includes(')');
  try {
    let masked = src;
    let lastStar = -1, lastUnd = -1, lastTilde = -1;
    if (src.includes('*') || src.includes('_') || src.includes('~')) {
      masked = maskSrc(st, src);
      ({ lastStar, lastUnd, lastTilde } = scanClosers(masked));
    }
    return inlineLoop(st, src, masked, lastStar, lastUnd, lastTilde, wantH, wantP);
  } finally {
    st.linkParenPossible = saved;
  }
}

const NON_SPACE_CHAR = /[^ ]/;
const NEWLINE_GLOBAL = /\n/g;

function inlineLoop(st, src, masked, lastStar, lastUnd, lastTilde, wantH, wantP) {
  let outH = '';
  let outP = '';
  let e = src;
  let prevChar = '';
  let prevWasText = false;
  let minLen = Infinity;
  while (e) {
    if (e.length < minLen) minLen = e.length;
    else throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
    if (!prevWasText) prevChar = '';
    prevWasText = false;
    let m;
    let r;
    if ((m = I_ESCAPE.exec(e))) {
      e = e.substring(m[0].length);
      if (wantH) outH += esc(m[1]);
      if (wantP) outP += m[1];
      continue;
    }
    if ((m = I_TAG.exec(e))) {
      if (!st.inLink && START_A_TAG.test(m[0])) st.inLink = true;
      else if (st.inLink && END_A_TAG.test(m[0])) st.inLink = false;
      if (!st.inRawBlock && START_PRE_TAG.test(m[0])) st.inRawBlock = true;
      else if (st.inRawBlock && END_PRE_TAG.test(m[0])) st.inRawBlock = false;
      e = e.substring(m[0].length);
      if (wantH) outH += m[0];
      if (wantP) outP += m[0];
      continue;
    }
    if ((r = tryLink(st, e, wantH, wantP))) {
      e = e.substring(r.rawLen);
      if (wantH) outH += r.h;
      if (wantP) outP += r.p;
      continue;
    }
    if ((r = tryReflink(st, e, wantH, wantP))) {
      e = e.substring(r.rawLen);
      if (wantH) outH += r.h;
      if (wantP) outP += r.p;
      continue;
    }
    if ((r = tryEmStrong(st, e, masked, prevChar, lastStar, lastUnd, wantH, wantP))) {
      e = e.substring(r.rawLen);
      if (wantH) outH += r.h;
      if (wantP) outP += r.p;
      continue;
    }
    if ((m = I_CODE.exec(e))) {
      let text = m[2].replace(NEWLINE_GLOBAL, ' ');
      if (NON_SPACE_CHAR.test(text) && text.charAt(0) === ' ' && text.charAt(text.length - 1) === ' ') text = text.substring(1, text.length - 1);
      e = e.substring(m[0].length);
      if (wantH) outH += '<code>' + esc(text, true) + '</code>';
      if (wantP) outP += text;
      continue;
    }
    if ((m = I_BR.exec(e))) {
      e = e.substring(m[0].length);
      if (wantH) outH += '<br>';
      continue;
    }
    if ((r = tryDel(st, e, masked, prevChar, lastTilde, wantH, wantP))) {
      e = e.substring(r.rawLen);
      if (wantH) outH += r.h;
      if (wantP) outP += r.p;
      continue;
    }
    if ((m = I_AUTOLINK.exec(e))) {
      let text;
      let href;
      if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
      else { text = m[1]; href = text; }
      e = e.substring(m[0].length);
      if (wantH) outH += renderLink(href, null, esc(text, true), true);
      if (wantP) outP += text;
      continue;
    }
    if (!st.inLink && (r = tryUrl(e))) {
      e = e.substring(r.rawLen);
      if (wantH) outH += r.h;
      if (wantP) outP += r.p;
      continue;
    }
    if ((m = I_TEXT.exec(e))) {
      const raw = m[0];
      e = e.substring(raw.length);
      if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
      prevWasText = true;
      if (st.inRawBlock) {
        if (wantH) outH += raw;
        if (wantP) outP += raw;
      } else {
        const text = unesc(raw);
        if (wantH) outH += esc(text);
        if (wantP) outP += text;
      }
      continue;
    }
    if (e) throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
  }
  return { h: wantH ? outH : null, p: wantP ? outP : null };
}

// ---- Block parsing -------------------------------------------------------
// Blocks are small records; inline sources are queued and rendered after
// the whole document is block-parsed (link definitions apply document-wide,
// and the <a>/<pre> state carries across entries in queue order).

function queueInline(st, rec, src) {
  const entry = { src, rec };
  st.iq.push(entry);
  return entry;
}

// Fenced code: when the opener is indented, dedent the body by that much.
function fenceText(raw, content) {
  const m = INDENT_CODE_COMPENSATION.exec(raw);
  if (m === null) return content;
  const indent = m[1];
  return content.split('\n').map((line) => {
    const ws = BEGINNING_SPACE.exec(line);
    if (ws === null) return line;
    return line.slice(Math.min(ws[0].length, indent.length));
  }).join('\n');
}

function tryDef(m) {
  if (!START_ANGLE.test(m[2]) && parenBalance(m[2]) !== -1) return null;
  return {
    tag: normLabel(m[1]),
    href: m[2] ? m[2].replace(HREF_BRACKETS, '$1').replace(I_ANY_PUNCT, '$1') : '',
    title: m[3] ? m[3].substring(1, m[3].length - 1).replace(I_ANY_PUNCT, '$1') : m[3],
  };
}

function tryTable(st, src) {
  const m = R_TABLE.exec(src);
  if (!m || !TABLE_DELIM.test(m[2])) return null;
  const headerCells = splitCells(m[1]);
  const alignsRaw = m[2].replace(TABLE_ALIGN_CHARS, '').split('|');
  if (headerCells.length !== alignsRaw.length) return null;
  const align = alignsRaw.map((a) => {
    if (TABLE_ALIGN_RIGHT.test(a)) return 'right';
    if (TABLE_ALIGN_CENTER.test(a)) return 'center';
    if (TABLE_ALIGN_LEFT.test(a)) return 'left';
    return null;
  });
  const header = headerCells.map((text, i) => {
    const cell = { text, align: align[i], header: true };
    cell.iq = queueInline(st, cell, text);
    return cell;
  });
  const rows = [];
  if (m[3]?.trim()) {
    const lines = m[3].replace(TABLE_ROW_BLANK, '').split('\n');
    for (const line of lines) {
      rows.push(splitCells(line, header.length).map((text, i) => {
        const cell = { text, align: align[i], header: false };
        cell.iq = queueInline(st, cell, text);
        return cell;
      }));
    }
  }
  const raw = rtrimChar(m[0], '\n');
  return { rawLen: raw.length, rec: { k: 'table', header, rows } };
}

// Cheap gates: the lheading/table regexes scan far ahead and usually fail,
// so only run them when a setext underline / table delimiter line exists.
// The setext scan is bounded to the current paragraph (it cannot cross a
// blank line) and done by hand instead of a regex over a slice.
function setextGate(src) {
  let i = src.indexOf('\n');
  while (i !== -1) {
    let j = i + 1;
    let sp = 0;
    while (sp < 3 && src.charCodeAt(j) === 32) { j++; sp++; }
    const c = src.charCodeAt(j);
    if (c === 61 || c === 45) return true;
    let k = j;
    while (k < src.length) {
      const cc = src.charCodeAt(k);
      if (cc === 32 || cc === 9) { k++; continue; }
      break;
    }
    if (k >= src.length || src.charCodeAt(k) === 10) return false;
    i = src.indexOf('\n', k);
  }
  return false;
}
// Does s end with a blank line (/\n[ \t]*\n[ \t]*$/), without a regex?
function endsWithDoubleBlank(s) {
  let i = s.length;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  if (i === 0 || s[i - 1] !== '\n') return false;
  i--;
  while (i > 0 && (s[i - 1] === ' ' || s[i - 1] === '\t')) i--;
  return i > 0 && s[i - 1] === '\n';
}
function tableGate(src) {
  const nl1 = src.indexOf('\n');
  if (nl1 === -1) return false;
  const nl2 = src.indexOf('\n', nl1 + 1);
  const line2 = nl2 === -1 ? src.slice(nl1 + 1) : src.slice(nl1 + 1, nl2);
  return line2.includes('-') && (line2.includes('|') || line2.includes(':'));
}

function blockParse(st, src, blocks, inQuote) {
  let mergePara = inQuote;
  let minLen = Infinity;
  while (src) {
    if (src.length < minLen) minLen = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    let m;
    if ((m = R_NEWLINE.exec(src))) {
      src = src.substring(m[0].length);
      const prev = blocks[blocks.length - 1];
      if (!(m[0].length === 1 && prev !== undefined)) blocks.push({ k: 'space', raw: m[0] });
      continue;
    }
    if ((m = R_CODE.exec(src))) {
      const raw = trimBlankTail(m[0]);
      const text = raw.replace(CODE_REMOVE_INDENT, '');
      src = src.substring(raw.length);
      const prev = blocks[blocks.length - 1];
      if (prev && (prev.k === 'para' || prev.k === 'text')) {
        prev.isrc += '\n' + text;
        prev.iq.src = prev.isrc;
      } else blocks.push({ k: 'code', lang: null, text });
      continue;
    }
    if ((m = R_FENCES.exec(src))) {
      const text = fenceText(m[0], m[3] || '');
      src = src.substring(m[0].length);
      blocks.push({ k: 'code', lang: m[2] ? m[2].trim().replace(I_ANY_PUNCT, '$1') : m[2], text });
      continue;
    }
    if ((m = R_HEADING.exec(src))) {
      let text = m[2].trim();
      if (ENDING_HASH.test(text)) {
        const stripped = rtrimChar(text, '#');
        if (!stripped || ENDING_SPACE_TAB.test(stripped)) text = stripped.trim();
      }
      const raw = rtrimChar(m[0], '\n');
      src = src.substring(raw.length);
      const rec = { k: 'heading', depth: m[1].length, isrc: text };
      rec.iq = queueInline(st, rec, text);
      blocks.push(rec);
      continue;
    }
    if ((m = R_HR.exec(src))) {
      const raw = rtrimChar(m[0], '\n');
      src = src.substring(raw.length);
      blocks.push({ k: 'hr' });
      continue;
    }
    const bq = tryBlockquote(st, src);
    if (bq) { src = src.substring(bq.rawLen); blocks.push(bq.rec); continue; }
    const li = tryList(st, src);
    if (li) { src = src.substring(li.rawLen); blocks.push(li.rec); continue; }
    if ((m = R_HTML.exec(src))) {
      const raw = trimBlankTail(m[0]);
      src = src.substring(raw.length);
      blocks.push({ k: 'html', text: raw });
      continue;
    }
    if ((m = R_DEF.exec(src))) {
      const def = tryDef(m);
      if (def) {
        const raw = rtrimChar(m[0], '\n');
        src = src.substring(raw.length);
        const prev = blocks[blocks.length - 1];
        if (prev && (prev.k === 'para' || prev.k === 'text')) {
          prev.isrc += '\n' + raw;
          prev.iq.src = prev.isrc;
        } else {
          if (!st.links[def.tag]) st.links[def.tag] = { href: def.href, title: def.title };
          blocks.push({ k: 'def' });
        }
        continue;
      }
    }
    const tb = tableGate(src) ? tryTable(st, src) : null;
    if (tb) { src = src.substring(tb.rawLen); blocks.push(tb.rec); continue; }
    if (setextGate(src) && (m = R_LHEADING.exec(src))) {
      const text = m[1].trim();
      const raw = rtrimChar(m[0], '\n');
      src = src.substring(raw.length);
      const rec = { k: 'heading', depth: m[2].charAt(0) === '=' ? 1 : 2, isrc: text };
      rec.iq = queueInline(st, rec, text);
      blocks.push(rec);
      continue;
    }
    if (st.top && (m = R_PARAGRAPH.exec(src))) {
      let text = m[1];
      if (text.charAt(text.length - 1) === '\n') text = text.slice(0, -1);
      src = src.substring(m[0].length);
      const prev = blocks[blocks.length - 1];
      if (mergePara && prev && prev.k === 'para') {
        prev.isrc += '\n' + text;
        prev.iq.src = prev.isrc;
      } else {
        const rec = { k: 'para', isrc: text };
        rec.iq = queueInline(st, rec, text);
        blocks.push(rec);
      }
      mergePara = false;
      continue;
    }
    if ((m = R_TEXT.exec(src))) {
      const text = m[0];
      src = src.substring(text.length);
      const prev = blocks[blocks.length - 1];
      if (prev && prev.k === 'text') {
        prev.isrc += '\n' + text;
        prev.iq.src = prev.isrc;
      } else {
        const rec = { k: 'text', isrc: text };
        rec.iq = queueInline(st, rec, text);
        blocks.push(rec);
      }
      continue;
    }
    if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
  }
  st.top = true;
  return blocks;
}

// Blockquote: group lines, strip markers, re-lex each group; a trailing
// list or nested quote may absorb the lazy lines that follow it.
function tryBlockquote(st, src) {
  const m = R_BLOCKQUOTE.exec(src);
  if (!m) return null;
  let lines = rtrimChar(m[0], '\n').split('\n');
  let raw = '';
  const blocks = [];
  while (lines.length > 0) {
    let hasMarker = false;
    const group = [];
    let p = 0;
    for (; p < lines.length; p++) {
      if (BLOCKQUOTE_START.test(lines[p])) { group.push(lines[p]); hasMarker = true; }
      else if (!hasMarker) group.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const h = group.join('\n');
    const u = h
      .replace(BQ_MARKER_WS, (g, b, ws) => b + expandTabs(ws, b.length))
      .replace(BQ_SETEXT, '\n    $1')
      .replace(BQ_STRIP_MARKER, '');
    raw = raw ? raw + '\n' + h : h;
    const savedTop = st.top;
    st.top = true;
    blockParse(st, u, blocks, true);
    st.top = savedTop;
    if (lines.length === 0) break;
    const k = blocks[blocks.length - 1];
    if (k && (k.k === 'code' || k.k === 'heading' || k.k === 'hr' || k.k === 'html' || k.k === 'table')) break;
    if (k && k.k === 'blockquote') {
      const b = lines.join('\n');
      const m2 = k.raw + '\n' + b.replace(BQ_STRIP_MARKER, '');
      const f = tryBlockquote(st, m2);
      blocks[blocks.length - 1] = f.rec;
      const y = m2.substring(f.rawLen).replace(/^\n/, '');
      const r = y ? y.split('\n').length : 0;
      const consumed = r ? lines.slice(0, -r) : lines;
      if (consumed.length > 0) raw += '\n' + consumed.join('\n');
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && BLOCKQUOTE_START.test(lines[0])) continue;
      break;
    } else if (k && k.k === 'list') {
      const b = k.raw + '\n' + lines.join('\n');
      const nl = tryList(st, b);
      blocks[blocks.length - 1] = nl.rec;
      const f = nl.rawLen > k.raw.length ? b.slice(k.raw.length + 1, nl.rawLen).split('\n').length : 0;
      if (f > 0) raw += '\n' + lines.slice(0, f).join('\n');
      lines = lines.slice(f);
      continue;
    }
  }
  return { rawLen: raw.length, rec: { k: 'blockquote', blocks, raw } };
}

// List: gather items (first line + indented/lazy continuation lines), then
// lex each item's blocks, then handle task checkboxes and looseness.
const TAB_TO_SPACES = /\t/g;
const LEADING_3_SPACES = /^ {0,3}/;

// Fast helpers for the list loop (hot path).
function firstLine(s) {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}
function firstNonSpace(s) {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) !== 32) return i;
  return -1;
}
const BLANK_WS = /^\s*$/;
function isBlankWs(s) { return s.length === 0 || BLANK_WS.test(s); }
// Expand leading tabs (spaces are unchanged); no-op if no leading tab.
function expandLeadingTabs(s, startCol) {
  const c0 = s.charCodeAt(0);
  if (c0 !== 32 && c0 !== 9) return s;
  let k = 0, hasTab = false;
  while (k < s.length) {
    const c = s.charCodeAt(k);
    if (c === 32) k++;
    else if (c === 9) { hasTab = true; k++; }
    else break;
  }
  return hasTab ? s.replace(LEADING_SPACE_TAB, (ws) => expandTabs(ws, startCol)) : s;
}
// Column of the first non-space/tab char, counting each tab as 4 columns
// (as if tabs were replaced by four spaces); -1 if none.
function tab4NonSpace(s) {
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col += 4;
    else return col;
  }
  return -1;
}
// Can any list-interrupt regex match this raw line? The interrupt patterns
// allow at most n leading spaces before a marker char.
function canInterrupt(f, n) {
  let i = 0;
  while (i < f.length && f.charCodeAt(i) === 32) {
    i++;
    if (i > n) return false;
  }
  if (i >= f.length) return false;
  const c = f.charCodeAt(i);
  return c === 42 || c === 43 || c === 45 || c === 95 || c === 96 || c === 126 ||
    c === 35 || c === 60 || c === 62 || (c >= 48 && c <= 57);
}
const _itemReCache = new Map();
function listItemReCached(bullet) {
  let r = _itemReCache.get(bullet);
  if (!r) { r = listItemRe(bullet); _itemReCache.set(bullet, r); }
  return r;
}

function tryList(st, src) {
  const m = R_LIST.exec(src);
  if (!m) return null;
  const orig = src;
  let e = src;
  const consumed = () => orig.length - e.length;
  const bullet = m[1].trim();
  const ordered = bullet.length > 1;
  const rec = { k: 'list', ordered, start: ordered ? +bullet.slice(0, -1) : '', loose: false, items: [] };
  const bulletPat = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
  const itemRe = listItemReCached(bulletPat);
  let prevBlank = false;
  while (e) {
    let skippedBlank = false;
    let d = '';
    const t = itemRe.exec(e);
    if (!t || R_HR.test(e)) break;
    const itemStart = consumed();
    e = e.substring(t[0].length);
    const g = t[2].endsWith('\n') ? t[2].slice(0, -1) : t[2];
    const b = t[1].length;
    let line = expandLeadingTabs(g, b);
    let f = firstLine(e);
    let y = isBlankWs(line);
    let R = 0;
    if (y) R = b + 1;
    else {
      R = firstNonSpace(line);
      R = R > 4 ? 1 : R;
      d = line.slice(R);
      R += b;
    }
    if (y && BLANK_LINE.test(f)) {
      e = e.substring(f.length + 1);
      skippedBlank = true;
    }
    if (!skippedBlank) {
      const cr = listContRes(R);
      const n = clampIndent(R);
      const v = cr.bullet;
      const Q = cr.hr;
      const ee = cr.fences;
      const te = cr.heading;
      const M = cr.html;
      const ne = cr.blockquote;
      while (e) {
        const U = firstLine(e);
        f = U;
        const Z = expandLeadingTabs(U);
        if (canInterrupt(f, n) && (ee.test(f) || te.test(f) || M.test(f) || ne.test(f) || v.test(f) || Q.test(f))) break;
        if (firstNonSpace(Z) >= R || isBlankWs(f)) {
          d += '\n' + Z.slice(R);
        } else {
          if (y || tab4NonSpace(line) >= 4 || ee.test(line) || te.test(line) || M.test(line) || Q.test(line)) break;
          const qe = SETEXT_LINE.test(f) && R_LHEADING.test(line + '\n' + f)
            ? '    ' + Z.replace(LEADING_3_SPACES, '')
            : f;
          d += '\n' + qe;
        }
        y = isBlankWs(f);
        e = e.substring(U.length + 1);
        line = Z.slice(R);
      }
    }
    const itemRaw = orig.slice(itemStart, consumed());
    if (!rec.loose) {
      if (prevBlank) rec.loose = true;
      else if (endsWithDoubleBlank(itemRaw)) prevBlank = true;
    }
    rec.items.push({ raw: itemRaw, task: LIST_IS_TASK.test(d), text: d, blocks: null });
  }
  const last = rec.items[rec.items.length - 1];
  if (!last) return null;
  last.raw = last.raw.trimEnd();
  last.text = last.text.trimEnd();
  rec.raw = orig.slice(0, consumed()).trimEnd();
  for (const item of rec.items) {
    st.top = false;
    const ib = [];
    blockParse(st, item.text, ib, false);
    item.blocks = ib;
    if (!rec.loose) {
      const spaces = ib.filter((x) => x.k === 'space');
      if (spaces.length > 0 && spaces.some((x) => ANY_LINE.test(x.raw))) rec.loose = true;
    }
  }
  for (const item of rec.items) {
    const first = item.blocks[0];
    if (item.task && first && (first.k === 'text' || first.k === 'para')) {
      item.text = item.text.replace(LIST_TASK_STRIP, '');
      first.isrc = first.isrc.replace(LIST_TASK_STRIP, '');
      for (let g = st.iq.length - 1; g >= 0; g--) {
        if (LIST_IS_TASK.test(st.iq[g].src)) {
          st.iq[g].src = st.iq[g].src.replace(LIST_TASK_STRIP, '');
          break;
        }
      }
      const cb = LIST_TASK_BOX.exec(item.raw);
      if (cb) {
        const checked = cb[0] !== '[ ]';
        item.checkboxHtml = '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        item.checkboxMode = rec.loose ? 'first' : 'tight';
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (rec.loose) {
    for (const item of rec.items) {
      for (const blk of item.blocks) if (blk.k === 'text') blk.k = 'para';
    }
  }
  return { rawLen: rec.raw.length, rec };
}

// ---- Rendering -----------------------------------------------------------
const NOT_SPACE_START = /^\S*/;
const ENDING_NEWLINE = /\n$/;
const CARRIAGE_RETURN = /\r\n|\r/g;

function renderCodeBlock(b) {
  const lang = (b.lang || '').match(NOT_SPACE_START)?.[0] || '';
  const body = b.text ? b.text.replace(ENDING_NEWLINE, '') + '\n' : '';
  const inner = esc(body, true);
  if (lang) return '<pre><code class="language-' + esc(lang) + '">' + inner + '</code></pre>\n';
  return '<pre><code>' + inner + '</code></pre>\n';
}

function renderTableCell(c) {
  const tag = c.header ? 'th' : 'td';
  return (c.align ? `<${tag} align="${c.align}">` : `<${tag}>`) + c.ih + `</${tag}>\n`;
}

function renderTable(b) {
  let head = '';
  for (const c of b.header) head += renderTableCell(c);
  let out = '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n';
  if (b.rows.length > 0) {
    let body = '';
    for (const row of b.rows) {
      let cells = '';
      for (const c of row) cells += renderTableCell(c);
      body += '<tr>\n' + cells + '</tr>\n';
    }
    out += '<tbody>' + body + '</tbody>';
  }
  return out + '</table>\n';
}

function renderListItem(item) {
  let inner = '';
  if (item.checkboxMode === 'tight') inner += item.checkboxHtml;
  const blocks = item.blocks;
  for (let i = 0; i < blocks.length; i++) {
    if (i === 0 && item.checkboxMode === 'first') {
      const b = blocks[0];
      if (b.k === 'para') inner += '<p>' + item.checkboxHtml + b.ih + '</p>\n';
      else inner += item.checkboxHtml + renderBlock(b);
    } else {
      inner += renderBlock(blocks[i]);
    }
  }
  return '<li>' + inner + '</li>\n';
}

function renderBlock(b) {
  switch (b.k) {
    case 'space': case 'def': return '';
    case 'code': return renderCodeBlock(b);
    case 'heading': return `<h${b.depth}>${b.ih}</h${b.depth}>\n`;
    case 'hr': return '<hr>\n';
    case 'blockquote': return '<blockquote>\n' + renderBlocks(b.blocks) + '</blockquote>\n';
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const start = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
      let items = '';
      for (const item of b.items) items += renderListItem(item);
      return '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
    }
    case 'html': return b.text;
    case 'table': return renderTable(b);
    case 'para': return '<p>' + b.ih + '</p>\n';
    case 'text': return b.ih;
    default: return '';
  }
}

function renderBlocks(blocks) {
  let out = '';
  for (const b of blocks) out += renderBlock(b);
  return out;
}

// The HTML marked 18.1.3 renders for `markdown`, with marked's defaults.
export function parse(markdown) {
  const st = {
    links: Object.create(null),
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
    iq: [],
  };
  const src = markdown.replace(CARRIAGE_RETURN, '\n');
  const blocks = [];
  blockParse(st, src, blocks, false);
  for (const entry of st.iq) {
    st.inRawBlock = false;
    entry.rec.ih = inlineRender(st, entry.src, true, false).h;
  }
  return renderBlocks(blocks);
}
