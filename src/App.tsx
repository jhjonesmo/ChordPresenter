import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { open } from "@tauri-apps/api/dialog";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import {
  MAJOR_KEYS, MINOR_KEYS, analyzeKey, prefersFlats,
  semitonesBetween, shiftKey, toConcert, transposeChart,
} from "./music";
import { buildPrintHtml } from "./print";

// Sentinel used to join a slide's lyric lines into one exportable chart line
// when a slide has 2 lines (Edit .pro mode). U+E000 (Private Use Area) never
// appears in real lyric/chord text and — unlike U+2028/U+2029 — is NOT
// treated as a line break by Python's str.splitlines(), so it survives the
// splitlines() calls in ew_fetch.py/md_to_pro.py intact and lets md_to_pro.py
// rebuild an explicit 2-line slide instead of splitting the lines into two
// separate 1-line slides. Must match SLIDE_LINE_SEP in md_to_pro.py.
const SLIDE_LINE_SEP = "\ue000";

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

// ── Types ─────────────────────────────────────────────────────────────────────
type Status     = "idle" | "running" | "ok" | "err";
type Mode       = "file" | "url" | "pro";
type OutputMode = "both" | "lyrics";

interface AppConfig {
  output_dir: string;
}

interface EwData {
  title: string;
  artist: string;
  key: string;
  capo?: number;
  chart_text: string;
  lyrics_only?: boolean;
  error?: string;
}

interface ProSlide {
  index: number;
  group: string;
  lines: string[];
  chords: string;
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
  // Capo the SOURCE chart was written for. The chart is converted to concert
  // pitch on load, so this is informational (and offered as an output capo).
  const [sourceCapo, setSourceCapo]   = useState(0);
  const [sourceShapes, setSourceShapes] = useState("");
  // Capo for the OUTPUT: chords are written as shapes for (key − capo).
  const [outputCapo, setOutputCapo]   = useState(0);
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

  // ── Pro edit mode state ────────────────────────────────────────
  const [proPath, setProPath]     = useState("");
  const [proTitle, setProTitle]   = useState("");
  const [proSlides, setProSlides] = useState<ProSlide[]>([]);
  const [proLoading, setProLoading] = useState(false);

  // ── Switch mode ────────────────────────────────────────────────
  const switchMode = useCallback((m: Mode) => {
    setMode(m); setStatus("idle"); setMessage("");
  }, []);

  // ── Shared: key/capo from a freshly loaded chart ───────────────
  // Charts written for a capo are converted to concert pitch on load, so the
  // preview, the Key picker, and what Python receives as --source-key all
  // describe the same chords. Output capo starts at 0 (concert chords, which
  // electric/keys need); the source capo is offered as a one-click option.
  const applyKeyInfo = useCallback((info: ReturnType<typeof analyzeKey>) => {
    setDetectedKey(info.concertKey); setTargetKey(info.concertKey);
    setSourceCapo(info.capo); setSourceShapes(info.capo ? info.chartKey : "");
    setOutputCapo(0);
  }, []);

  // ── File mode: load ────────────────────────────────────────────
  const loadFile = useCallback((path: string) => {
    setMdPath(path); setStatus("idle"); setMessage("");
    invoke<string>("read_file", { path })
      .then(content => {
        const meta = parseSongMeta(content);
        setTitle(meta.title || path.split("/").pop()?.replace(/\.md$/, "") || "");
        setArtist(meta.artist);
        const body = extractChartBody(content);
        const info = analyzeKey(content, body);
        applyKeyInfo(info);
        setFileChart(normalizeChartHeaders(toConcert(body, info)));
      })
      .catch(err => { setStatus("err"); setMessage(String(err)); });
  }, [applyKeyInfo]);

  // ── Pro edit mode: load .pro file ──────────────────────────────
  const loadProFile = useCallback(async (path: string) => {
    setProPath(path);
    setProLoading(true);
    setStatus("idle");
    setMessage("");
    setMode("pro");
    try {
      const jsonStr = await invoke<string>("parse_pro", { proPath: path });
      const data = JSON.parse(jsonStr);
      if (data.error) {
        setStatus("err");
        setMessage(`Parse error: ${data.error}`);
        setProLoading(false);
        return;
      }
      setProTitle(
        data.title || path.split("/").pop()?.replace(/\.pro$/, "") || ""
      );
      // group + chords come straight from parse_pro.py — chords are
      // pre-filled from whatever's already embedded on the source .pro so
      // untouched slides keep their existing chords instead of losing them
      // on export.
      setProSlides(
        (data.slides as { index: number; group: string; lines: string[]; chords: string }[]).map(s => ({
          index: s.index,
          group: s.group || "Slide",
          lines: s.lines,
          chords: s.chords || "",
        }))
      );
    } catch (err) {
      setStatus("err");
      setMessage(String(err));
    } finally {
      setProLoading(false);
    }
  }, []);

