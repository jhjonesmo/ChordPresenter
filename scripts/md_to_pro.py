#!/usr/bin/env python3
"""
md_to_pro.py — Convert Obsidian Clipper chord+lyrics MD files to ProPresenter .pro files.

Usage:
    python3 md_to_pro.py "path/to/Song Name.md"
    python3 md_to_pro.py --all    (process every .md in INBOX_DIR)

For each song produces two files in SONGS_OUTPUT_DIR:
    "Song - Artist - Vocals.pro"
    "Song - Artist - Vocals + Chords.pro"  ← Phase 2 (chords support coming)

Input format (EssentialWorship / Obsidian Clipper):
    YAML frontmatter with title field, then a ``` code block containing:
      [SECTION NAME] headers
      Chord lines  (only chord symbols, spaces, | / -)
      Lyric lines  (actual words)

Sections like INTRO, OUTRO, INSTRUMENTAL, TURN are skipped (no lyrics).
Sections with no lyric lines (e.g. [CHORUS 1] [x2] repeat markers) are also skipped.

Template source: Washed - Elevation Worship2ndedit.pro (CCOB Outdoor format).
"""

from __future__ import annotations

import re
import os
import sys

# ── Import slide/file building machinery from create_pro_song ──────────────
# All protobuf and RTF logic lives there.
sys.path.insert(0, os.path.dirname(__file__))
from create_pro_song import (
    build_slide, build_group, build_arrangement, build_pro_file,
    SONGS_OUTPUT_DIR,
)

# ────────────────────────────────────────────────────────────────
# CONFIGURATION
# ────────────────────────────────────────────────────────────────

INBOX_DIR = ""  # Set via --inbox flag or Preferences; do not hardcode

# Only skip guitar-tab sections — everything else (intro, outro, tag, interlude, turn)
# is handled: chord-only sections become blank stage-monitor slides, lyric sections
# become normal slides.
SKIP_SECTION_RE = re.compile(r'^tab$', re.IGNORECASE)

# Whitelist of recognised section names — works for any capitalisation and with or
# without a trailing colon (EssentialWorship, WorshipTogether, WorshipChords.com,
# E-Chords, Ultimate Guitar, WorshipChords.net all produce variants of these).
SECTION_NAME_RE = re.compile(
    r'^(intro|verse|chorus|pre[\s\-]?chorus|bridge|tag|outro|interlude|'
    r'instrumental|ending|coda|hook|turn|turnaround|transition|vamp|'
    r'breakdown|refrain)\s*\d*\s*:?\s*$',
    re.IGNORECASE
)

# Ordinal-word section headers: "First Verse", "Second Chorus", etc.
# WorshipChords.com uses this format instead of "Verse 1", "[VERSE 1]", etc.
_ORDINAL_TO_NUM = {
    'first': '1', 'second': '2', 'third': '3', 'fourth': '4',
    'fifth': '5', 'sixth': '6', 'seventh': '7', 'eighth': '8',
    'ninth': '9', 'tenth': '10',
}
_ORDINAL_SECTION_RE = re.compile(
    r'^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)'
    r'\s+(verse|chorus|bridge|tag|pre[\s\-]?chorus|intro|outro|interlude|vamp|refrain)'
    r'\s*:?\s*$',
    re.IGNORECASE
)

def _normalize_ordinal_section(name: str) -> str:
    """'First Verse' → 'Verse 1',  'Second Chorus' → 'Chorus 2', etc."""
    m = _ORDINAL_SECTION_RE.match(name.strip())
    if not m:
        return name.title()
    num     = _ORDINAL_TO_NUM[m.group(1).lower()]
    section = m.group(2).title()
    return f"{section} {num}"

# ────────────────────────────────────────────────────────────────
# CHORD / LYRIC LINE DETECTION
# ────────────────────────────────────────────────────────────────

