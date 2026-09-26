// Required literals of a JS regex (#80): strings such that every text the regex matches contains at least one of
// them. rg -F can then find a superset of the candidate lines without knowing JS's dialect: translating the regex
// itself would lose matches (\b, \W, \s, m with CRLF, [a&&b] and more mean something else to Rust, #70).
// The scan only needs to be conservative: whatever it does not understand ends the current run of characters.
const MIN = 3; // a shorter literal lets through so many lines that the prefilter only adds a process
const SYNTAX = '\\^$.|?*+()[]{}/'; // characters an identity escape stands for (\. is ".")
const OPAQUE = '^$.|?*+()[]{}'; // unescaped, these are never a plain character

// -> string[] | null. null: no set is known, every line is a candidate.
export function requiredLiterals(re) {
  const src = re.source, icase = re.flags.includes('i');
  if (re.flags.includes('v')) return null; // nested classes and set operations: not scanned
  const alts = [];
  let runs = [], run = '';
  const end = () => { runs.push(run); run = ''; };
  const skipTo = (i, close) => { const k = src.indexOf(close, i); return k < 0 ? src.length : k + 1; };
  const skipClass = i => { // i is just past [; JS ends a class at the first unescaped ]
    while (i < src.length && src[i] !== ']') i += src[i] === '\\' ? 2 : 1;
    return i + 1;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '|') { end(); alts.push(runs); runs = []; i++; continue; }
    let ch = null; // the one character this atom always matches, or null
    if (c === '\\') {
      const d = src[i + 1];
      i += 2;
      if (SYNTAX.includes(d)) ch = d;
      // Any other escape is opaque. Swallow what may belong to it, so its digits or name are not read as text.
      else if (d === 'x') for (let k = 0; k < 2 && /[0-9a-f]/i.test(src[i] ?? ''); k++) i++;
      else if (d === 'u') i = src[i] === '{' ? skipTo(i, '}') : Math.min(i + 4, src.length);
      else if (d === 'c') i++;
      else if ((d === 'k' && src[i] === '<') || ((d === 'p' || d === 'P') && src[i] === '{')) i = skipTo(i, d === 'k' ? '>' : '}');
      else if (/\d/.test(d)) while (/\d/.test(src[i] ?? '')) i++;
    } else if (c === '[') i = skipClass(i + 1);
    else if (c === '(') { // a group is opaque: find its ), past escapes and classes
      let depth = 1;
      i++;
      while (i < src.length && depth) {
        if (src[i] === '\\') i += 2;
        else if (src[i] === '[') i = skipClass(i + 1);
        else { depth += src[i] === '(' ? 1 : src[i] === ')' ? -1 : 0; i++; }
      }
    } else {
      i++;
      const code = c.charCodeAt(0);
      // Not a plain character: syntax, control characters (a line has no \n), U+FFFD (what invalid bytes decode
      // to), surrogates (a legacy quantifier binds half of one), and non-ASCII under i (JS and rg fold it differently).
      if (!OPAQUE.includes(c) && code >= 0x20 && code !== 0x7f && c !== '\ufffd' && !(code >= 0xd800 && code <= 0xdfff) && !(icase && code > 0x7f)) ch = c;
    }
    // A quantifier: ? * {0,…} make the atom optional; + {n,…} keep it once, then the run ends. A lazy ? after it is
    // read next as an opaque character, which ends the run again: nothing to do.
    const q = /^(?:[?*+]|\{(\d+)(?:,\d*)?\})/.exec(src.slice(i)); // the whole rest: a {n,m} can be any length
    if (q) {
      i += q[0].length;
      if (ch !== null && (q[0] === '+' || +q[1] >= 1)) run += ch;
      end();
    } else if (ch !== null) run += ch;
    else end();
  }
  end();
  alts.push(runs);
  const best = alts.map(rs => rs.reduce((a, b) => (b.length > a.length ? b : a), ''));
  return best.every(s => s.length >= MIN) ? [...new Set(best)] : null;
}

// expr: semgrep's OR list of AND terms, each literal { kind: 'r', re, not } or a meaning. -> { literals, icase } | null.
// A term holds only where one of its non-negated regexes does, so that regex's literals cover the term; of several,
// the one whose shortest literal is longest. A term without one could hold anywhere, and so could the expression.
export function prefilterLiterals(expr) {
  const literals = new Set();
  let icase = false;
  for (const term of expr) {
    let pick = null;
    for (const lit of term) {
      if (lit.kind !== 'r' || lit.not) continue;
      const ls = requiredLiterals(lit.re);
      const worst = ls && Math.min(...ls.map(s => s.length));
      if (ls && (!pick || worst > pick.worst)) pick = { ls, worst, icase: lit.re.flags.includes('i') };
    }
    if (!pick) return null;
    pick.ls.forEach(s => literals.add(s));
    icase ||= pick.icase; // rg -i for all of them: a superset still
  }
  return { literals: [...literals], icase };
}
