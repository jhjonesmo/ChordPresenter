#!/usr/bin/env python3
"""
parse_pro.py — Extract slides from a ProPresenter .pro binary file.

Outputs JSON to stdout:
{
  "title": "Song Title",
  "slides": [
    {
      "index": 0,
      "group": "Verse 1",                             // real group/section name
      "lines": ["LYRIC LINE ONE", "LYRIC LINE TWO"],   // 1 or 2 lyric lines per slide
      "chords": "F   Bb   C"                           // existing stage-display chords, if any
    },
    ...
  ]
}

Usage:
  python3 parse_pro.py "path/to/Song.pro"

Supports any .pro file — not just ChordPresenter-generated ones. Slides are
walked structurally via the file's real arrangement/group/slide protobuf
fields (not a blind whole-file scan), so groups and any chords already
embedded for stage display are preserved. Lyric text is extracted from each
slide's own embedded RTF block.
"""

from __future__ import annotations

import re
import sys
import json
import struct


# ══════════════════════════════════════════════════════════════════════════════
# PROTOBUF VARINT DECODER
# ══════════════════════════════════════════════════════════════════════════════

def decode_varint(data: bytes, pos: int) -> tuple[int, int]:
    val, shift = 0, 0
    while pos < len(data):
        b = data[pos]
        val |= (b & 0x7F) << shift
        pos += 1
        shift += 7
        if not (b & 0x80):
            break
    return val, pos


def read_proto_fields(data: bytes) -> dict[int, list[bytes]]:
    """
    Walk a protobuf blob and return {field_number: [bytes_value, ...]}
    for wire-type-2 (length-delimited) fields only.
    Ignores varint and fixed-width fields.
    """
    fields: dict[int, list[bytes]] = {}
    pos = 0
    while pos < len(data):
        try:
            tag, pos = decode_varint(data, pos)
        except Exception:
            break
        wire = tag & 0x07
        field = tag >> 3
        if wire == 0:           # varint — skip
            _, pos = decode_varint(data, pos)
        elif wire == 1:         # 64-bit fixed — skip
            pos += 8
        elif wire == 2:         # length-delimited — keep
            length, pos = decode_varint(data, pos)
            value = data[pos:pos + length]
            fields.setdefault(field, []).append(value)
            pos += length
        elif wire == 5:         # 32-bit fixed — skip
            pos += 4
        else:
            break               # unknown wire type — stop
    return fields


# ══════════════════════════════════════════════════════════════════════════════
# RTF TEXT EXTRACTOR
# ══════════════════════════════════════════════════════════════════════════════

def _extract_rtf_text(rtf_bytes: bytes) -> list[str]:
    """
    Extract plain-text lines from an RTF byte block.
    Handles ProPresenter RTF and common RTF patterns.
    Returns a list of non-empty text strings.
    """
    try:
        text = rtf_bytes.decode('latin-1', errors='replace')
    except Exception:
        return []

    # Remove extended groups that are metadata-only: {\*\...}
    text = re.sub(r'\{\\[*][^{}]*\}', '', text)

    # Remove font table and colour table groups
    text = re.sub(r'\{\\fonttbl[^{}]*\}', '', text)
    text = re.sub(r'\{\\colortbl[^{}]*\}', '', text)
    text = re.sub(r'\{\\expandedcolortbl[^{}]*\}', '', text)

    # Replace paragraph/line breaks with newline sentinel
    text = re.sub(r'\\par\b\s*', '\n', text)
    text = re.sub(r'\\line\b\s*', '\n', text)

    # ProPresenter two-line separator: \\<newline>  (literal backslash + newline in RTF)
    text = re.sub(r'\\\\\n', '\n', text)

    # Handle Unicode escapes: \uXXXX? → character
    text = re.sub(r'\\u(\d+)\?', lambda m: chr(int(m.group(1))), text)

    # Handle RTF hex escapes: \'XX → decoded character.
    # Must run BEFORE control-word removal so the apostrophe doesn't confuse
    # the \\[a-zA-Z]+ pattern that follows.
    def _rtf_hex(m: re.Match) -> str:
        code = int(m.group(1), 16)
        if code == 0xa0:  # non-breaking space → regular space
            return ' '
        if code == 0xad:  # soft hyphen → remove
            return ''
        # Decode as Windows-1252 (RTF default ANSI codepage on macOS too)
        try:
            return bytes([code]).decode('windows-1252')
        except Exception:
            return ' '
    text = re.sub(r"\\'([0-9a-fA-F]{2})", _rtf_hex, text)

    # Remove all remaining RTF control words (e.g. \fs502 \cf2 \b \pard etc.)
    text = re.sub(r'\\[a-zA-Z]+[-]?\d*\s?', ' ', text)

    # Remove remaining braces
    text = text.replace('{', '').replace('}', '')

    # Split, clean, strip RTF line-separator backslash artefacts
    lines = []
    for line in text.split('\n'):
        line = re.sub(r'\s+', ' ', line).strip()
        line = line.rstrip('\\').strip()   # remove trailing \ from two-line separator
        if line:
            lines.append(line)

    return lines