# A single chord token: root [accidental] [quality] [interval] [slash bass]
_CHORD_TOKEN_RE = re.compile(
    r'^[A-G][#b]?'
    r'(m|maj|min|M|dim|aug|°|ø)?'
    r'(maj|min)?'
    r'(7|9|11|13|6|5|4|2)?'
    r'(sus[24]?|add[29]?|omit[35]?)?'
    r'(/[A-G][#b]?)?$'
)

def _is_chord_token(tok):
    return bool(_CHORD_TOKEN_RE.match(tok)) or tok in ('N.C.', 'NC', 'Asus', 'Dsus', 'Esus', 'Bsus')

def is_chord_line(line: str) -> bool:
    """Return True if the line contains only chord symbols and formatting characters."""
    stripped = line.strip()
    if not stripped:
        return True
    if stripped.startswith('|'):          # | F | C/E ... | instrumental
        return True
    if stripped in ('N.C.', 'NC'):
        return True
    # Remove formatting, split into tokens, check each
    clean = re.sub(r'[|/\-\.]', ' ', stripped)
    tokens = [t for t in clean.split() if t]
    if not tokens:
        return True
    return all(_is_chord_token(t) for t in tokens)


# ────────────────────────────────────────────────────────────────
# DIATONIC KEY DETECTION  (chord-quality aware)
# ────────────────────────────────────────────────────────────────

# Enharmonic twin for normalisation checks.
_ENH = {
    'C#':'Db','Db':'C#','D#':'Eb','Eb':'D#',
    'F#':'Gb','Gb':'F#','G#':'Ab','Ab':'G#','A#':'Bb','Bb':'A#',
}

def _normalize_chord(chord: str) -> str:
    """
    Reduce a chord to root + 'm' (minor) or just root (major/sus/dom/etc.).
    Slash bass notes and all extensions are stripped.

    Examples:
        G, Gmaj7, Gsus4, G7, G/B  → 'G'
        Em, Em7, Em7sus4           → 'Em'
        F#m, F#m7                  → 'F#m'
        Dm, Dm9                    → 'Dm'
    """
    chord = chord.split('/')[0]                        # strip /bass
    m = re.match(r'^([A-G][#b]?)(.*)', chord)
    if not m:
        return ''
    root, quality = m.group(1), m.group(2)
    is_minor = bool(re.match(r'^m(?!aj)', quality))    # 'm' but not 'maj'
    return root + ('m' if is_minor else '')

def _chord_variants(norm: str) -> tuple:
    """Return (norm, enharmonic-twin) for set-membership checks."""
    is_minor = norm.endswith('m')
    root = norm[:-1] if is_minor else norm
    suffix = 'm' if is_minor else ''
    twin = _ENH.get(root, '')
    return (norm, twin + suffix) if twin else (norm,)

# Full 24-key diatonic chord sets — major keys I ii iii IV V vi,
# minor keys i III iv v V VI VII  (both natural-v and harmonic-V included
# since worship songs use either depending on the song).
# Diminished (vii°) omitted — rare in contemporary worship charts.
_DIATONIC_CHORDS: dict = {
    # ── Major keys ────────────────────────────────────────────────
    'C':  {'C','Dm','Em','F','G','Am'},
    'G':  {'G','Am','Bm','C','D','Em'},
    'D':  {'D','Em','F#m','G','A','Bm'},
    'A':  {'A','Bm','C#m','D','E','F#m'},
    'E':  {'E','F#m','G#m','A','B','C#m'},
    'B':  {'B','C#m','D#m','E','F#','G#m'},
    'F#': {'F#','G#m','A#m','B','C#','D#m'},
    'F':  {'F','Gm','Am','Bb','C','Dm'},
    'Bb': {'Bb','Cm','Dm','Eb','F','Gm'},
    'Eb': {'Eb','Fm','Gm','Ab','Bb','Cm'},
    'Ab': {'Ab','Bbm','Cm','Db','Eb','Fm'},
    'Db': {'Db','Ebm','Fm','Gb','Ab','Bbm'},
    # ── Minor keys ───────────────────────────────────────────────
    'Am': {'Am','C','Dm','Em','E','F','G'},
    'Em': {'Em','G','Am','Bm','B','C','D'},
    'Bm': {'Bm','D','Em','F#m','F#','G','A'},
    'F#m':{'F#m','A','Bm','C#m','C#','D','E'},
    'C#m':{'C#m','E','F#m','G#m','G#','A','B'},
    'G#m':{'G#m','B','C#m','D#m','D#','E','F#'},
    'Dm': {'Dm','F','Gm','Am','A','Bb','C'},
    'Gm': {'Gm','Bb','Cm','Dm','D','Eb','F'},
    'Cm': {'Cm','Eb','Fm','Gm','G','Ab','Bb'},
    'Fm': {'Fm','Ab','Bbm','Cm','C','Db','Eb'},
    'Bbm':{'Bbm','Db','Ebm','Fm','F','Gb','Ab'},
}

