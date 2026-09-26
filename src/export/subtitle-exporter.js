(function (root) {
  const MAX_FILENAME_LENGTH = 120;

  function formatTimestamp(startMs) {
    const milliseconds = Number(startMs);
    const totalSeconds = Number.isFinite(milliseconds) && milliseconds > 0 ? Math.floor(milliseconds / 1000) : 0;
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    const two = (value) => String(value).padStart(2, "0");
    return hours > 0 ? `${two(hours)}:${two(minutes)}:${two(seconds)}` : `${two(Math.floor(totalSeconds / 60))}:${two(seconds)}`;
  }

  function sanitizeFilename(title) {
    const safeTitle = String(title || "Subtitles")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim() || "Subtitles";
    const suffix = "_subtitles.md";
    const prefix = "SubTwin_";
    const maxTitleLength = MAX_FILENAME_LENGTH - prefix.length - suffix.length;
    return `${prefix}${safeTitle.slice(0, maxTitleLength)}${suffix}`;
  }

  function cleanHeading(value, fallback) {
    return String(value || fallback).replace(/[\r\n]+/g, " ").trim() || fallback;
  }

  function createMarkdown({ title, tracks, failedTracks = [] }) {
    const exported = Array.isArray(tracks) ? tracks : [];
    const failed = Array.isArray(failedTracks) ? failedTracks : [];
    const lines = [`# ${cleanHeading(title, "Subtitles")}`, "", "> Exported by SubTwin", ""];
    if (failed.length) {
      lines.push(`> Exported tracks: ${exported.map((track) => cleanHeading(track.label, track.language || track.id)).join(", ") || "none"}`);
      lines.push(`> Failed tracks: ${failed.map((track) => cleanHeading(track.label, track.id || "Unknown track")).join(", ")}`);
      lines.push("");
    }
    for (const track of exported) {
      lines.push(`## ${cleanHeading(track.label, track.language || track.id || "Subtitle track")}`, "");
      const cues = Array.isArray(track.cues) ? track.cues : [];
      for (const cue of cues) {
        const text = String(cue?.text ?? "");
        if (text.trim() === "") continue;
        lines.push(`### ${formatTimestamp(cue.startMs)}`, text, "");
      }
      lines.push("---", "");
    }
    return lines.join("\n").trimEnd() + "\n";
  }

  const api = { formatTimestamp, sanitizeFilename, createMarkdown };
  root.DualSubtitle = root.DualSubtitle || {};
  root.DualSubtitle.subtitleExporter = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