def _find_rtf_blocks(data: bytes) -> list[bytes]:
    """
    Scan binary data for embedded RTF blocks starting with {\\rtf1.
    Returns each complete RTF block as bytes.
    """
    blocks = []
    marker = b'{\\rtf1'
    pos = 0
    while True:
        idx = data.find(marker, pos)
        if idx == -1:
            break
        # Walk forward counting brace depth to find closing }
        depth = 0
        i = idx
        end = -1
        while i < len(data):
            b = data[i]
            if b == ord('{'):
                depth += 1
            elif b == ord('}'):
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
            i += 1
        if end > idx:
            blocks.append(data[idx:end])
        pos = idx + 1
    return blocks


# ══════════════════════════════════════════════════════════════════════════════
# TITLE EXTRACTION
# ══════════════════════════════════════════════════════════════════════════════

def _extract_title(data: bytes) -> str:
    """
    Try to extract the song title from the outer protobuf (field 3 = UTF-8 string).
    Falls back to filename stem if not found.
    """
    try:
        fields = read_proto_fields(data)
        if 3 in fields:
            for candidate in fields[3]:
                try:
                    text = candidate.decode('utf-8').strip()
                    if text and not text.startswith('{') and len(text) < 200:
                        return text
                except Exception:
                    continue
    except Exception:
        pass
    return ""


# ══════════════════════════════════════════════════════════════════════════════
# DEDUP / FILTER
# ══════════════════════════════════════════════════════════════════════════════

_CHORD_RE = re.compile(
    r'^[A-G][#b]?(?:m|maj|min|dim|aug|sus|add)?[\d/]*(?:/[A-G][#b]?)?$'
)

def _looks_like_chord_line(line: str) -> bool:
    """True if every token on the line looks like a chord symbol."""
    tokens = line.split()
    if not tokens:
        return False
    return all(_CHORD_RE.match(t) for t in tokens)


def _filter_lines(lines: list[str]) -> list[str]:
    """
    Remove lines that are:
    - Entirely chord symbols (those live in the chord attribute block, not RTF)
    - RTF artefacts (long hex strings, UUIDs, control word leftovers)
    - Obvious metadata (font names, colour values)
    """
    clean = []
    for line in lines:
        # Skip chord-only lines
        if _looks_like_chord_line(line):
            continue
        # Skip lines that look like hex or UUIDs
        if re.fullmatch(r'[0-9A-Fa-f\-]{8,}', line.replace(' ', '')):
            continue
        # Skip font/encoding artefacts
        if re.search(r'(TungstenNarrow|cocoartf|ansicpg|SFPro|Helvetica)', line, re.I):
            continue
        # Skip lines of just numbers/punctuation
        if re.fullmatch(r'[\d\s\.,;:\-]+', line):
            continue
        clean.append(line)
    return clean


