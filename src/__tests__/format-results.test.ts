import { formatResults, parseInput } from "../index"

const trim = parseInput("https://example.com/video")
const settings = {} as Parameters<typeof formatResults>[2]
const info = {
  title: "Example video",
  formats: [
    { format_id: "v1", vcodec: "h264", acodec: "none", width: 1280, height: 720, tbr: 500, ext: "mp4" },
    { format_id: "v2", vcodec: "h264", acodec: "none", width: 640, height: 360, tbr: 200, ext: "mp4" },
    { format_id: "a1", vcodec: "none", acodec: "aac", tbr: 128, ext: "m4a" },
    { format_id: "a2", vcodec: "none", acodec: "aac", tbr: 64, ext: "m4a" }
  ]
}

test("video filter shows the best format once and concise quality labels", () => {
  const rows = formatResults(info, "https://example.com/video", settings, "yt-dlp", "ffmpeg", trim, "video")
  expect(rows.map(row => row.Title)).toEqual(["1280×720", "640×360"])
  expect(rows[0].SubTitle).toBe("500 kbps")
  expect(rows[0].Tails?.map(tail => tail.Text)).toContain("i18n:format_best")
  expect(rows[1].SubTitle).toBe("200 kbps")
  expect(new Set(rows.map(row => row.IdentityKey)).size).toBe(rows.length)
})

test("audio filter retains the best and other audio formats", () => {
  const rows = formatResults(info, "https://example.com/video", settings, "yt-dlp", "ffmpeg", trim, "audio", "音频")
  expect(rows.map(row => row.Title)).toEqual(["音频 · 128 kbps", "音频 · 64 kbps"])
  expect(rows[0].Tails?.map(tail => tail.Text)).toContain("i18n:format_best")
})
import { parseDownloadProgress } from "../index"

test("parses yt-dlp progress without including unavailable fields", () => {
  expect(parseDownloadProgress("VD_PROGRESS  42.5%| 2.1MiB/s| 00:12")).toBe("42.5% · 2.1MiB/s · 00:12")
  expect(parseDownloadProgress("VD_PROGRESS 100%|N/A|N/A")).toBe("100%")
  expect(parseDownloadProgress("ordinary yt-dlp output")).toBe("")
})

test("groups video formats before audio", () => {
  const rows = formatResults(info, "https://example.com/video", settings, "yt-dlp", "ffmpeg", trim, "all", "Audio", "Video")
  const video = rows.filter(row => row.IdentityKey?.includes("v1") || row.IdentityKey?.includes("v2"))
  const audio = rows.filter(row => row.IdentityKey?.includes("a1") || row.IdentityKey?.includes("a2"))
  expect(video[0].Title).toBe("1280×720")
  expect(video[0].Score!).toBeGreaterThan(video[1].Score!)
  expect(video[1].Score!).toBeGreaterThan(audio[0].Score!)
  expect(video.every(row => row.Group === "Video" && row.GroupScore === 200)).toBe(true)
  expect(audio.every(row => row.Group === "Audio" && row.GroupScore === 100)).toBe(true)
  const download = video[0].Actions![0]
  if (download.Type === "form") throw new Error("Expected execute action")
  expect(download.PreventHideAfterAction).toBe(true)
})

test("same resolution selects the higher bitrate and labels it best", () => {
  const source = {
    formats: [
      { format_id: "low", vcodec: "h264", acodec: "none", resolution: "1024x576", tbr: 841, ext: "mp4" },
      { format_id: "high", vcodec: "h264", acodec: "none", width: 1024, height: 576, tbr: 2176, ext: "mp4" },
      { format_id: "sd", vcodec: "h264", acodec: "none", width: 640, height: 360, tbr: 500, ext: "mp4" }
    ]
  }
  const rows = formatResults(source, "https://example.com/video", settings, "yt-dlp", "ffmpeg", trim, "video")
  expect(rows).toHaveLength(2)
  expect(rows[0].Title).toBe("1024×576")
  expect(rows[0].SubTitle).toBe("2176 kbps")
  expect(rows[0].IdentityKey).toContain("high")
  expect(rows[0].Tails?.map(tail => tail.Text)).toEqual(["i18n:format_best", "mp4"])
})

test("recognizes X HTTP video without codec metadata and selects its higher bitrate", () => {
  const source = {
    formats: [
      { format_id: "http-2176", resolution: "576x1024", width: 576, height: 1024, tbr: 2176, ext: "mp4" },
      { format_id: "hls-887", resolution: "576x1024", width: 576, height: 1024, tbr: 887.035, ext: "mp4", vcodec: "avc1.64001f", acodec: "none" },
      { format_id: "http-950", resolution: "480x852", width: 480, height: 852, tbr: 950, ext: "mp4" },
      { format_id: "hls-audio-128000", resolution: "audio only", tbr: 128, ext: "mp4", vcodec: "none" }
    ]
  }
  const rows = formatResults(source, "https://example.com/video", settings, "yt-dlp", "ffmpeg", trim, "all")
  const videos = rows.filter(row => row.IdentityKey?.includes("http-"))
  expect(videos).toHaveLength(2)
  expect(videos[0].IdentityKey).toContain("http-2176")
  expect(videos[0].SubTitle).toBe("2176 kbps")
  expect(videos[0].Tails?.map(tail => tail.Text)).toContain("i18n:format_best")
  const audio = rows.filter(row => row.IdentityKey?.includes("hls-audio"))
  expect(audio[0].Tails?.map(tail => tail.Text)).toContain("i18n:format_best")
})