def _key_from_chords(norm_chords: list) -> str:
    """
    Return the key (major or minor) whose diatonic chord set has the most
    matches against the normalised chord list.

    Tiebreaks (in order):
    1. The key whose tonic chord name equals the first chord in the song.
       (Songs very often start on the I/i chord — 'G' starts on G, 'Am'
       starts on Am.)
    2. Keep the earlier key in dict order (stable).

    Using chord quality (major vs minor root) means, e.g., Gm correctly
    scores for Bb major / G minor but NOT for C major — better signal than
    root-only matching.
    """
    if not norm_chords:
        return 'Unknown'
    unique = list(dict.fromkeys(norm_chords))  # deduplicate, preserve order
    first = unique[0]

    best_key, best_score = 'C', -1
    for key, diatonic in _DIATONIC_CHORDS.items():
        score = sum(
            1 for c in unique
            if any(v in diatonic for v in _chord_variants(c))
        )
        if score < best_score:
            continue
        if score > best_score:
            best_score = score
            best_key = key
            continue
        # Tied — tiebreak on first chord being the tonic.
        new_tonic = any(v == key for v in _chord_variants(first))
        cur_tonic = any(v == best_key for v in _chord_variants(first))
        if new_tonic and not cur_tonic:
            best_key = key
    return best_key


def _chord_root(chord: str) -> str:
    """Extract the root note (kept for use in other parts of the module)."""
    m = re.match(r'^([A-G][#b]?)', chord)
    return m.group(1) if m else ''


# ────────────────────────────────────────────────────────────────
# RAW-MD BODY EXTRACTOR  (for sites with no ``` code block)
# ────────────────────────────────────────────────────────────────

def _extract_raw_md_body(raw: str) -> str:
    """
    Extract the chord chart body from a clipped MD file that has no ``` code block.
    Used for sites like WorshipTogether where Obsidian Clipper produces plain MD.

    Strategy:
      1. Strip YAML frontmatter, markdown images, markdown links, and ATX headers.
      2. Find the first line that matches a known section name (e.g. "Intro", "Verse 1").
      3. Return everything from that point onward, filtering out "REPEAT …" directives.
    """
    # Remove YAML frontmatter block
    raw = re.sub(r'^---\s*\n.*?\n---\s*\n', '', raw, flags=re.DOTALL | re.MULTILINE)
    # Remove markdown images: ![alt](url)
    raw = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', raw)
    # Remove markdown links entirely — navigation elements like "[Free chord pro download](#)"
    raw = re.sub(r'\[[^\]]*\]\([^)]*\)', '', raw)
    # Remove ATX headers: ## Title
    raw = re.sub(r'^#{1,6}\s+.*$', '', raw, flags=re.MULTILINE)

    lines = raw.splitlines()

    # Find the first recognised section header; everything before it is navigation junk.
    chart_start = None
    for i, line in enumerate(lines):
        if SECTION_NAME_RE.match(line.strip()):
            chart_start = i
            break

    if chart_start is None:
        # Could not find a section header — return cleaned content as-is and hope for the best.
        return raw

    chart_lines = lines[chart_start:]
    # Filter "REPEAT …" directives (WorshipTogether uses "REPEAT CHORUS" etc.)
    result = [l for l in chart_lines
              if not re.match(r'^REPEAT\s+', l.strip(), re.IGNORECASE)]
    return '\n'.join(result)


