import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { open } from "@tauri-apps/api/dialog";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

// ── Key detection (mirrors Python _detect_key logic) ────────────────────────
const CHORD_TOKEN = /^[A-G][#b]?(m(?!aj|in)|maj|min|dim|aug|°|ø)?(7|9|11|13|6|5|4|2)?(sus[24]?|add[29]?)?(\/?[A-G][#b]?)?$/;

const ENH: Record<string, string> = {
  'C#':'Db','Db':'C#','D#':'Eb','Eb':'D#',
  'F#':'Gb','Gb':'F#','G#':'Ab','Ab':'G#','A#':'Bb','Bb':'A#',
};

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

function detectKey(mdContent: string): string {
  // Priority 1: explicit "Key: X" line anywhere in the file.
  // Handles "Key: BCapo: 4th fret" (missing space before Capo).
  const keyLineMatch = mdContent.match(/Key:\s*([A-G][#b]?)/);
  if (keyLineMatch) return keyLineMatch[1];

  // Priority 2: chord-quality diatonic matching over the whole chart.
  const codeMatch = mdContent.match(/```\s*\n([\s\S]*?)```/);
  const body = codeMatch ? codeMatch[1] : mdContent.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
  const normChords: string[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tokens = trimmed.replace(/[|/\-.]/g, " ").split(/\s+/).filter(Boolean);
    if (tokens.length > 0 && tokens.every(t => CHORD_TOKEN.test(t))) {
      tokens.forEach(t => { const n = normChord(t); if (n) normChords.push(n); });
    }
  }
  return keyFromChords(normChords);
}

function parseSongMeta(mdContent: string): { title: string; artist: string } {
  const m = mdContent.match(/^title:\s*"([^"]+)"/m);
  if (!m) return { title: "", artist: "" };
  const parts = m[1].split("|").map(p => p.trim());
  const title = parts[0].replace(/\s*\|\s*chords.*/i, "").trim();
  const artist = parts[1] && !/^chords/i.test(parts[1]) ? parts[1] : "";
  return { title, artist };
}

/** Extract the chart body from an MD file for preview/editing.
 *  Tries the ``` code block first, then falls back to stripping frontmatter. */
function extractChartBody(mdContent: string): string {
  const codeMatch = mdContent.match(/```[^\n]*\n([\s\S]*?)```/);
  if (codeMatch) return codeMatch[1].trim();
  // Fallback: strip YAML frontmatter and leading blank lines
  return mdContent.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").trim();
}

/**
 * Normalise section headers in a chart body so the preview shows what
 * ProPresenter will actually receive, matching the Python parser's output.
 *
 * Rules (applied per line, non-indented lines only):
 *  [VERSE 1] / [chorus]     → [Verse 1] / [Chorus]   (bracket + title-case)
 *  First Verse / Second Chorus → [Verse 1] / [Chorus 2]  (ordinal words)
 *  Verse 1: / CHORUS        → [Verse 1] / [Chorus]   (named without brackets)
 */
function normalizeChartHeaders(chart: string): string {
  const ORDINAL_MAP: Record<string, string> = {
    first:'1', second:'2', third:'3', fourth:'4', fifth:'5',
    sixth:'6', seventh:'7', eighth:'8', ninth:'9', tenth:'10',
  };
  const SECTION_WORDS =
    'intro|verse|chorus|pre[\\s\\-]?chorus|bridge|tag|outro|interlude|' +
    'instrumental|ending|coda|hook|turn|turnaround|transition|vamp|breakdown|refrain';
  const ORDINAL_RE = new RegExp(
    `^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\\s+(${SECTION_WORDS})\\s*:?\\s*$`,
    'i'
  );
  const NAMED_RE = new RegExp(
    `^(${SECTION_WORDS})\\s*(\\d*)\\s*:?\\s*$`,
    'i'
  );

  return chart.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Already bracketed: normalise capitalisation of first word, preserve number.
    // [VERSE 1] → [Verse 1],  [chorus] → [Chorus],  [Pre-Chorus] → [Pre-Chorus]
    const bracketM = trimmed.match(/^\[([^\]]+)\](.*)/);
    if (bracketM) {
      const parts = bracketM[1].trim().split(/\s+/);
      const label = parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
      const rest  = parts.slice(1).join(' ');
      return `[${rest ? `${label} ${rest}` : label}]${bracketM[2]}`;
    }

    // Section headers are never indented — skip indented lines.
    if (line[0] === ' ' || line[0] === '\t') return line;

    // Ordinal: "First Verse" → "[Verse 1]"
    const ordM = trimmed.match(ORDINAL_RE);
    if (ordM) {
      const num = ORDINAL_MAP[ordM[1].toLowerCase()];
      const sec = ordM[2].charAt(0).toUpperCase() + ordM[2].slice(1).toLowerCase();
      return `[${sec} ${num}]`;
    }

    // Named without brackets: "Verse 1:" / "CHORUS" → "[Verse 1]" / "[Chorus]"
    const namedM = trimmed.match(NAMED_RE);
    if (namedM) {
      const sec = namedM[1].charAt(0).toUpperCase() + namedM[1].slice(1).toLowerCase();
      const num = namedM[2] ? ` ${namedM[2]}` : '';
      return `[${sec}${num}]`;
    }

    return line;
  }).join('\n');
}

