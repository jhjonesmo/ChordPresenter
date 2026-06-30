#!/usr/bin/env python3
"""
create_pro_song.py — ProPresenter .pro song file creator
CCOB Outdoor standard: TungstenNarrow-Bold font, white text,
black background from theme.

Usage:
    python3 create_pro_song.py

Edit the SONG definition at the bottom of this file with your lyrics,
then run. The .pro file will be saved to SONGS_OUTPUT_DIR.

Lyrics format per section:
    A list where each entry is ONE SLIDE:
      "Single line"           → one-line slide
      ("Line 1", "Line 2")   → two-line slide with explicit hard line break
                                (use for short paired phrases like "Oh hallelujah / I'm clean")

    Keep individual lines to roughly 25 chars or fewer for the Outdoor text box.
    Lines longer than ~28 chars will auto-wrap in ProPresenter — split them
    into a tuple with a natural breath break instead.

Template source: Washed - Elevation Worship2ndedit.pro (CCOB Outdoor format,
confirmed working in ProPresenter).
"""

from __future__ import annotations

import uuid
import os

# ────────────────────────────────────────────────────────────────
# CONFIGURATION
# ────────────────────────────────────────────────────────────────

SONGS_OUTPUT_DIR = ""  # Always overridden by --out from the app; do not hardcode

# ────────────────────────────────────────────────────────────────
# PROTOBUF UTILITIES
# ────────────────────────────────────────────────────────────────

def encode_varint(n):
    out = []
    while n > 127:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    out.append(n)
    return bytes(out)

def decode_varint(data, pos):
    val, consumed = 0, 0
    for j in range(5):
        b = data[pos + j]
        val |= (b & 0x7F) << (7 * j)
        consumed += 1
        if not (b & 0x80):
            break
    return val, consumed

def encode_lv(field_num, content_bytes):
    """Encode a length-delimited protobuf field."""
    tag = encode_varint((field_num << 3) | 2)
    return tag + encode_varint(len(content_bytes)) + content_bytes

def new_uuid():
    return str(uuid.uuid4()).upper()

# ────────────────────────────────────────────────────────────────
# RTF BUILDER
# ────────────────────────────────────────────────────────────────

RTF_HEADER = (
    r'{\rtf1\ansi\ansicpg1252\cocoartf2870' + '\n'
    + r'\cocoatextscaling0\cocoaplatform0'
    + r'{\fonttbl\f0\fnil\fcharset0 TungstenNarrow-Bold;}' + '\n'
    + r'{\colortbl;\red255\green255\blue255;\red255\green255\blue255;}' + '\n'
    + r'{\*\expandedcolortbl;;\cssrgb\c100000\c100000\c100000;}' + '\n'
    + r'\pard\sl20\slleading882\pardirnatural\qc\partightenfactor0' + '\n'
    + '\n'
    + r'\f0\fs506 \cf2 \kerning1\expnd16\expndtw80' + '\n'
)

_UNICODE_MAP = str.maketrans({
    '‘': "'",  '’': "'",   # curly single quotes → straight
    '“': '"',  '”': '"',   # curly double quotes → straight
    '–': '-',  '—': '--',  # en/em dash → hyphen
    '…': '...', ' ': ' ',  # ellipsis, non-breaking space
})

def build_rtf(line1, line2=None):
    """Build RTF-encoded lyric bytes for one or two lines (stored ALL CAPS)."""
    line1 = line1.translate(_UNICODE_MAP).upper()
    if line2:
        line2 = line2.translate(_UNICODE_MAP).upper()
        text = line1 + '\\\n' + line2
    else:
        text = line1
    return (RTF_HEADER + text + '}').encode('latin-1')

# ────────────────────────────────────────────────────────────────
# SLIDE BUILDER  (binary template from Washed 2ndedit.pro — CCOB Outdoor format,
#                 confirmed working in ProPresenter)
# ────────────────────────────────────────────────────────────────

# Source UUIDs present in the template (each appears exactly once; all replaced per slide)
# Template slide: "oh hallelujah" from Washed - Elevation Worship2ndedit.pro (slide 14)
TMPL_SLIDE_UUID  = b'546EA798-D078-41FF-8774-D30592A1E681'  # slide UUID  [4:40]
TMPL_ELEM_UUID1  = b'4266A8FE-54E5-483C-85E1-91E8331F5AD9'  # elem UUID1  [51:87]
TMPL_UUID_MID    = b'1820E643-4883-44BA-9F11-F3BFACACDEC4'  # mid UUID    [111:147]
TMPL_SUFFIX_UUID = b'F6936DDB-D9D7-4C01-ACF9-CBCE247FD559'  # suffix UUID [1170:1206]