# ────────────────────────────────────────────────────────────────
# MD PARSER
# ────────────────────────────────────────────────────────────────

def parse_md_song(filepath: str):
    """
    Parse an EssentialWorship Obsidian Clipper .md file.

    Returns:
        title    : str  — song title (without artist)
        artist   : str  — artist name (may be empty)
        sections : list of (section_name, [lyric_line, ...])
                   Each lyric_line is one slide (strings only — no tuples).
                   Chord lines, instrumental sections, and empty repeat-markers
                   are all stripped out.
        chord_map: list of (section_name, [(lyric_line, {char_pos: chord_name})])
                   Parallel to sections, with chord position data for Phase 2.
    """
    with open(filepath, 'r', encoding='utf-8') as f:
        raw = f.read()

    # ── Extract title and artist from YAML frontmatter ──────────
    title, artist = '', ''
    title_match = re.search(r'^title:\s*"([^"]+)"', raw, re.MULTILINE)
    if title_match:
        parts = [p.strip() for p in title_match.group(1).split('|')]
        # Format: "Song Name | Artist | Chords + Lyrics"
        if len(parts) >= 1:
            title = parts[0].strip()
        if len(parts) >= 2:
            candidate = parts[1].strip()
            # If the second part looks like the suffix rather than a real artist, skip it
            if not re.match(r'^chords', candidate, re.IGNORECASE):
                artist = candidate
        # Strip " | Chords + Lyrics" suffix from title if it leaked in
        title = re.sub(r'\s*\|\s*chords.*$', '', title, flags=re.IGNORECASE).strip()

    if not title:
        title = os.path.splitext(os.path.basename(filepath))[0]

    # ── Extract code block content ───────────────────────────────
    code_match = re.search(r'```\s*\n(.*?)```', raw, re.DOTALL)
    if code_match:
        body = code_match.group(1)
    else:
        # No code block — site like WorshipTogether outputs plain MD.
        # Extract the chord chart by stripping navigation and finding the first section.
        body = _extract_raw_md_body(raw)

    # ── Walk lines, building sections ────────────────────────────
    sections = []        # [(name, [lyric_lines])]
    chord_map = []       # [(name, [(lyric, {pos: chord})])]

    cur_name        = None
    cur_lines       = []   # lyric lines for current section
    cur_chords      = []   # (lyric, {pos: chord}) pairs for current section
    cur_chord_lines = []   # chord-only lines (for instrumental sections)
    pending_chord_line = None

    def flush():
        nonlocal cur_name, cur_lines, cur_chords, cur_chord_lines, pending_chord_line
        if cur_name is not None:
            if cur_lines:
                # Normal lyric section
                if not SKIP_SECTION_RE.match(cur_name):
                    sections.append((cur_name, list(cur_lines)))
                    chord_map.append((cur_name, list(cur_chords)))
            elif cur_chord_lines:
                # Chord-only section (Intro, Outro, Interlude, Tag, etc.)
                # Lyric text = spaces matching chord line length → blank on audience
                # screen, but chord indicators sit at correct positions on stage monitor.
                chord_slides      = []
                chord_slide_data  = []
                for cl in cur_chord_lines:
                    positions  = _map_chord_positions(cl, cl)
                    # Spaces keep the lyric field non-empty (so RTF renders)
                    # but invisible — audience sees a blank slide.
                    lyric_text = ' ' * max((len(cl.rstrip())), 1)
                    chord_slides.append(lyric_text)
                    chord_slide_data.append((lyric_text, positions))
                if chord_slides:
                    sections.append((cur_name, chord_slides))
                    chord_map.append((cur_name, chord_slide_data))
        cur_name        = None
        cur_lines       = []
        cur_chords      = []
        cur_chord_lines = []
        pending_chord_line = None

    for raw_line in body.splitlines():
        stripped = raw_line.strip()

        # ── Section header: bracket format [VERSE 1], [Chorus], etc. ────
        header_match = re.match(r'^\[([^\]]+)\]', stripped)
        if header_match:
            flush()
            raw_name = header_match.group(1).strip()
            # Strip repeat qualifiers like "(x2)" or "x2" at the end
            raw_name = re.sub(r'\s*x\d+\s*$', '', raw_name, flags=re.IGNORECASE).strip()
            cur_name = raw_name.title()   # "VERSE 1" → "Verse 1"
            pending_chord_line = None
            continue

        # ── Section header: ordinal word format ──────────────────────
        # "First Verse", "Second Chorus", etc. (WorshipChords.com style).
        # Must come before SECTION_NAME_RE so these lines don't fall through
        # to lyric parsing.
        if stripped and not raw_line[0].isspace() and _ORDINAL_SECTION_RE.match(stripped):
            flush()
            cur_name = _normalize_ordinal_section(stripped)
            pending_chord_line = None
            continue

        # ── Section header: known name without brackets ───────────────
        # Handles WorshipChords.com ("Verse 1"), E-Chords ("Intro:"),
        # WorshipTogether ("VERSE 1"), EW plain style, and more.
        # Only match non-indented lines so chord-alignment spaces don't interfere.
        if stripped and not raw_line[0].isspace() and SECTION_NAME_RE.match(stripped):
            flush()
            clean_name = re.sub(r':?\s*$', '', stripped)   # strip trailing colon
            cur_name = clean_name.strip().title()
            pending_chord_line = None
            continue

        if cur_name is None:
            continue

        if not stripped:
            pending_chord_line = None
            continue

        # ── Skip "REPEAT CHORUS" / "REPEAT VERSE" directives ─────────
        if re.match(r'^REPEAT\s+', stripped, re.IGNORECASE):
            continue

        if is_chord_line(stripped):
            pending_chord_line = stripped
            cur_chord_lines.append(stripped)
            continue

        # It's a lyric line
        # Pair with the pending chord line for chord position mapping
        chord_positions = {}
        if pending_chord_line is not None:
            chord_positions = _map_chord_positions(pending_chord_line, stripped)
            pending_chord_line = None

        # Normalize chord-alignment spaces (e.g. "gave   me   one  more   day" → clean)
        lyric_clean = re.sub(r'  +', ' ', stripped)

        # ── Dash rule: "An - other" → "Another" ─────────────────────────────
        # Worship charts use " - " to mark sustained syllable breaks within words.
        # Simply remove the dash and join the syllables.
        # Edge cases like "no - one" → "noone" are rare and can be fixed in preview.
        dash_matches = list(re.finditer(r'\s+-\s+', lyric_clean))
        if dash_matches:
            new_pos = {}
            for pos, chord in chord_positions.items():
                shift = sum(len(m.group()) for m in dash_matches if m.start() < pos)
                new_pos[max(0, pos - shift)] = chord
            chord_positions = new_pos
            lyric_clean = re.sub(r'\s+-\s+', '', lyric_clean)

        # Comma rule: "phrase one, phrase two" → 2-line slide with hard RTF break.
        # Delete the comma; each phrase becomes its own line within one slide.
        # Only split when the part BEFORE the comma has at least 4 words.
        # e.g. "My God, You're..." (2 words) → no split
        #      "Fire in His eyes, healing..." (4 words) → split
        comma_m = re.search(r',\s+', lyric_clean)
        part1_words = len(lyric_clean[:comma_m.start()].split()) if comma_m else 0
        if comma_m and part1_words >= 4:
            part1 = lyric_clean[:comma_m.start()].strip()
            part2 = lyric_clean[comma_m.end():].strip()
            slide_entry = (part1, part2)

            # Adjust chord positions: those before the comma stay; those in part2
            # shift left by (comma position + separator length - 1 newline char).
            part2_orig_start = comma_m.end()   # where part2 begins in original
            part2_rtf_start  = len(part1) + 1  # where part2 begins in combined RTF text
            adjusted = {}
            for pos, chord in chord_positions.items():
                if pos < comma_m.start():
                    adjusted[pos] = chord                          # in part1, no change
                else:
                    new_pos = pos - part2_orig_start + part2_rtf_start
                    adjusted[max(0, new_pos)] = chord              # in part2, shifted
            chord_positions = adjusted
        else:
            slide_entry = lyric_clean

        cur_lines.append(slide_entry)
        cur_chords.append((slide_entry if isinstance(slide_entry, str)
                           else f"{slide_entry[0]} {slide_entry[1]}",
                           chord_positions))

    flush()

    return title, artist, sections, chord_map


