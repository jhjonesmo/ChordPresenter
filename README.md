# ChordPresenter

ChordPresenter was created to streamline the process of creating ProPresenter files that have embedded chord charts in them. While there are many online resources for finding chord charts for popular songs, there is no easy way to get those into your Stage Monitor on ProPresenter.

I have spent years in tech and was not able to find a solution, so I decided to make one. This is a simple app built on [Tauri](https://tauri.app) for macOS. I may later add Windows support if there is interest.

There are two ways of creating the `.pro` files. The first is through the [Obsidian Clipper](https://obsidian.md/clipper) browser extension, which creates Markdown files of pages with chords and lyrics. Simply navigate to the page your song is on, clip the file to a folder, then drag and drop it into ChordPresenter. It will give a preview of what will be imported into ProPresenter. The second method is to copy and paste the link to the song into the URL Fetch tab. It will parse the information, give a preview, and output it to your desired directory.

ChordPresenter can also transpose keys — it auto-detects the source key and lets you target any key you need.

There is only one built-in theme, but once inside ProPresenter you can change it to your preferred look.

This is a work in progress, so there may be some reflowing that needs to be done for the slides. This is just a fun side project for me — I first love the Church and also have an affinity for tech. It is free to use and always will be. Please feel free to let me know if you have issues; there is a logging system built in as well.

*#forthekingdom*

---

## Supported Sites

| Site | Output |
|---|---|
| EssentialWorship.com | Chords + Lyrics |
| WorshipTogether.com | Chords + Lyrics |
| WorshipChords.com | Chords + Lyrics |
| WorshipChords.net | Chords + Lyrics |
| E-Chords.com | Chords + Lyrics |
| Ultimate Guitar | Chords + Lyrics |
| Genius.com | Lyrics Only |
| AllChristianSongsLyrics.com | Lyrics Only |
| AZLyrics, LyricsFreak, SongLyrics | Lyrics Only |

---

## Notes

This is a work in progress — some reflowing of slides may be needed depending on lyric line length. There is a logging system built in, so if you run into issues please feel free to report them.

This is a free side project and always will be. First love the Church, second love tech.

*#forthekingdom*

---

## Build From Source

Requires: Rust toolchain, Node + pnpm, Xcode CLI tools, Python 3. macOS only — cannot cross-compile.

```bash
cd ChordPresenter
pnpm tauri dev       # dev mode with hot reload
pnpm tauri build     # production .dmg
```

---

## Python Scripts

The `.pro` generation pipeline:

| Script | Role |
|---|---|
| `md_to_pro.py` | Parses `.md` chord charts → ProPresenter `.pro` binary |
| `ew_fetch.py` | Fetches URLs, dispatches site-specific parser, calls md_to_pro |
| `create_pro_song.py` | Low-level protobuf builder (RTF + chord attributes) |

---

## Pending / Future

- **Windows support**: Handle cross-platform temp paths and Python command name
- **Paste mode**: Paste raw lyrics/chord text directly without a URL or file
- **Additional site parsers**: Genius and AllChristianSongsLyrics need further testing