# Byte positions of 2-byte length varints that span the RTF region.
# ALL 8 must be adjusted by (new_rtf_len - template_rtf_len) when RTF changes.
# Found by walking every nested length-delimited field that contains [RTF_START:RTF_END].
VARINT_POSITIONS = [
    ( 45,  47),  # depth=0 field10 len=1163 — outermost slide body
    ( 93,  95),  # depth=1 field23 len=1115
    ( 96,  98),  # depth=2 field2  len=1112
    ( 99, 101),  # depth=3 field1  len=1105
    (102, 104),  # depth=4 field1  len=1035
    (105, 107),  # depth=5 field1  len=1008
    (463, 465),  # depth=6 field13 len= 628
    (696, 698),  # depth=7 field5  len= 356 ← DIRECT RTF CONTAINER
]

# When chord data is inserted into the Attributes block (before RTF), only the OUTER
# containers grow — NOT field5, which holds the RTF exclusively.
# Use this shorter list for the chord-delta varint update pass.
CHORD_VARINT_POSITIONS = VARINT_POSITIONS[:-1]   # all except field5 (696,698)

RTF_START = 698   # byte offset of RTF within the Outdoor template slide blob
RTF_END   = 1054  # exclusive (template RTF = 356 bytes)

# Position of Text.Attributes field (field 3) length varint in the template.
# Attributes content: [468:650] (182 bytes).  Chord entries appended at byte 650.
_ATTR_LEN_POS = 466   # start of 2-byte length varint for Attributes
_ATTR_LEN_END = 468   # end of that varint
_ATTR_END     = 650   # end of Attributes content (= 468 + 182)

# --- Template slide bytes (embedded — no external file dependency) ---
# Extracted from: Washed - Elevation Worship2ndedit.pro, slide 14 ("oh hallelujah")
# CCOB Outdoor format: TungstenNarrow-Bold, fs502, slleading862, Outdoor position data
_TEMPLATE_HEX = (
    '0a260a2435343645413739382d443037382d343146462d383737342d44333035393241314536'
    '383128014200528b090a260a2434323636413846452d353445352d343833432d383545312d39'
    '31453833333146354144393001480bba01db0812d8080ad1080a8b080af0070a260a24313832'
    '30453634332d343838332d343442412d394631312d463342464143414344454334120d4c696e'
    '652031204c696e6520321a280a1209f85937988854324011602663c7670f4b4012120930453e'
    'bb5b8d9d4011cec2b7fccc90884029000000000000f03f429201080112060a0012001a001221'
    '0a0909000000000000f03f120909000000000000f03f1a0909000000000000f03f123c0a1209'
    '000000000000f03f11000000000000f03f121209000000000000f03f11000000000000f03f1a'
    '1209000000000000f03f11000000000000f03f12210a0911000000000000f03f120911000000'
    '000000f03f1a0911000000000000f03f1a0208014a090a05250000803f2001521f1100000000'
    '000008401a140d0000803f150000803f1d0000803f250000803f5a2b110000000000b0734019'
    '00000000000014402100000000000014402a05250000803f31000000000000e83f620911e3ba'
    '5a102bd4e13f6af4041ab6010a2f0a1354756e677374656e4e6172726f772d426f6c64110000'
    '000000606f404a0f54756e677374656e204e6172726f7710011a140d0000803f15ffff7f3f1d'
    'ffff7f3f250000803f2200321f080229000000000000f03f39000000000000f03f41cdcccccc'
    'cc8c45406a003900000000000010404a006a060a02100d10016a350a02100d622f0a1354756e'
    '677374656e4e6172726f772d426f6c64110000000000606f404a0f54756e677374656e204e61'
    '72726f77222b110000000000b07340190000000000002e402100000000000024402a05250000'
    '803f31000000000000e83f2ae4027b5c727466315c616e73695c616e7369637067313235325c'
    '636f636f61727466323837300a5c636f636f61746578747363616c696e67305c636f636f6170'
    '6c6174666f726d307b5c666f6e7474626c5c66305c666e696c5c666368617273657430205475'
    '6e677374656e4e6172726f772d426f6c643b7d0a7b5c636f6c6f7274626c3b5c726564323535'
    '5c677265656e3235355c626c75653235353b5c7265643235355c677265656e3235355c626c75'
    '653235353b7d0a7b5c2a5c657870616e646564636f6c6f7274626c3b3b5c6373737267625c63'
    '3130303030305c633130303030305c633130303030303b7d0a5c706172645c736c32305c736c'
    '6c656164696e673836325c7061726469726e61747572616c5c71635c7061727469676874656e'
    '666163746f72300a0a5c66305c6673353032205c636632205c6b65726e696e67315c6578706e'
    '6431365c6578706e64747738300a6f682068616c6c656c756a61687d3001420048015a072020'
    'e280a2202062161a140d3f357e3f155c8f423f1d6f12033d250000803f721408011100000000'
    '000020c01900000000008040c020034a1411000000000000e03f1801214281cb541d12ab3f2a'
    '05250000803f3212090000000000009e40110000000000e090403a260a244636393336444442'
    '2d443944372d344330312d414346392d434243453234374644353539220218016001'
)