def _map_chord_positions(chord_line: str, lyric_line: str) -> dict:
    """
    Given a chord line and the lyric line beneath it, return a dict of
    {char_position_in_lyric: chord_name} for Phase 2 chord embedding.

    Example:
        chord_line = "       C/E    Dm   C    Bb    F/A"
        lyric_line = "'Cause You gave   me   one  more   day"
        → {7: 'C/E', 11: 'Dm', 17: 'C', 21: 'Bb', 26: 'F/A'}
    """
    positions = {}
    # Find each chord token and its position in the chord line
    for m in re.finditer(r'[A-G][#b]?\S*', chord_line):
        chord = m.group()
        if _is_chord_token(chord):
            col = m.start()
            # Map column to lyric character position (clamped)
            lyric_pos = min(col, max(0, len(lyric_line) - 1))
            positions[lyric_pos] = chord
    return positions


# ────────────────────────────────────────────────────────────────
# TRANSPOSITION ENGINE
# ────────────────────────────────────────────────────────────────

# Chromatic scale in sharps; flat spellings mapped to their sharp equivalents.
_CHROMATIC   = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
_FLAT_TO_SHARP = {'Db':'C#','Eb':'D#','Fb':'E','Gb':'F#','Ab':'G#','Bb':'A#','Cb':'B'}
_SHARP_TO_FLAT = {'C#':'Db','D#':'Eb','F#':'Gb','G#':'Ab','A#':'Bb'}