// ── All keys ─────────────────────────────────────────────────────────────────
const ALL_KEYS = [
  "C","C#","Db","D","D#","Eb","E","F","F#","Gb","G","G#","Ab","A","A#","Bb","B",
  "Cm","C#m","Dm","Ebm","Em","Fm","F#m","Gm","G#m","Am","Bbm","Bm"
];

// ── Types ─────────────────────────────────────────────────────────────────────
type Status     = "idle" | "running" | "ok" | "err";
type Mode       = "file" | "url";
type OutputMode = "both" | "lyrics";

interface AppConfig {
  output_dir: string;
}

interface EwData {
  title: string;
  artist: string;
  key: string;
  chart_text: string;
  lyrics_only?: boolean;
  error?: string;
}

// ── Preferences panel ─────────────────────────────────────────────────────────
function PreferencesPanel({
  config,
  onSave,
  onClose,
}: {
  config: AppConfig;
  onSave: (c: AppConfig) => void;
  onClose: () => void;
}) {
  const [local, setLocal]     = useState<AppConfig>({ ...config });
  const [logPath, setLogPath] = useState("");
  const [logs, setLogs]       = useState("");
  const [tab, setTab]         = useState<"folders" | "log">("folders");

  useEffect(() => {
    invoke<string>("get_log_path").then(setLogPath);
    if (tab === "log") invoke<string>("get_recent_logs").then(setLogs);
  }, [tab]);

  const browse = async () => {
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel === "string") setLocal(prev => ({ ...prev, output_dir: sel }));
  };

  const save = async () => {
    await invoke("save_config", { outputDir: local.output_dir });
    onSave(local);
    onClose();
  };

  const clearLog = async () => {
    await invoke("clear_log");
    setLogs("");
  };

  const shortPath = (p: string) =>
    p ? `…/${p.split("/").slice(-2).join("/")}` : "";

  const FIELDS: { key: keyof AppConfig; label: string; hint: string }[] = [
    { key: "output_dir", label: "Output Folder", hint: "ProPresenter-watched folder where .pro files are saved" },
  ];

  return (
    <div className="prefs-backdrop" onClick={onClose}>
      <div className="prefs-panel" onClick={e => e.stopPropagation()}>

        <div className="prefs-header">
          <h2 className="prefs-title">Preferences</h2>
          <button className="prefs-close" onClick={onClose}>✕</button>
        </div>

        {/* Tab bar */}
        <div className="prefs-tabs">
          <button className={`prefs-tab${tab === "folders" ? " active" : ""}`} onClick={() => setTab("folders")}>Folders</button>
          <button className={`prefs-tab${tab === "log"     ? " active" : ""}`} onClick={() => setTab("log")}>Log</button>
        </div>

        {/* Folders tab */}
        {tab === "folders" && (
          <div className="prefs-body">
            {FIELDS.map(({ key, label, hint }) => (
              <div className="prefs-row" key={key}>
                <div className="prefs-row-top">
                  <span className="prefs-label">{label}</span>
                  <button className="prefs-browse" onClick={browse}>Browse…</button>
                </div>
                <div
                  className={`prefs-path${!local[key] ? " prefs-path--empty" : ""}`}
                  title={local[key] || ""}
                >
                  {local[key] ? shortPath(local[key]) : "Not set — click Browse"}
                </div>
                <div className="prefs-hint">{hint}</div>
              </div>
            ))}
            <div className="prefs-note">
              ℹ️ Python scripts are bundled inside the app — no configuration needed.
            </div>
          </div>
        )}

        {/* Log tab */}
        {tab === "log" && (
          <div className="prefs-body prefs-body--log">
            <div className="log-path" title={logPath}>Log file: {logPath || "—"}</div>
            <textarea
              className="log-textarea"
              readOnly
              value={logs || "(no log entries yet)"}
              spellCheck={false}
            />
            <button className="log-clear-btn" onClick={clearLog}>Clear Log</button>
          </div>
        )}

        <div className="prefs-footer">
          {tab === "folders" && <>
            <button className="prefs-cancel" onClick={onClose}>Cancel</button>
            <button className="prefs-save" onClick={save}>Save</button>
          </>}
          {tab === "log" && (
            <button className="prefs-cancel" onClick={onClose}>Close</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  // ── Config / prefs ────────────────────────────────────────────
  const [config, setConfig]       = useState<AppConfig>({ output_dir: "" });
  const [showPrefs, setShowPrefs] = useState(false);

  // Load config on startup; open prefs automatically if output folder not set
  useEffect(() => {
    invoke<AppConfig>("get_config").then(cfg => {
      setConfig(cfg);
      if (cfg.output_dir) setOutputDir(cfg.output_dir);
      else setShowPrefs(true);  // first run — prompt user to set output folder
    });
  }, []);

  // Listen for Preferences… menu item
  useEffect(() => {
    const unsub = listen("open-preferences", () => setShowPrefs(true));
    return () => { unsub.then(f => f()); };
  }, []);

  const handleConfigSave = (cfg: AppConfig) => {
    setConfig(cfg);
    if (cfg.output_dir) setOutputDir(cfg.output_dir);
  };

  // ── Shared state ──────────────────────────────────────────────
  const [mode, setMode]             = useState<Mode>("file");
  const [outputMode, setOutputMode] = useState<OutputMode>("both");
  const [detectedKey, setDetectedKey] = useState("");
  const [targetKey, setTargetKey]     = useState("");
  const [outputDir, setOutputDir]     = useState("");
  const [status, setStatus]           = useState<Status>("idle");
  const [message, setMessage]         = useState("");

  // ── File mode state ────────────────────────────────────────────
  const [mdPath, setMdPath]           = useState("");
  const [title, setTitle]             = useState("");
  const [artist, setArtist]           = useState("");
  const [fileChart, setFileChart]     = useState("");   // editable chart preview
  const [isDragging, setIsDragging]   = useState(false);

  // ── URL mode state ─────────────────────────────────────────────
  const [urlInput, setUrlInput]     = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const [ewData, setEwData]         = useState<EwData | null>(null);
  const [editedChart, setEditedChart] = useState("");

  // ── Switch mode ────────────────────────────────────────────────
  const switchMode = useCallback((m: Mode) => {
    setMode(m); setStatus("idle"); setMessage("");
  }, []);

  // ── File mode: load ────────────────────────────────────────────
  const loadFile = useCallback((path: string) => {
    setMdPath(path); setStatus("idle"); setMessage("");
    invoke<string>("read_file", { path })
      .then(content => {
        const meta = parseSongMeta(content);
        setTitle(meta.title || path.split("/").pop()?.replace(/\.md$/, "") || "");
        setArtist(meta.artist);
        const key = detectKey(content);
        setDetectedKey(key); setTargetKey(key);
        setFileChart(normalizeChartHeaders(extractChartBody(content)));
      })
      .catch(err => { setStatus("err"); setMessage(String(err)); });
  }, []);

  // Tauri file-drop events
  useEffect(() => {
    const p1 = listen<string[]>("tauri://file-drop", e => {
      const md = e.payload.find(f => f.endsWith(".md"));
      if (md) { loadFile(md); setIsDragging(false); switchMode("file"); }
    });
    const p2 = listen("tauri://file-drop-hover",     () => setIsDragging(true));
    const p3 = listen("tauri://file-drop-cancelled", () => setIsDragging(false));
    return () => { p1.then(f=>f()); p2.then(f=>f()); p3.then(f=>f()); };
  }, [loadFile, switchMode]);

  const browseFile = useCallback(async () => {
    const sel = await open({ filters: [{ name: "Markdown", extensions: ["md"] }], multiple: false });
    if (typeof sel === "string") loadFile(sel);
  }, [loadFile]);

  const clearFile = useCallback(() => {
    setMdPath(""); setTitle(""); setArtist(""); setFileChart("");
    setDetectedKey(""); setTargetKey("");
    setStatus("idle"); setMessage("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearUrl = useCallback(() => {
    setUrlInput(""); setEwData(null); setEditedChart("");
    setDetectedKey(""); setTargetKey("");
    setStatus("idle"); setMessage("");
  }, []);

  const generateFromFile = useCallback(async () => {
    if (!mdPath) return;
    setStatus("running"); setMessage("Generating…");
    try {
      const out = await invoke<string>("generate_from_url", {
        title, artist,
        chartText: fileChart,
        targetKey: targetKey || null,
        outputDir,
        lyricsOnly: outputMode === "lyrics",
      });
      setStatus("ok");
      const match = out.match(/→\s+(.+\.pro)/);
      setMessage(match ? `Saved: ${match[1]}` : (out.trim() || "Done!"));
    } catch (err) {
      setStatus("err"); setMessage(String(err));
    }
  }, [mdPath, title, artist, fileChart, targetKey, outputDir, outputMode]);

  // ── URL mode: fetch ────────────────────────────────────────────
  const fetchEW = useCallback(async () => {
    const url = urlInput.trim();
    if (!url) return;
    setIsFetching(true); setEwData(null); setStatus("idle"); setMessage("");
    try {
      const jsonStr = await invoke<string>("fetch_ew_preview", { url });
      const data: EwData = JSON.parse(jsonStr);
      if (data.error) {
        setStatus("err"); setMessage(`Fetch error: ${data.error}`);
      } else {
        // Use key from site metadata if available; otherwise detect from chart.
        const detectedFromChart = data.key ? "" : detectKey(data.chart_text || "");
        const resolvedKey = data.key || detectedFromChart;
        setEwData(data); setEditedChart(normalizeChartHeaders(data.chart_text || ""));
        setDetectedKey(resolvedKey); setTargetKey(resolvedKey);
        setTitle(data.title || ""); setArtist(data.artist || "");
        if (data.lyrics_only) setOutputMode("lyrics");
      }
    } catch (err) {
      setStatus("err"); setMessage(String(err));
    } finally {
      setIsFetching(false);
    }
  }, [urlInput]);

  const generateFromUrl = useCallback(async () => {
    if (!ewData) return;
    setStatus("running"); setMessage("Generating…");
    try {
      const out = await invoke<string>("generate_from_url", {
        title: ewData.title, artist: ewData.artist,
        chartText: editedChart, targetKey: targetKey || null,
        outputDir, lyricsOnly: outputMode === "lyrics",
      });
      setStatus("ok");
      const match = out.match(/→\s+(.+\.pro)/);
      setMessage(match ? `Saved: ${match[1]}` : (out.trim() || "Done!"));
    } catch (err) {
      setStatus("err"); setMessage(String(err));
    }
  }, [ewData, editedChart, targetKey, outputDir, outputMode]);

  // ── Shared: output folder ──────────────────────────────────────
  const browseOutput = useCallback(async () => {
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel === "string") setOutputDir(sel);
  }, []);

  // ── Derived ───────────────────────────────────────────────────
  const hasFile     = Boolean(mdPath);
  const fileName    = mdPath.split("/").pop() ?? "";
  const hasOutputDir = Boolean(outputDir);
  const canGenerate = hasOutputDir && (mode === "file"
    ? hasFile && Boolean(fileChart) && status !== "running"
    : Boolean(ewData) && !ewData?.error && status !== "running" && !isFetching);

  const showSharedControls = (mode === "file" && hasFile) || Boolean(ewData && !ewData.error);

  return (
    <div className="app">
      {/* ── Preferences overlay ── */}
      {showPrefs && (
        <PreferencesPanel
          config={config}
          onSave={handleConfigSave}
          onClose={() => setShowPrefs(false)}
        />
      )}

      {/* ── Header ── */}
      <header className="header">
        <div className="header-icon">🎵</div>
        <div>
          <h1 className="header-title">ChordPresenter</h1>
          <p className="header-sub">Chord charts → ProPresenter .pro files</p>
        </div>
      </header>

      {/* ── Mode tabs ── */}
      <div className="tabs">
        <button className={`tab${mode === "file" ? " active" : ""}`} onClick={() => switchMode("file")}>
          📄 File
        </button>
        <button className={`tab${mode === "url" ? " active" : ""}`} onClick={() => switchMode("url")}>
          🔗 URL
        </button>
      </div>

      {/* ══ FILE MODE ══════════════════════════════════════════════ */}
      {mode === "file" && (
        <>
          <div
            className={`drop-zone${isDragging ? " dragging" : ""}${hasFile ? " loaded" : ""}`}
            onClick={!hasFile ? browseFile : undefined}
          >
            {hasFile ? (
              <div className="file-card">
                <div className="file-icon">📄</div>
                <div className="file-meta">
                  <div className="file-song">{title || fileName}</div>
                  {artist && <div className="file-artist">{artist}</div>}
                  <div className="file-name">{fileName}</div>
                </div>
                <button className="clear-btn" title="Remove" onClick={e => { e.stopPropagation(); clearFile(); }}>✕</button>
              </div>
            ) : (
              <div className="drop-prompt">
                <div className="drop-icon">{isDragging ? "⬇️" : "📂"}</div>
                <div className="drop-label">{isDragging ? "Drop to load" : "Drop an .md file here"}</div>
                <div className="drop-sub">or click to browse</div>
              </div>
            )}
          </div>

          {/* Chart preview / edit — shown once a file is loaded */}
          {hasFile && fileChart && (
            <div className="chart-section">
              <div className="chart-label">Chart preview — edit before generating if needed:</div>
              <textarea
                className="chart-textarea"
                value={fileChart}
                onChange={e => setFileChart(e.target.value)}
                spellCheck={false}
              />
            </div>
          )}
        </>
      )}

      {/* ══ URL MODE ═══════════════════════════════════════════════ */}
      {mode === "url" && (
        <>
          <div className="url-row">
            <input
              className="url-input"
              type="url"
              placeholder="Paste a URL (EssentialWorship, WorshipTogether, Ultimate Guitar, WorshipChords, E-Chords…)"
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") fetchEW(); }}
            />
            <button
              className={`fetch-btn${isFetching || !urlInput.trim() ? " disabled" : ""}`}
              onClick={fetchEW}
              disabled={isFetching || !urlInput.trim()}
            >
              {isFetching ? "⏳" : "Fetch"}
            </button>
          </div>

          {ewData && !ewData.error && (
            <div className="ew-card">
              <div className="ew-card-icon">🎵</div>
              <div className="ew-card-meta">
                <div className="ew-title">{ewData.title || "Unknown Title"}</div>
                {ewData.artist && <div className="ew-artist">{ewData.artist}</div>}
              </div>
              <button className="clear-btn" title="Clear and start over" onClick={clearUrl}>✕</button>
            </div>
          )}

          {ewData && !ewData.error && (
            <div className="chart-section">
              <div className="chart-label">Chart preview — edit before generating if needed:</div>
              <textarea
                className="chart-textarea"
                value={editedChart}
                onChange={e => setEditedChart(e.target.value)}
                spellCheck={false}
              />
            </div>
          )}
        </>
      )}

      {/* ══ SHARED: KEY · SLIDES · OUTPUT · GENERATE ══════════════ */}
      {showSharedControls && (
        <>
          {/* Key */}
          <div className="field-row">
            <label className="field-label">Key</label>
            <div className="field-body">
              <select
                className="key-select"
                value={targetKey}
                onChange={e => setTargetKey(e.target.value)}
              >
                <option value="">-- auto-detect --</option>
                {ALL_KEYS.map(k => <option key={k} value={k}>{k}</option>)}
              </select>
              {detectedKey && (
                <span className="key-hint">
                  {targetKey && targetKey !== detectedKey
                    ? <>detected <strong>{detectedKey}</strong> → transposing to <strong>{targetKey}</strong></>
                    : <>detected: <strong>{detectedKey}</strong></>}
                </span>
              )}
            </div>
          </div>

          {/* Slides mode */}
          <div className="field-row">
            <label className="field-label">Slides</label>
            <div className="field-body">
              <div className="mode-toggle" role="group" aria-label="Slide output mode">
                <button
                  className={`toggle-btn${outputMode === "both" ? " active" : ""}`}
                  onClick={() => setOutputMode("both")}
                  disabled={status === "running"}
                  title="Include chord charts on stage monitor slides"
                >
                  Chords + Lyrics
                </button>
                <button
                  className={`toggle-btn${outputMode === "lyrics" ? " active" : ""}`}
                  onClick={() => setOutputMode("lyrics")}
                  disabled={status === "running"}
                  title="Lyrics-only slides"
                >
                  Lyrics Only
                </button>
              </div>
            </div>
          </div>

          {/* Output folder */}
          <div className="field-row">
            <label className="field-label">Output</label>
            <div className="field-body output-body">
              <span className="output-path" title={outputDir}>
                {outputDir
                  ? `…/${outputDir.split("/").slice(-2).join("/")}`
                  : <span className="output-unset">Not set — open Preferences</span>}
              </span>
              <button className="change-btn" onClick={browseOutput}>Change…</button>
            </div>
          </div>

          {/* Generate */}
          {!hasOutputDir && (
            <p className="no-output-warning">
              ⚠️ No output folder set.{" "}
              <button className="link-btn" onClick={() => setShowPrefs(true)}>
                Open Preferences
              </button>{" "}
              to choose where .pro files are saved.
            </p>
          )}
          <button
            className={`generate-btn${!canGenerate ? " disabled" : ""}`}
            onClick={mode === "file" ? generateFromFile : generateFromUrl}
            disabled={!canGenerate}
            title={!hasOutputDir ? "Set an output folder in Preferences first" : undefined}
          >
            {status === "running" ? "⏳  Generating…" : "Generate .pro File →"}
          </button>
        </>
      )}

      {/* ══ STATUS ═════════════════════════════════════════════════ */}
      {message && (
        <div className={`status ${status}`}>
          {status === "ok"  && <span className="status-icon">✅</span>}
          {status === "err" && <span className="status-icon">❌</span>}
          <span className="status-text">{message}</span>
        </div>
      )}
    </div>
  );
}