# ══════════════════════════════════════════════════════════════════════════════
# PROTOBUF STRUCTURE WALKER
# ══════════════════════════════════════════════════════════════════════════════
#
# ProPresenter's .pro schema (confirmed by decoding create_pro_song.py's own
# template — the field numbers below are structural, not theme-dependent, so
# this works on files from other software/themes too, not just ChordPresenter):
#
#   top-level message
#     field 11 (LV) : arrangement  { field1=field1(uuid-wrap), field2=name,
#                                     field3(repeated)=field1(group-uuid-wrap) }
#     field 12 (LV, repeated) : group {
#         field1 (LV) : { field1=field1(uuid-wrap), field2=name(optional), field4=marker }
#         field2 (LV, repeated) : { field1 = slide uuid (36-byte ascii) }
#     }
#     field 13 (LV, repeated) : slide blob {
#         field1 (LV) : field1(uuid-wrap)              ← slide's own UUID
#         field10 → 23 → 2 → 1 → 1 → 1 → field13 (LV)  ← Text element container
#             field3 (LV) : Attributes {
#                 field13 (LV, repeated) : CustomAttribute {
#                     field1 (LV) : Range { field1=start varint, field2=end varint }
#                     field7 (LV, optional) : chord name (UTF-8) — present only
#                                              for chord attributes, not other
#                                              formatting attributes that also
#                                              live in this same repeated field.
#                 }
#             }
#             field5 (LV) : RTF bytes (the lyric text)
#   }
#
# "uuid-wrap" = doubly-nested field1(LV) containing field1(LV) containing the
# raw 36-byte ASCII UUID string — the same wrapper shape create_pro_song.py
# uses everywhere it needs to reference an object by UUID.

def _unwrap_uuid(data: bytes) -> str:
    """Decode a doubly-nested field1→field1 UUID wrapper to its ASCII string."""
    outer = read_proto_fields(data)
    inner = read_proto_fields(outer[1][0])
    return inner[1][0].decode('ascii', 'replace')


def _get_path(data: bytes, path: list[int]) -> bytes | None:
    """Walk a chain of single-value length-delimited fields, e.g. [10,23,2,1,1,1,13,3]."""
    cur = data
    for field in path:
        fields = read_proto_fields(cur)
        if field not in fields:
            return None
        cur = fields[field][0]
    return cur


def _parse_groups(top: dict[int, list[bytes]]) -> list[tuple[str, str, list[str]]]:
    """Return [(group_uuid, group_name, [slide_uuid, ...]), ...] in field-12 order."""
    groups = []
    for g in top.get(12, []):
        gf = read_proto_fields(g)
        if 1 not in gf:
            continue
        inner = read_proto_fields(gf[1][0])
        group_uuid = _unwrap_uuid(gf[1][0]) if 1 in inner else ''
        group_name = inner.get(2, [b''])[0].decode('utf-8', 'replace')
        slide_uuids = []
        for sref in gf.get(2, []):
            sf = read_proto_fields(sref)
            if 1 in sf:
                slide_uuids.append(sf[1][0].decode('ascii', 'replace'))
        groups.append((group_uuid, group_name, slide_uuids))
    return groups


def _parse_arrangement_order(top: dict[int, list[bytes]]) -> list[str] | None:
    """Return the group-uuid order from the arrangement (field 11), or None if absent."""
    if 11 not in top:
        return None
    af = read_proto_fields(top[11][0])
    order = []
    for gref in af.get(3, []):
        gf = read_proto_fields(gref)
        if 1 in gf:
            order.append(gf[1][0].decode('ascii', 'replace'))
    return order or None


def _decode_range(range_bytes: bytes) -> tuple[int, int] | None:
    """Decode a Range { field1=start varint, field2=end varint } manually —
    read_proto_fields() skips varint (wire-type 0) fields, so we walk it here."""
    pos = 0
    start = end = None
    while pos < len(range_bytes):
        tag, pos = decode_varint(range_bytes, pos)
        wire = tag & 0x07
        field = tag >> 3
        if wire != 0:
            break  # unexpected — bail rather than misparse
        val, pos = decode_varint(range_bytes, pos)
        if field == 1:
            start = val
        elif field == 2:
            end = val
    if start is None or end is None:
        return None
    return start, end


def _parse_slide_chords(slide_blob: bytes) -> dict[int, str]:
    """Extract {char_pos: chord_name} from a slide's Text.Attributes, if any."""
    attrs = _get_path(slide_blob, [10, 23, 2, 1, 1, 1, 13, 3])
    if attrs is None:
        return {}
    af = read_proto_fields(attrs)
    positions: dict[int, str] = {}
    for entry in af.get(13, []):
        ef = read_proto_fields(entry)
        if 1 not in ef or 7 not in ef:
            continue  # not a chord attribute (other formatting uses field 13 too)
        rng = _decode_range(ef[1][0])
        if rng is None:
            continue
        start, _end = rng
        try:
            chord_name = ef[7][0].decode('utf-8')
        except Exception:
            continue
        positions[start] = chord_name
    return positions