# Keys that conventionally use flat spellings.
_FLAT_KEYS = {'F','Bb','Eb','Ab','Db','Gb','Dm','Gm','Cm','Fm','Bbm','Ebm'}

def _note_idx(note: str) -> int:
    # Accept key labels like "G#m", "Bbm" — use only the root note portion.
    root_only = re.match(r'^[A-G][#b]?', note.strip())
    note = root_only.group() if root_only else note
    note = _FLAT_TO_SHARP.get(note, note)
    return _CHROMATIC.index(note)

def _idx_note(idx: int, prefer_flat: bool) -> str:
    note = _CHROMATIC[idx % 12]
    if prefer_flat:
        note = _SHARP_TO_FLAT.get(note, note)
    return note

def transpose_chord(chord: str, semitones: int, prefer_flat: bool = False) -> str:
    """
    Transpose a chord name by the given number of semitones.
    Handles slash chords (C/E), qualities (m, maj7, sus2, dim, aug, …), and N.C.
    """
    if chord in ('N.C.', 'NC') or semitones == 0:
        return chord
    m = re.match(r'^([A-G][#b]?)(.*?)(?:/([A-G][#b]?))?$', chord)
    if not m:
        return chord
    root, quality, bass = m.group(1), m.group(2), m.group(3)
    try:
        new_root = _idx_note((_note_idx(root) + semitones) % 12, prefer_flat)
    except ValueError:
        return chord
    if bass:
        try:
            new_bass = _idx_note((_note_idx(bass) + semitones) % 12, prefer_flat)
            return f"{new_root}{quality}/{new_bass}"
        except ValueError:
            pass
    return f"{new_root}{quality}"

def transpose_chord_map(chord_map, semitones: int, prefer_flat: bool):
    """Apply transposition to every chord name in the full chord_map."""
    if semitones == 0:
        return chord_map
    result = []
    for sec_name, pairs in chord_map:
        new_pairs = []
        for lyric, positions in pairs:
            new_pos = {p: transpose_chord(c, semitones, prefer_flat)
                       for p, c in positions.items()}
            new_pairs.append((lyric, new_pos))
        result.append((sec_name, new_pairs))
    return result