  // Tauri file-drop events — handles both .md and .pro
  useEffect(() => {
    const p1 = listen<string[]>("tauri://file-drop", e => {
      const pro = e.payload.find(f => f.endsWith(".pro"));
      const md  = e.payload.find(f => f.endsWith(".md"));
      setIsDragging(false);
      if (pro) {
        loadProFile(pro);
      } else if (md) {
        loadFile(md);
        setMode("file");
      }
    });
    const p2 = listen("tauri://file-drop-hover",     () => setIsDragging(true));
    const p3 = listen("tauri://file-drop-cancelled", () => setIsDragging(false));
    return () => { p1.then(f=>f()); p2.then(f=>f()); p3.then(f=>f()); };
  }, [loadFile, loadProFile]);

  const browseFile = useCallback(async () => {
    const sel = await open({ filters: [{ name: "Markdown", extensions: ["md"] }], multiple: false });
    if (typeof sel === "string") loadFile(sel);
  }, [loadFile]);

  const browseProFile = useCallback(async () => {
    const sel = await open({
      filters: [{ name: "ProPresenter", extensions: ["pro"] }],
      multiple: false,
    });
    if (typeof sel === "string") loadProFile(sel);
  }, [loadProFile]);

  const clearFile = useCallback(() => {
    setMdPath(""); setTitle(""); setArtist(""); setFileChart("");
    setDetectedKey(""); setTargetKey("");
    setSourceCapo(0); setSourceShapes(""); setOutputCapo(0);
    setSourceCapo(0); setSourceShapes(""); setOutputCapo(0);
    setStatus("idle"); setMessage("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearPro = useCallback(() => {
    setProPath(""); setProTitle(""); setProSlides([]);
    setStatus("idle"); setMessage("");
  }, []);

  const clearUrl = useCallback(() => {
    setUrlInput(""); setEwData(null); setEditedChart("");
    setDetectedKey(""); setTargetKey("");
    setSourceCapo(0); setSourceShapes(""); setOutputCapo(0);
    setStatus("idle"); setMessage("");
  }, []);

  // ── Pro edit mode: update chords for a slide ───────────────────
  const updateSlideChords = useCallback((index: number, chords: string) => {
    setProSlides(prev =>
      prev.map(s => s.index === index ? { ...s, chords } : s)
    );
  }, []);

  // ── Pro edit mode: export to .pro ─────────────────────────────
  const exportProChart = useCallback(async () => {
    if (!proSlides.length) return;

    // Build chord chart text.
    // A [GroupName] section header is emitted only when the group changes
    // from the previous slide, so consecutive slides that came from the same
    // original group (Verse 1, Chorus, etc.) stay together as one group on
    // export instead of every slide becoming its own "Slide N" group.
    // Re-emitting the header when a group name repeats later in the song
    // (e.g. a second "Chorus") correctly starts a new, separate group there
    // too — matching how the original file was structured.
    //
    // Slides with 2 lyric lines are joined with SLIDE_LINE_SEP so md_to_pro.py
    // reconstructs a single 2-line slide instead of splitting them into two
    // separate 1-line slides (see matching constant there).
    const chartLines: string[] = [];
    let prevGroup: string | null = null;
    for (const slide of proSlides) {
      const groupName = slide.group || "Slide";
      if (groupName !== prevGroup) {
        chartLines.push(`[${groupName}]`);
        prevGroup = groupName;
      }
      if (slide.chords.trim()) {
        chartLines.push(slide.chords.trim());
      }
      if (slide.lines.length > 1) {
        chartLines.push(slide.lines.join(SLIDE_LINE_SEP));
      } else {
        slide.lines.forEach(l => chartLines.push(l));
      }
      chartLines.push("");
    }
    const chartText = chartLines.join("\n").trimEnd();

    setStatus("running"); setMessage("Generating…");
    try {
      const out = await invoke<string>("generate_from_url", {
        title: proTitle,
        artist: "",
        chartText,
        targetKey: null,
        outputDir,
        lyricsOnly: false,
      });
      setStatus("ok");
      const match = out.match(/→\s+(.+\.pro)/);
      setMessage(match ? `Saved: ${match[1]}` : (out.trim() || "Done!"));
    } catch (err) {
      setStatus("err"); setMessage(String(err));
    }
  }, [proSlides, proTitle, outputDir]);

  const generateFromFile = useCallback(async () => {
    if (!mdPath) return;
    setStatus("running"); setMessage("Generating…");
    try {
      const out = await invoke<string>("generate_from_url", {
        title, artist,
        chartText: fileChart,
        targetKey: targetKey || null,
        sourceKey: detectedKey || null,
        capo: outputMode === "lyrics" ? 0 : outputCapo,
        outputDir,
        lyricsOnly: outputMode === "lyrics",
      });
      setStatus("ok");
      const match = out.match(/→\s+(.+\.pro)/);
      setMessage(match ? `Saved: ${match[1]}` : (out.trim() || "Done!"));
    } catch (err) {
      setStatus("err"); setMessage(String(err));
    }
  }, [mdPath, title, artist, fileChart, targetKey, detectedKey, outputCapo, outputDir, outputMode]);

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
        // Site key/capo win over what's written in the chart; chords fill in.
        const chart = data.chart_text || "";
        const info = analyzeKey(chart, chart, data.key || "", data.capo || 0);
        setEwData(data); setEditedChart(normalizeChartHeaders(toConcert(chart, info)));
        applyKeyInfo(info);
        setTitle(data.title || ""); setArtist(data.artist || "");
        if (data.lyrics_only) setOutputMode("lyrics");
      }
    } catch (err) {
      setStatus("err"); setMessage(String(err));
    } finally {
      setIsFetching(false);
    }
  }, [urlInput, applyKeyInfo]);

  const generateFromUrl = useCallback(async () => {
    if (!ewData) return;
    setStatus("running"); setMessage("Generating…");
    try {
      const out = await invoke<string>("generate_from_url", {
        title: ewData.title, artist: ewData.artist,
        chartText: editedChart, targetKey: targetKey || null,
        sourceKey: detectedKey || null,
        capo: outputMode === "lyrics" ? 0 : outputCapo,
        outputDir, lyricsOnly: outputMode === "lyrics",
      });
      setStatus("ok");
      const match = out.match(/→\s+(.+\.pro)/);
      setMessage(match ? `Saved: ${match[1]}` : (out.trim() || "Done!"));
    } catch (err) {
      setStatus("err"); setMessage(String(err));
    }
  }, [ewData, editedChart, targetKey, detectedKey, outputCapo, outputDir, outputMode]);

  // ── Shared: print chart (current key + capo, as the stage monitor shows) ─
  const printChart = useCallback(async () => {
    const chart = mode === "file" ? fileChart : editedChart;
    if (!chart.trim()) return;
    const key = targetKey || detectedKey;
    const capo = outputMode === "lyrics" ? 0 : outputCapo;
    let shapesKey = key, printed = chart;
    try {
      if (key && capo) shapesKey = shiftKey(key, -capo);
      if (detectedKey && shapesKey) {
        printed = transposeChart(chart, semitonesBetween(detectedKey, shapesKey), prefersFlats(shapesKey));
      }
    } catch { /* unknown key label — print the chart as-is */ }
    const songTitle = mode === "file" ? title : (ewData?.title || "");
    const songArtist = mode === "file" ? artist : (ewData?.artist || "");
    try {
      await invoke("open_print_view", {
        title: `${songTitle || "Chart"}${key ? ` - ${key}` : ""}${capo ? ` (Capo ${capo})` : ""}`,
        html: buildPrintHtml({ title: songTitle, artist: songArtist, key, capo, shapesKey, chart: printed }),
      });
    } catch (err) {
      setStatus("err"); setMessage(`Print failed: ${err}`);
    }
  }, [mode, fileChart, editedChart, targetKey, detectedKey, outputCapo, outputMode, title, artist, ewData]);

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

  const canPrint = Boolean((mode === "file" ? fileChart : editedChart).trim());

  // Key of the chord shapes written out for the current key + capo.
  let outputShapes = "";
  try {
    const k = targetKey || detectedKey;
    if (k && outputCapo) outputShapes = shiftKey(k, -outputCapo);
  } catch { /* unknown key label */ }

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
        <button className={`tab${mode === "pro" ? " active" : ""}`} onClick={() => switchMode("pro")}>
          ✏️ Edit .pro
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

      {/* ══ EDIT .pro MODE ═════════════════════════════════════════ */}
      {mode === "pro" && (
        <>
          {/* Drop / browse zone */}
          <div
            className={`drop-zone${isDragging ? " dragging" : ""}${proPath ? " loaded" : ""}`}
            onClick={!proPath ? browseProFile : undefined}
          >
            {proLoading ? (
              <div className="drop-prompt">
                <div className="drop-icon">⏳</div>
                <div className="drop-label">Reading file…</div>
                <div className="drop-sub">extracting slides from .pro</div>
              </div>
            ) : proPath ? (
              <div className="file-card">
                <div className="file-icon">🎼</div>
                <div className="file-meta">
                  <div className="file-song">{proTitle}</div>
                  <div className="file-name">{proPath.split("/").pop()}</div>
                </div>
                <button
                  className="clear-btn"
                  title="Remove"
                  onClick={e => { e.stopPropagation(); clearPro(); }}
                >✕</button>
              </div>
            ) : (
              <div className="drop-prompt">
                <div className="drop-icon">{isDragging ? "⬇️" : "🎼"}</div>
                <div className="drop-label">
                  {isDragging ? "Drop to load" : "Drop a .pro file here"}
                </div>
                <div className="drop-sub">or click to browse — add or edit chords per slide</div>
              </div>
            )}
          </div>

          {/* Slide editor */}
          {proSlides.length > 0 && (
            <>
              <div className="slide-list-header">
                <span className="slide-list-count">{proSlides.length} slides</span>
                <span className="slide-list-hint">Type chords above each lyric line</span>
              </div>
              <div className="slide-list">
                {proSlides.map((slide, i) => (
                  <div key={slide.index}>
                    {(i === 0 || proSlides[i - 1].group !== slide.group) && (
                      <div className="slide-group-header">{slide.group}</div>
                    )}
                    <div className="slide-card">
                      <div className="slide-num">Slide {i + 1}</div>
                      <div className="chord-row">
                        <input
                          className="chord-input"
                          type="text"
                          placeholder="A   E   F#m   D"
                          value={slide.chords}
                          onChange={e => updateSlideChords(slide.index, e.target.value)}
                          spellCheck={false}
                        />
                      </div>
                      <div className="lyric-lines">
                        {slide.lines.map((line, j) => (
                          <div className="lyric-line" key={j}>{line}</div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
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
                className={`generate-btn${(!hasOutputDir || status === "running") ? " disabled" : ""}`}
                onClick={exportProChart}
                disabled={!hasOutputDir || status === "running"}
              >
                {status === "running" ? "⏳  Generating…" : "Export .pro File →"}
              </button>
            </>
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
                <optgroup label="Major">
                  {MAJOR_KEYS.map(k => <option key={k} value={k}>{k}</option>)}
                </optgroup>
                <optgroup label="Minor">
                  {MINOR_KEYS.map(k => <option key={k} value={k}>{k}</option>)}
                </optgroup>
              </select>
              {detectedKey && (
                <span className="key-hint">
                  {targetKey && targetKey !== detectedKey
                    ? <>original <strong>{detectedKey}</strong> → transposing to <strong>{targetKey}</strong></>
                    : <>original key: <strong>{detectedKey}</strong></>}
                </span>
              )}
            </div>
          </div>
          {sourceCapo > 0 && (
            <p className="capo-source-note">
              Source chart was written for <strong>capo {sourceCapo}</strong> ({sourceShapes} shapes) —
              converted to concert pitch (<strong>{detectedKey}</strong>) so electric and keys can read it.
            </p>
          )}

          {/* Capo */}
          <div className={`field-row${outputMode === "lyrics" ? " field-disabled" : ""}`}>
            <label className="field-label">Capo</label>
            <div className="field-body">
              <select
                className="key-select capo-select"
                value={outputCapo}
                onChange={e => setOutputCapo(Number(e.target.value))}
                disabled={outputMode === "lyrics"}
              >
                <option value={0}>No capo</option>
                {Array.from({ length: 9 }, (_, i) => i + 1).map(n => (
                  <option key={n} value={n}>Capo {n}</option>
                ))}
              </select>
              {outputCapo > 0 && outputShapes ? (
                <span className="key-hint">
                  chords shown as <strong>{outputShapes}</strong> shapes · first slide gets a capo note
                </span>
              ) : sourceCapo > 0 && outputMode !== "lyrics" ? (
                <button className="link-btn" onClick={() => setOutputCapo(sourceCapo)}>
                  Use original capo {sourceCapo}
                </button>
              ) : null}
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
          <div className="action-row">
            <button
              className={`generate-btn${!canGenerate ? " disabled" : ""}`}
              onClick={mode === "file" ? generateFromFile : generateFromUrl}
              disabled={!canGenerate}
              title={!hasOutputDir ? "Set an output folder in Preferences first" : undefined}
            >
              {status === "running" ? "⏳  Generating…" : "Generate .pro File →"}
            </button>
            <button
              className={`print-btn${!canPrint ? " disabled" : ""}`}
              onClick={printChart}
              disabled={!canPrint}
              title="Print the chart in the selected key and capo for rehearsal"
            >
              🖨 Print
            </button>
          </div>
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