LYRIC_TEMPLATE = bytes.fromhex(_TEMPLATE_HEX.replace(' ', '').replace('\n', ''))
_rtf_tag = b'{\\rtf1'
assert len(LYRIC_TEMPLATE) == 1212 and LYRIC_TEMPLATE.find(_rtf_tag) == RTF_START, \
    f"Template size={len(LYRIC_TEMPLATE)}, RTF at {LYRIC_TEMPLATE.find(_rtf_tag)} — expected 1212 / {RTF_START}"


def _build_chord_attr_bytes(chord_positions):
    """
    Encode chord CustomAttribute protobuf entries for Text.Attributes (field 13).

    chord_positions : dict {char_pos: chord_name}  (from _map_chord_positions)
    Returns bytes to append inside the Attributes message.

    Structure per chord:
      Attributes.CustomAttributes (field 13, LV) {
          CustomAttribute.Range (field 1, LV) {
              IntRange.Start (field 1, varint)
              IntRange.End   (field 2, varint)
          }
          CustomAttribute.Chord (field 7, LV string)
      }
    """
    if not chord_positions:
        return b''
    items = sorted(chord_positions.items())
    result = b''
    for i, (start_pos, chord_name) in enumerate(items):
        end_pos = items[i + 1][0] if i + 1 < len(items) else start_pos + len(chord_name)
        int_range = (encode_varint((1 << 3) | 0) + encode_varint(start_pos) +
                     encode_varint((2 << 3) | 0) + encode_varint(end_pos))
        ca = encode_lv(1, int_range) + encode_lv(7, chord_name.encode('utf-8'))
        result += encode_lv(13, ca)
    return result


def build_slide(line1, line2=None, chord_positions=None):
    """
    Build a binary slide blob for one or two lyric lines.
    chord_positions : optional dict {char_pos: chord_name} for Vocals+Chords version.
    Returns (slide_bytes, slide_uuid_str).
    """
    new_slide_uid  = new_uuid().encode('ascii')
    new_elem_uid1  = new_uuid().encode('ascii')
    new_uuid_mid   = new_uuid().encode('ascii')
    new_suffix_uid = new_uuid().encode('ascii')

    new_rtf   = build_rtf(line1, line2)
    rtf_delta = len(new_rtf) - (RTF_END - RTF_START)

    # Replace all four source UUIDs (each appears exactly once in the template)
    sb = LYRIC_TEMPLATE
    sb = sb.replace(TMPL_SLIDE_UUID,  new_slide_uid)
    sb = sb.replace(TMPL_ELEM_UUID1,  new_elem_uid1)
    sb = sb.replace(TMPL_UUID_MID,    new_uuid_mid)
    sb = sb.replace(TMPL_SUFFIX_UUID, new_suffix_uid)
    sb = bytearray(sb)

    # Swap in the new RTF block
    sb = bytearray(bytes(sb[:RTF_START]) + new_rtf + bytes(sb[RTF_END:]))

    # Update all spanning varints for the RTF size change
    for vpos, vend in VARINT_POSITIONS:
        old_val, _ = decode_varint(sb, vpos)
        new_val    = old_val + rtf_delta
        new_bytes  = encode_varint(new_val)
        while len(new_bytes) < (vend - vpos):
            new_bytes = new_bytes[:-1] + bytes([new_bytes[-1] | 0x80, 0x00])
        sb[vpos:vend] = new_bytes[: vend - vpos]

    # Inject chord CustomAttribute entries into Text.Attributes (before RTF)
    if chord_positions:
        chord_bytes = _build_chord_attr_bytes(chord_positions)
        chord_delta = len(chord_bytes)

        # Insert at end of Attributes content (right before RTF field tag)
        sb = bytearray(bytes(sb[:_ATTR_END]) + chord_bytes + bytes(sb[_ATTR_END:]))

        # Update Attributes length varint (2-byte slot)
        old_len, _ = decode_varint(sb, _ATTR_LEN_POS)
        new_len    = old_len + chord_delta
        nb = encode_varint(new_len)
        while len(nb) < (_ATTR_LEN_END - _ATTR_LEN_POS):
            nb = nb[:-1] + bytes([nb[-1] | 0x80, 0x00])
        sb[_ATTR_LEN_POS:_ATTR_LEN_END] = nb[:_ATTR_LEN_END - _ATTR_LEN_POS]

        # Update outer spanning varints (excludes the direct RTF container).
        # Varints at positions >= _ATTR_END have physically shifted by chord_delta.
        for vpos, vend in CHORD_VARINT_POSITIONS:
            actual_vpos = vpos + chord_delta if vpos >= _ATTR_END else vpos
            actual_vend = vend + chord_delta if vend  > _ATTR_END else vend
            old_val, _ = decode_varint(sb, actual_vpos)
            new_val    = old_val + chord_delta
            new_bytes  = encode_varint(new_val)
            while len(new_bytes) < (actual_vend - actual_vpos):
                new_bytes = new_bytes[:-1] + bytes([new_bytes[-1] | 0x80, 0x00])
            sb[actual_vpos:actual_vend] = new_bytes[: actual_vend - actual_vpos]

    return bytes(sb), new_slide_uid.decode('ascii')