def _chord_positions_to_line(positions: dict[int, str]) -> str:
    """Render {char_pos: chord} back into a single editable 'F   Bb   C' style line.

    Always keeps at least one space between adjacent chord names, even if
    their recorded positions are only 0-1 characters apart (can happen after
    md_to_pro.py's dash-rule shortens the lyric line on a later re-export,
    shifting two chords close together) — otherwise they'd render fused
    together like "AmDm" and be hard to read/edit.
    """
    if not positions:
        return ''
    buf: list[str] = []
    for pos, chord in sorted(positions.items()):
        while len(buf) < pos:
            buf.append(' ')
        if buf and buf[-1] != ' ':
            buf.append(' ')
        buf.extend(list(chord))
        buf.append(' ')
    return ''.join(buf).rstrip()


def _slide_lyric_lines(slide_blob: bytes) -> list[str]:
    """Extract this slide's own lyric line(s) from its RTF block."""
    rtf_blocks = _find_rtf_blocks(slide_blob)
    lines: list[str] = []
    for block in rtf_blocks:
        block_lines = _filter_lines(_extract_rtf_text(block))
        lines.extend(l for l in block_lines if 0 < len(l) < 200)
    return lines[:2]


# ══════════════════════════════════════════════════════════════════════════════
# MAIN PARSER
# ══════════════════════════════════════════════════════════════════════════════

def parse_pro_file(path: str) -> dict:
    """
    Parse a ProPresenter .pro file and return:
    {
        "title": str,
        "slides": [
            {"index": int, "group": str, "lines": [str, ...], "chords": str},
            ...
        ]
    }

    Slides are ordered and grouped exactly as they are in the source file
    (using the real group/arrangement structure — Verse 1, Chorus, Bridge,
    etc.), and any chords already embedded on stage-display attributes are
    decoded back into an editable chord-line string. The auto-generated
    2-blank-slide "Opening" spacer group (added by every ChordPresenter
    export) is skipped since it is not user content and gets re-added
    automatically on export.
    """
    with open(path, 'rb') as f:
        data = f.read()

    title = _extract_title(data)
    if not title:
        import os
        title = os.path.splitext(os.path.basename(path))[0]

    top = read_proto_fields(data)

    # Map every slide UUID → its own raw blob, so lyric/chord extraction is
    # scoped to exactly that slide (not a blind whole-file RTF scan).
    slide_blobs: dict[str, bytes] = {}
    for blob in top.get(13, []):
        uuid_wrap = _get_path(blob, [1, 1])
        if uuid_wrap is None:
            continue
        slide_uuid = uuid_wrap.decode('ascii', 'replace')
        slide_blobs[slide_uuid] = blob

    groups = _parse_groups(top)

    # Prefer arrangement order (reflects the user's actual song order/reuse of
    # groups); fall back to group declaration order if there's no arrangement
    # or it doesn't line up 1:1 with the parsed groups.
    arrangement_order = _parse_arrangement_order(top)
    by_uuid = {gu: (name, slides) for gu, name, slides in groups}
    if arrangement_order and all(gu in by_uuid for gu in arrangement_order):
        ordered_groups = [(gu, *by_uuid[gu]) for gu in arrangement_order]
    else:
        ordered_groups = groups

    slides = []
    for i, (_gu, group_name, slide_uuids) in enumerate(ordered_groups):
        # Skip the auto-generated 2-blank-slide "Opening" spacer — it isn't
        # editable content and build_song_pro() always re-adds it on export.
        if i == 0 and group_name == 'Opening' and len(slide_uuids) <= 2:
            continue
        for su in slide_uuids:
            blob = slide_blobs.get(su)
            if blob is None:
                continue
            lines = _slide_lyric_lines(blob)
            chords = _chord_positions_to_line(_parse_slide_chords(blob))
            if not lines and not chords:
                continue  # nothing to show or edit for this slide
            slides.append({
                "index": len(slides),
                "group": group_name,
                "lines": lines,
                "chords": chords,
            })

    return {"title": title, "slides": slides}


# ══════════════════════════════════════════════════════════════════════════════
# CLI
# ══════════════════════════════════════════════════════════════════════════════

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: parse_pro.py <path_to_.pro_file>"}))
        sys.exit(1)

    path = sys.argv[1]
    try:
        result = parse_pro_file(path)
        print(json.dumps(result, ensure_ascii=False))
    except FileNotFoundError:
        print(json.dumps({"error": f"File not found: {path}"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
