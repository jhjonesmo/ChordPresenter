// ── Keys, capo, and transposition ────────────────────────────────────────────
// Mirrors the Python engine in scripts/md_to_pro.py (_detect_key,
// _detect_chart_key, shift_key, _key_idx, transpose_chord) so the key the UI
// shows, the chart it previews/prints, and the .pro it exports always agree.

const CHORD_TOKEN = /^[A-G][#b]?(m(?!aj|in)|maj|min|dim|aug|°|ø)?(7|9|11|13|6|5|4|2)?(sus[24]?|add[29]?)?(\/?[A-G][#b]?)?$/;

// Same grammar as md_to_pro.py's _CHORD_TOKEN_RE, split into root / quality / bass.
const CHORD_PARTS = /^([A-G][#b]?)((?:m|maj|min|M|dim|aug|°|ø)?(?:maj|min)?(?:7|9|11|13|6|5|4|2)?(?:sus[24]?|add[29]?|omit[35]?)?)(?:\/([A-G][#b]?))?$/;

// Non-chord tokens allowed on a chord line: bars, dashes, repeat marks.
const CHORD_LINE_FILLER = /^(\|+|-+|\/|%|\.+|x\d+|\d+x|\(x?\d+x?\)|N\.?C\.?)$/i;

const ENH: Record<string, string> = {
  'C#':'Db','Db':'C#','D#':'Eb','Eb':'D#',
  'F#':'Gb','Gb':'F#','G#':'Ab','Ab':'G#','A#':'Bb','Bb':'A#',
};

const SHARPS = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const FLATS  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
const NOTE_IDX: Record<string, number> = {
  C:0,'B#':0,'C#':1,Db:1,D:2,'D#':3,Eb:3,E:4,Fb:4,'E#':5,F:5,'F#':6,Gb:6,
  G:7,'G#':8,Ab:8,A:9,'A#':10,Bb:10,B:11,Cb:11,
};

// Conventional spelling per pitch class — used whenever a key is computed
// (B with capo 4 → G shapes) rather than picked by the user.
const MAJOR_SPELLING = ['C','Db','D','Eb','E','F','F#','G','Ab','A','Bb','B'];
const MINOR_SPELLING = ['Cm','C#m','Dm','Ebm','Em','Fm','F#m','Gm','G#m','Am','Bbm','Bm'];

// Keys that conventionally use flat spellings (matches _FLAT_KEYS in Python).
const FLAT_KEYS = new Set(['F','Bb','Eb','Ab','Db','Gb','Dm','Gm','Cm','Fm','Bbm','Ebm']);

export const MAJOR_KEYS = ['C','C#','Db','D','Eb','E','F','F#','Gb','G','Ab','A','Bb','B'];
export const MINOR_KEYS = ['Cm','C#m','Dm','D#m','Ebm','Em','Fm','F#m','Gm','G#m','Am','A#m','Bbm','Bm'];
const KEY_OPTIONS = new Set([...MAJOR_KEYS, ...MINOR_KEYS]);

const KEY_RE = /^([A-G][#b]?)(m(?!aj))?/;

export function isMinorKey(key: string): boolean {
  const m = key.trim().match(KEY_RE);
  return Boolean(m && m[2]);
}

function noteIdx(note: string): number {
  const m = note.trim().match(/^[A-G][#b]?/);
  const idx = m ? NOTE_IDX[m[0]] : undefined;
  if (idx === undefined) throw new Error(`Unknown note: ${note}`);
  return idx;
}

/** Map any key label onto one of the dropdown's options ("A#" → "Bb",
 *  "Gbm" → "F#m"), so a site's spelling never leaves the picker blank. */
export function canonicalKey(key: string): string {
  const k = key.trim();
  if (!k) return "";
  if (KEY_OPTIONS.has(k)) return k;
  try {
    const idx = noteIdx(k);
    return isMinorKey(k) ? MINOR_SPELLING[idx] : MAJOR_SPELLING[idx];
  } catch {
    return "";
  }
}

/** Pitch index of the key's RELATIVE MAJOR, so C and Am compare equal and
 *  picking Am for a song detected in C is a 0-semitone move. */
export function keyIdx(key: string): number {
  const idx = noteIdx(key);
  return isMinorKey(key) ? (idx + 3) % 12 : idx;
}

/** Move a key by N semitones, keeping its mode (G +4 → B, Em +4 → G#m). */
export function shiftKey(key: string, semitones: number): string {
  const idx = (((noteIdx(key) + semitones) % 12) + 12) % 12;
  return isMinorKey(key) ? MINOR_SPELLING[idx] : MAJOR_SPELLING[idx];
}

export function semitonesBetween(fromKey: string, toKey: string): number {
  return (((keyIdx(toKey) - keyIdx(fromKey)) % 12) + 12) % 12;
}

export function prefersFlats(key: string): boolean {
  return FLAT_KEYS.has(key);
}

export function transposeChord(chord: string, semitones: number, preferFlat: boolean): string {
  if (!semitones) return chord;
  const m = chord.match(CHORD_PARTS);
  if (!m) return chord;
  const names = preferFlat ? FLATS : SHARPS;
  const move = (n: string) => names[(noteIdx(n) + semitones) % 12];
  const [, root, quality, bass] = m;
  return move(root) + quality + (bass ? "/" + move(bass) : "");
}

/** Strip wrapping punctuation a chord can carry on a chord line: "(G)", "G*". */
function splitToken(tok: string): [string, string, string] {
  const m = tok.match(/^(\(?)(.*?)(\)?\*?)$/);
  return m ? [m[1], m[2], m[3]] : ["", tok, ""];
}

export function isChordLine(line: string): boolean {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  let chords = 0;
  for (const tok of tokens) {
    const [, core] = splitToken(tok);
    if (CHORD_PARTS.test(core)) { chords++; continue; }
    if (CHORD_LINE_FILLER.test(tok)) continue;
    return false;
  }
  return chords > 0;
}

/** Transpose every chord line in a chart, keeping each chord at its original
 *  column (so it stays over the same syllable) unless a longer name to its
 *  left pushes it right. Lyric and header lines are untouched. */
export function transposeChart(chart: string, semitones: number, preferFlat: boolean): string {
  if (!semitones) return chart;
  return chart.split("\n").map(line => {
    if (!isChordLine(line)) return line;
    let out = "";
    for (const m of line.matchAll(/\S+/g)) {
      const [pre, core, post] = splitToken(m[0]);
      const tok = CHORD_PARTS.test(core)
        ? pre + transposeChord(core, semitones, preferFlat) + post
        : m[0];
      const col = out.length === 0 ? m.index! : Math.max(m.index!, out.length + 1);
      out = out.padEnd(col) + tok;
    }
    return out;
  }).join("\n");
}

// ── Capo ─────────────────────────────────────────────────────────────────────

// "Capo: 4th fret", "Capo 4", "# Capo 4", "Capo on fret 2", "Key: BCapo: 4th fret".
const CAPO_RE = /capo\b\s*:?\s*(?:on\s+)?(?:fret\s*)?(\d{1,2})/i;

export function detectCapo(text: string): number {
  const m = text.match(CAPO_RE);
  const n = m ? parseInt(m[1], 10) : 0;
  return n > 0 && n < 12 ? n : 0;
}

/** Drop standalone "Capo 4" / "# Capo: 4th fret" note lines from a chart —
 *  once the chart is converted to concert pitch they're wrong, and md_to_pro
 *  would otherwise turn one inside a section into a lyric slide. */
export function stripCapoLines(chart: string): string {
  return chart
    .split("\n")
    .filter(l => !/^\s*#?\s*capo\b.{0,30}$/i.test(l))
    .join("\n");
}

// ── Key detection ────────────────────────────────────────────────────────────

// Full 24-key diatonic chord sets using normalised chord names.
// Minor keys include both natural v and harmonic V (worship songs use either).
// Diminished (vii°) omitted — rare in contemporary worship charts.
const DIATONIC_CHORDS: Record<string, Set<string>> = {
  // Major keys
  C:   new Set(['C','Dm','Em','F','G','Am']),
  G:   new Set(['G','Am','Bm','C','D','Em']),
  D:   new Set(['D','Em','F#m','G','A','Bm']),
  A:   new Set(['A','Bm','C#m','D','E','F#m']),
  E:   new Set(['E','F#m','G#m','A','B','C#m']),
  B:   new Set(['B','C#m','D#m','E','F#','G#m']),
  'F#':new Set(['F#','G#m','A#m','B','C#','D#m']),
  F:   new Set(['F','Gm','Am','Bb','C','Dm']),
  Bb:  new Set(['Bb','Cm','Dm','Eb','F','Gm']),
  Eb:  new Set(['Eb','Fm','Gm','Ab','Bb','Cm']),
  Ab:  new Set(['Ab','Bbm','Cm','Db','Eb','Fm']),
  Db:  new Set(['Db','Ebm','Fm','Gb','Ab','Bbm']),
  // Minor keys
  Am:  new Set(['Am','C','Dm','Em','E','F','G']),
  Em:  new Set(['Em','G','Am','Bm','B','C','D']),
  Bm:  new Set(['Bm','D','Em','F#m','F#','G','A']),
  'F#m':new Set(['F#m','A','Bm','C#m','C#','D','E']),
  'C#m':new Set(['C#m','E','F#m','G#m','G#','A','B']),
  'G#m':new Set(['G#m','B','C#m','D#m','D#','E','F#']),
  Dm:  new Set(['Dm','F','Gm','Am','A','Bb','C']),
  Gm:  new Set(['Gm','Bb','Cm','Dm','D','Eb','F']),
  Cm:  new Set(['Cm','Eb','Fm','Gm','G','Ab','Bb']),
  Fm:  new Set(['Fm','Ab','Bbm','Cm','C','Db','Eb']),
  Bbm: new Set(['Bbm','Db','Ebm','Fm','F','Gb','Ab']),
};

/** Reduce chord to root + 'm' if minor, else just root.
 *  Strips slash bass, extensions, and quality suffixes. */
function normChord(chord: string): string {
  const noSlash = chord.split('/')[0];
  const m = noSlash.match(/^([A-G][#b]?)(.*)/);
  if (!m) return '';
  const [, root, quality] = m;
  const isMinor = /^m(?!aj)/.test(quality);
  return root + (isMinor ? 'm' : '');
}

function chordVariants(norm: string): string[] {
  const isMinor = norm.endsWith('m');
  const root = isMinor ? norm.slice(0, -1) : norm;
  const suffix = isMinor ? 'm' : '';
  const twin = ENH[root];
  return twin ? [norm, twin + suffix] : [norm];
}

function keyFromChords(normChords: string[]): string {
  if (!normChords.length) return "";
  // Deduplicate preserving first-seen order
  const unique = [...new Map(normChords.map(c => [c, c])).values()];
  const first = unique[0];
  let bestKey = "C", bestScore = -1;
  for (const [key, diatonic] of Object.entries(DIATONIC_CHORDS)) {
    const score = unique.filter(c => chordVariants(c).some(v => diatonic.has(v))).length;
    if (score < bestScore) continue;
    if (score > bestScore) { bestScore = score; bestKey = key; continue; }
    // Tied — prefer key where first chord = tonic
    const newTonic = chordVariants(first).some(v => v === key);
    const curTonic = chordVariants(first).some(v => v === bestKey);
    if (newTonic && !curTonic) bestKey = key;
  }
  return bestKey;
}

/** Key the chord shapes in a chart body are written in ("" if no chords). */
function keyFromBody(body: string): string {
  const normChords: string[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Drop slash bass notes first so "B/D#" scores only as B.
    const tokens = trimmed.replace(/\/[A-G][#b]?/g, "").replace(/[|\-.]/g, " ").split(/\s+/).filter(Boolean);
    if (tokens.length > 0 && tokens.every(t => CHORD_TOKEN.test(t))) {
      tokens.forEach(t => { const n = normChord(t); if (n) normChords.push(n); });
    }
  }
  return keyFromChords(normChords);
}

// "Key: Am", "Key: BCapo: 4th fret" — keep a minor 'm' but not 'maj'.
const KEY_LINE_RE = /Key:\s*([A-G][#b]?)(m(?!aj))?/;

export interface KeyInfo {
  /** Key the chart's chord shapes are written in. */
  chartKey: string;
  /** Key the song actually sounds in (chartKey + capo). */
  concertKey: string;
  /** Capo the source chart was written for (0 = none). */
  capo: number;
}

/**
 * Work out the chart's written key, concert key, and capo.
 *
 * Sites (UG, and Obsidian clips of UG) label the CONCERT key: "Key: B, capo 4"
 * with G chord shapes. So when there's a capo, the shapes are key − capo —
 * unless the chords themselves already look like the labelled key, in which
 * case the site labelled the shapes and the concert key is key + capo.
 *
 * @param content  whole .md file or chart text (Key:/Capo: lines are read from it)
 * @param body     just the chord chart (for chord-based detection)
 */
export function analyzeKey(content: string, body: string, siteKey = "", siteCapo = 0): KeyInfo {
  const keyLine = content.match(KEY_LINE_RE);
  const labelled = canonicalKey(siteKey || (keyLine ? keyLine[1] + (keyLine[2] || "") : ""));
  const capo = siteCapo > 0 && siteCapo < 12 ? siteCapo : detectCapo(content);
  const chordKey = keyFromBody(body);

  if (labelled && capo) {
    if (chordKey && keyIdx(chordKey) === keyIdx(labelled)) {
      return { chartKey: labelled, concertKey: shiftKey(labelled, capo), capo };
    }
    return { chartKey: shiftKey(labelled, -capo), concertKey: labelled, capo };
  }
  if (labelled) return { chartKey: labelled, concertKey: labelled, capo: 0 };
  if (!chordKey) return { chartKey: "", concertKey: "", capo: 0 };
  return { chartKey: chordKey, concertKey: capo ? shiftKey(chordKey, capo) : chordKey, capo };
}

/** Rewrite a capo chart in concert pitch (G shapes + capo 4 → B chords). */
export function toConcert(chart: string, info: KeyInfo): string {
  if (!info.capo || !info.chartKey) return chart;
  return transposeChart(
    stripCapoLines(chart),
    semitonesBetween(info.chartKey, info.concertKey),
    prefersFlats(info.concertKey),
  );
}