# ────────────────────────────────────────────────────────────────
# GROUP / ARRANGEMENT BUILDERS
# ────────────────────────────────────────────────────────────────

def build_group(group_uuid, group_name, slide_uuids):
    """
    Build a field-12 group blob.
      group_uuid  : str UUID for this section
      group_name  : str label shown in ProPresenter ("Verse 1", "Chorus", …)
      slide_uuids : list of str UUIDs of the slides in this section
    """
    inner  = encode_lv(1, encode_lv(1, group_uuid.encode('ascii')))
    if group_name:
        inner += encode_lv(2, group_name.encode('utf-8'))
    inner += encode_lv(4, b'')        # empty field4 (required marker)
    field1 = encode_lv(1, inner)

    slide_refs = b''.join(
        encode_lv(2, encode_lv(1, uid.encode('ascii')))
        for uid in slide_uuids
    )
    return field1 + slide_refs


def build_arrangement(arr_uuid, arr_name, group_uuids):
    """Build a field-11 arrangement blob."""
    c  = encode_lv(1, encode_lv(1, arr_uuid.encode('ascii')))
    c += encode_lv(2, arr_name.encode('utf-8'))
    for g in group_uuids:
        c += encode_lv(3, encode_lv(1, g.encode('ascii')))
    return c


# ────────────────────────────────────────────────────────────────
# STATIC FILE METADATA  (copied from working songs)
# ────────────────────────────────────────────────────────────────

# ProPresenter file version/platform header (field 1)
FILE_META_HEX      = '08011206081a100518011801220f081510032209333532353138313738'
# Audio settings (field 8) — matches working CCOB songs
AUDIO_SETTINGS_HEX = '0a001801'
# Presentation flag (field 9)
FLAG9_HEX          = '1801'


# ────────────────────────────────────────────────────────────────
# .PRO FILE BUILDER
# ────────────────────────────────────────────────────────────────

def lines_to_slides(lines):
    """
    Convert a section's slide list into (line1, line2?) tuples for build_slide().

    Each entry in `lines` is ONE slide:
      "A single line"         → (line, None)   — one-line slide
      ("Line 1", "Line 2")   → (line1, line2)  — explicit two-line slide with hard break
    """
    slides = []
    for entry in lines:
        if isinstance(entry, tuple):
            slides.append(entry)          # explicit 2-line slide
        else:
            slides.append((entry, None))  # single-line slide
    return slides