def _detect_key(filepath: str) -> str:
    """Return the original key of the chart.

    Priority order:
    1. Explicit ``Key: X`` line anywhere in the file — highest confidence.
       Handles UG/Obsidian clippings like ``Key: BCapo: 4th fret`` (missing
       space) by matching only the note root + optional accidental.
    2. Diatonic matching — collect every chord root from every chord line in
       the chart and find the major key whose scale contains the most of them.
       More robust than "first chord" because most songs have many chord lines
       and the tonic chord appears far more often than any other.
    3. Fallback: 'Unknown' (only if no chord lines exist at all, e.g. a pure
       lyrics file — key doesn't matter in that case anyway).
    """
    with open(filepath, 'r', encoding='utf-8') as f:
        raw = f.read()

    # Priority 1: explicit Key: field.
    key_match = re.search(r'Key:\s*([A-G][#b]?)', raw)
    if key_match:
        return key_match.group(1)

    # Get chart body.
    code = re.search(r'```\s*\n(.*?)```', raw, re.DOTALL)
    body = code.group(1) if code else _extract_raw_md_body(raw)

    # Priority 2: chord-quality diatonic matching over the whole chart.
    norm_chords = []
    for line in body.splitlines():
        stripped = line.strip()
        if stripped and is_chord_line(stripped):
            # Strip bass notes from slash chords BEFORE splitting on '/'
            # so that "B/D#" contributes only "B" and not the bass note "D#".
            # Without this, bass notes score against diatonic sets and skew
            # key detection (e.g. B/D# makes G#m look better than B major).
            no_bass = re.sub(r'/[A-G][#b]?', '', stripped)
            tokens = [t for t in re.sub(r'[|\-]', ' ', no_bass).split()
                      if t and _is_chord_token(t)]
            norm_chords.extend(_normalize_chord(t) for t in tokens)
    norm_chords = [c for c in norm_chords if c]  # drop empty strings

    return _key_from_chords(norm_chords)  # returns 'Unknown' if list is empty


# ────────────────────────────────────────────────────────────────
# .PRO FILE BUILDER  (single output file with chords embedded)
# ────────────────────────────────────────────────────────────────

def build_song_pro(title: str, artist: str, sections, chord_map,
                   lyrics_only: bool = False):
    """
    Build a single .pro file with lyrics + optionally embedded chords.
    Automatically prepends 2 blank slides in an "Opening" group so the operator
    has space to add media backgrounds, audience look, etc.

    lyrics_only=True  → plain lyric slides only, no chord data on stage monitor.
    lyrics_only=False → current behaviour: chords embedded for stage monitor display.

    Returns binary .pro content.
    """
    # Prepend 2 blank slides as an "Opening" section
    blank_section  = [("Opening", ["", ""])]
    blank_chords   = [("Opening", [("", {}), ("", {})])]
    all_sections   = blank_section + list(sections)
    all_chord_map  = blank_chords  + list(chord_map)

    if lyrics_only:
        # No chord data — all dicts empty, produces clean lyric-only slides
        chord_data = [(sec_name, [{} for _ in pairs]) for sec_name, pairs in all_chord_map]
    else:
        chord_data = []
        for sec_name, lyric_chord_pairs in all_chord_map:
            chord_dicts = [chords for _, chords in lyric_chord_pairs]
            chord_data.append((sec_name, chord_dicts))

    return build_pro_file(title, all_sections, arrangement_name="CCOB-Outdoor",
                          chord_data=chord_data)


# ────────────────────────────────────────────────────────────────
# MAIN
# ────────────────────────────────────────────────────────────────

def _safe_filename(name: str) -> str:
    """Replace characters that are illegal or dangerous in macOS/Windows filenames."""
    # / is the main culprit (path separator); others are cautionary
    return re.sub(r'[/\\:*?"<>|]', '-', name).strip(' -')