def build_pro_file(title, sections, arrangement_name="CCOB-Outdoor", chord_data=None):
    """
    Build the complete binary content of a .pro file.

    title        : str — song title (shown in ProPresenter)
    sections     : list of (section_name, [slide_entry, …])
                   Each slide_entry is a str (1-line) or tuple (2-line).
    arrangement_name : str — shown in ProPresenter arrangement picker
    chord_data   : optional list parallel to sections:
                   [(section_name, [{char_pos: chord_name}, …]), …]
                   One chord dict per slide; pass None or {} for slides with no chords.
    """
    song_uuid = new_uuid()
    arr_uuid  = new_uuid()

    # ── Top-level header fields ──────────────────────────────────
    out = b''
    out += encode_lv(1, bytes.fromhex(FILE_META_HEX))
    out += encode_lv(2, b'\x0a\x24' + song_uuid.encode('ascii'))
    out += encode_lv(3, title.encode('utf-8'))
    out += encode_lv(8, bytes.fromhex(AUDIO_SETTINGS_HEX))
    out += encode_lv(9, bytes.fromhex(FLAG9_HEX))

    # Build a flat list of chord dicts aligned to each section's slides
    chord_lookup = []  # list of {char_pos: chord} per slide, in section order
    if chord_data:
        for _, slide_chord_dicts in chord_data:
            chord_lookup.extend(slide_chord_dicts)

    # ── Build slides per section ─────────────────────────────────
    groups      = []   # (group_uuid, group_name, [slide_uuids])
    all_slides  = {}   # slide_uuid → slide_bytes
    slide_index = 0    # index into chord_lookup

    for section_name, lyric_lines in sections:
        group_uuid  = new_uuid()
        slide_uuids = []
        for line1, line2 in lines_to_slides(lyric_lines):
            chord_pos = chord_lookup[slide_index] if chord_lookup else None
            slide_bytes, slide_uid = build_slide(line1, line2, chord_positions=chord_pos)
            slide_uuids.append(slide_uid)
            all_slides[slide_uid] = slide_bytes
            slide_index += 1
        groups.append((group_uuid, section_name, slide_uuids))

    # ── field 11 : arrangement ───────────────────────────────────
    group_uuids = [g[0] for g in groups]
    out += encode_lv(11, build_arrangement(arr_uuid, arrangement_name, group_uuids))

    # ── field 12 : groups ────────────────────────────────────────
    for gid, gname, slide_uids in groups:
        out += encode_lv(12, build_group(gid, gname, slide_uids))

    # ── field 13 : slides ────────────────────────────────────────
    for _, _, slide_uids in groups:
        for uid in slide_uids:
            out += encode_lv(13, all_slides[uid])

    return out


# ════════════════════════════════════════════════════════════════
# ██  SONG DEFINITION  ██  ← EDIT THIS SECTION WITH YOUR LYRICS
# ════════════════════════════════════════════════════════════════
#
# Each section is:  ("Section Label", [slide, slide, ...])
#
# Each slide is either:
#   "A single line"           — one line fills the slide
#   ("Line 1", "Line 2")     — two lines with a hard break between them
#                               Use for short paired phrases that belong together.
#
# CCOB Outdoor guideline: keep each line under ~28 characters.
# Longer lines will auto-wrap in ProPresenter at an uncontrolled point.
# If a line is long, split it into a tuple at the natural breath/phrase break.
#
# ────────────────────────────────────────────────────────────────

SONG_TITLE = "Washed - Elevation Worship"

SONG_SECTIONS = [
    ("Chorus", [
        "I've been washed in the water,",  # ~30 chars — may wrap; split if needed
        "washed in the blood",
        "I'm as good as new,",
        "oh hallelujah",
        "I've been washed in the water,",
        "washed in the blood",
        "All because of You,",
        "oh hallelujah",
    ]),
    ("Verse 1", [
        "And I'm clean",
        "Sin was stained on me",
        "And shame was running deep",
        "Your love was spilled on Calvary",
        ("Oh hallelujah", "I'm clean"),    # ← hard break: short paired phrases
        "And God, how can it be?",
        "I'm ransomed and redeemed",
        "I'm standing in Your victory",
        "Oh hallelujah",
    ]),
    ("Verse 2", [
        "I'm clean",
        "It's not what I have done",
        "But what You've done for me",
        "You paid it all upon that tree",
        ("Oh hallelujah", "I'm clean"),    # ← hard break: short paired phrases
        "Your love has overcome",          # ← separate slides: too long together
        "And Your mercy is supreme",
        "I'm dancing in Your victory",
        "Oh hallelujah",
    ]),
    ("Bridge", [
        "'Cause You took away my shame",
        "And You nailed it to the cross",
        "You got me running out the grave",
        "Oh hallelujah, here I come",
    ]),
]

# ════════════════════════════════════════════════════════════════


def main():
    os.makedirs(SONGS_OUTPUT_DIR, exist_ok=True)
    out_path = os.path.join(SONGS_OUTPUT_DIR, f"{SONG_TITLE}.pro")

    print(f"Building '{SONG_TITLE}'...")
    data = build_pro_file(SONG_TITLE, SONG_SECTIONS)

    with open(out_path, 'wb') as f:
        f.write(data)

    total_slides = sum(len(lines) for _, lines in SONG_SECTIONS)
    print(f"  {total_slides} slides across {len(SONG_SECTIONS)} sections")
    print(f"  {len(data):,} bytes saved → {out_path}")


if __name__ == '__main__':
    main()