def process_file(filepath: str, target_key: str = None, output_dir: str = None,
                 lyrics_only: bool = False):
    print(f"\nProcessing: {os.path.basename(filepath)}")

    title, artist, sections, chord_map = parse_md_song(filepath)
    display_name = _safe_filename(f"{title} - {artist}" if artist else title)

    # Detect original key; optionally transpose to target key
    source_key = _detect_key(filepath)
    key = target_key if target_key else source_key

    if target_key and target_key.upper() != source_key.upper():
        try:
            semitones = (_note_idx(target_key) - _note_idx(source_key)) % 12
            prefer_flat = target_key in _FLAT_KEYS
            chord_map = transpose_chord_map(chord_map, semitones, prefer_flat)
            print(f"  Transposing: {source_key} → {target_key} ({semitones:+d} semitones)")
        except ValueError as e:
            print(f"  WARNING: Could not transpose ({e}); using original key {source_key}")
            key = source_key
    else:
        print(f"  Key: {key}")

    mode_tag = " [lyrics only]" if lyrics_only else ""
    print(f"  Title:  {title}{mode_tag}")
    print(f"  Artist: {artist or '(none)'}")
    for sname, lines in sections:
        print(f"  [{sname}] {len(lines)} slides")

    out_dir = output_dir or SONGS_OUTPUT_DIR
    if not out_dir or not out_dir.strip():
        raise ValueError(
            "No output folder configured. Open Preferences in ChordPresenter and set an Output folder."
        )
    os.makedirs(out_dir, exist_ok=True)

    # Single output file: "Title - Artist - Key.pro"  (or "Title - Key.pro" if no artist)
    file_name   = f"{display_name} - {key}.pro"
    file_path   = os.path.join(out_dir, file_name)
    song_data   = build_song_pro(display_name, artist, sections, chord_map,
                                  lyrics_only=lyrics_only)

    with open(file_path, 'wb') as f:
        f.write(song_data)

    total = sum(len(ls) for _, ls in sections)
    print(f"  → {file_name}")
    print(f"     {total} slides, {len(song_data):,} bytes")


def main():
    args = sys.argv[1:]

    # Parse optional --key TARGET, --out DIR, --lyrics-only flags
    target_key  = None
    output_dir  = None
    lyrics_only = False
    filtered = []
    i = 0
    while i < len(args):
        if args[i] == '--key' and i + 1 < len(args):
            target_key = args[i + 1]; i += 2
        elif args[i] == '--out' and i + 1 < len(args):
            output_dir = args[i + 1]; i += 2
        elif args[i] == '--lyrics-only':
            lyrics_only = True; i += 1
        else:
            filtered.append(args[i]); i += 1
    args = filtered

    if '--all' in args:
        all_files = sorted(
            f for f in os.listdir(INBOX_DIR)
            if f.endswith('.md') and 'Chords + Lyrics' in f
        )
        # Deduplicate: prefer base filename over "(1)" / "(2)" variants
        seen = {}
        for fname in all_files:
            key_fname = re.sub(r'\s*\(\d+\)(?=\.md$)', '', fname)
            if key_fname not in seen:
                seen[key_fname] = fname
        md_files = [os.path.join(INBOX_DIR, f) for f in seen.values()]
        if not md_files:
            print(f"No chord+lyrics MD files found in {INBOX_DIR}")
            return
        for fp in sorted(md_files):
            try:
                process_file(fp, target_key=target_key, output_dir=output_dir,
                             lyrics_only=lyrics_only)
            except Exception as e:
                print(f"  ERROR: {e}")
    elif args:
        for fp in args:
            process_file(fp, target_key=target_key, output_dir=output_dir,
                         lyrics_only=lyrics_only)
    else:
        print("Usage:")
        print("  python3 md_to_pro.py 'path/to/song.md'")
        print("  python3 md_to_pro.py 'path/to/song.md' --key G")
        print("  python3 md_to_pro.py --all")
        print("  python3 md_to_pro.py --all --key Bb --out /path/to/output")
        sys.exit(1)


if __name__ == '__main__':
    main()
