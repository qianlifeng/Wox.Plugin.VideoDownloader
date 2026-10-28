import { execFile, spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { Context, Plugin, PublicAPI, Query, QueryResponse, Result, ResultAction, WoxImage } from "@wox-launcher/wox-plugin"
import { icons } from "./icons"
import { dependencyResult } from "./dependencies"

const exec = promisify(execFile)
const logo: WoxImage = { ImageType: "relative", ImageData: "images/app.svg" }
const settingKeys = [
  "download_path",
  "sorting_order",
  "preferred_video_format",
  "preferred_audio_format",
  "auto_open_folder",
  "overwrite_existing_files",
  "cookie_file_path",
  "trim_mode",
  "delete_original_after_trim"
] as const
type Settings = Record<(typeof settingKeys)[number], string>
type Format = {
  format_id: string
  ext?: string
  vcodec?: string
  acodec?: string
  width?: number
  height?: number
  fps?: number
  tbr?: number
  filesize?: number
  filesize_approx?: number
  resolution?: string
}
type Info = { title?: string; thumbnail?: string; webpage_url?: string; duration?: number; uploader?: string; formats?: Format[]; format_id?: string; vcodec?: string; acodec?: string }
let api: PublicAPI
let cacheFolder = ""
const pending = new Map<string, Promise<Info>>()
const cache = new Map<string, { time: number; info: Info }>()
const downloading = new Set<string>()

async function settings(ctx: Context): Promise<Settings> {
  return Object.fromEntries(await Promise.all(settingKeys.map(async key => [key, (await api.GetSetting(ctx, key)) || ""]))) as Settings
}
function enabled(value: string, defaultValue = false): boolean {
  return value ? /^(true|1|yes|on)$/i.test(value) : defaultValue
}
function expand(value: string): string {
  return value.replace(/^~(?=$|[\\/])/, os.homedir()).replace(/%([^%]+)%/g, (_, key: string) => process.env[key] || `%${key}%`)
}
async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}
async function tool(name: string): Promise<string> {
  const p = path.join(cacheFolder, process.platform === "win32" ? name + ".exe" : name)
  if (await exists(p)) return p
  try {
    const { stdout } = await exec(process.platform === "win32" ? "where" : "which", [name])
    return stdout.trim().split(/\r?\n/)[0]
  } catch {
    return ""
  }
}
export function parseInput(text: string): { url: string; start: string; end: string; section: string } {
  const [url = "", start = "", end = "", ...extra] = text.trim().split(/\s+/)
  const validTime = (t: string) => /^(?:\d+:){0,2}\d+(?:\.\d+)?$/.test(t)
  if ((start || end) && (!validTime(start) || !(validTime(end) || end === "inf") || extra.length || (end !== "inf" && seconds(end) <= seconds(start)))) throw new Error("Invalid trim range")
  return { url, start, end, section: start ? `*${start}-${end}` : "" }
}
function seconds(value: string): number {
  return value.split(":").reduce((n, x) => n * 60 + Number(x), 0)
}
function validUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return ["http:", "https:"].includes(u.protocol) && (u.pathname !== "/" || !!u.search)
  } catch {
    return false
  }
}
function baseArgs(s: Settings): string[] {
  return s.cookie_file_path ? ["--cookies", expand(s.cookie_file_path)] : []
}
async function probe(url: string, ytdlp: string, s: Settings): Promise<Info> {
  const key = JSON.stringify([url, ytdlp, s.cookie_file_path])
  const cached = cache.get(key)
  if (cached && Date.now() - cached.time < 1800000) return cached.info
  let task = pending.get(key)
  if (!task) {
    task = exec(ytdlp, ["--dump-single-json", "--no-playlist", "--no-warnings", ...baseArgs(s), "--", url], { maxBuffer: 30 * 1024 * 1024, timeout: 120000 })
      .then(({ stdout }) => {
        const info = JSON.parse(stdout) as Info
        cache.set(key, { time: Date.now(), info })
        return info
      })
      .finally(() => pending.delete(key))
    pending.set(key, task)
  }
  return task
}
function open(target: string): void {
  const cmd = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open"
  const child = spawn(cmd, [target], { detached: true, stdio: "ignore" })
  child.on("error", () => undefined)
  child.unref()
}
function action(name: string, icon: WoxImage, run: (ctx: Context) => Promise<void>): ResultAction {
  return { Name: name, Icon: icon, Action: run }
}
function message(title: string, subtitle: string, actions: ResultAction[] = []): Result {
  return { Title: title, SubTitle: subtitle, Icon: logo, Actions: actions }
}
export function parseDownloadProgress(line: string): string {
  const match = /^VD_PROGRESS\s*([^|]+)\|([^|]*)\|([^|]*)/.exec(line)
  return match
    ? match
        .slice(1)
        .map(part => part.trim())
        .filter(part => part && part !== "N/A")
        .join(" · ")
    : ""
}
function runProcess(command: string, args: string[], onProgress: (value: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    let output = ""
    child.stdout.on("data", chunk => {
      output += String(chunk)
      const lines = output.split(/\r?\n/)
      output = lines.pop() || ""
      for (const line of lines) {
        const progress = parseDownloadProgress(line)
        if (progress) onProgress(progress)
      }
    })
    let errors = ""
    child.stderr.on("data", chunk => {
      errors = (errors + String(chunk)).slice(-4000)
    })
    child.on("error", reject)
    child.on("close", code => (code === 0 ? resolve() : reject(new Error(errors || `Process exited with code ${code}`))))
  })
}
async function runDownload(
  ctx: Context,
  info: { url: string; format: Format; isAudio: boolean; section: string; start: string; end: string },
  s: Settings,
  ytdlp: string,
  ffmpeg: string,
  onProgress: (value: string) => void
): Promise<void> {
  const dir = expand(s.download_path || path.join(os.homedir(), "Downloads"))
  await fs.mkdir(dir, { recursive: true })
  const marker = path.join(cacheFolder, `download-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
  const selector = info.isAudio ? info.format.format_id : `${info.format.format_id}${info.format.acodec === "none" ? "+bestaudio" : ""}`
  const args = [
    "--no-playlist",
    "--newline",
    "--progress",
    "--progress-template",
    "download:VD_PROGRESS %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
    "-P",
    dir,
    "-o",
    "%(title).100s.%(ext)s",
    "--restrict-filenames",
    "--trim-filenames",
    "100",
    "--retries",
    "10",
    "--fragment-retries",
    "10",
    "--print-to-file",
    "after_move:filepath",
    marker,
    ...baseArgs(s)
  ]
  if (enabled(s.overwrite_existing_files, true)) args.push("--force-overwrites")
  if (ffmpeg) args.push("--ffmpeg-location", ffmpeg)
  if (info.isAudio) args.push("-x", "--audio-format", s.preferred_audio_format || "mp3", "--audio-quality", "0")
  else args.push("--remux-video", s.preferred_video_format || "mp4")
  if (info.section && s.trim_mode === "native") args.push("--download-sections", info.section)
  onProgress("i18n:download_starting")
  try {
    try {
      await runProcess(ytdlp, [...args, "-f", selector, "--", info.url], onProgress)
    } catch {
      onProgress("i18n:download_retrying")
      await runProcess(ytdlp, [...args, "-f", info.isAudio ? "bestaudio/best" : "bestvideo+bestaudio/best", "--", info.url], onProgress)
    }
    if (info.section && s.trim_mode === "post") {
      if (!ffmpeg) throw new Error("FFmpeg is required for trimming")
      const outputPath = (await fs.readFile(marker, "utf8")).trim().split(/\r?\n/).pop() || ""
      if (!outputPath || !(await exists(outputPath))) throw new Error("Could not find the downloaded file for trimming")
      const parsed = path.parse(outputPath)
      let trimmed = path.join(parsed.dir, `${parsed.name}_trimmed${parsed.ext}`)
      if (!enabled(s.overwrite_existing_files, true)) {
        let n = 1
        while (await exists(trimmed)) trimmed = path.join(parsed.dir, `${parsed.name}_trimmed_${n++}${parsed.ext}`)
      }
      const trimArgs = [enabled(s.overwrite_existing_files, true) ? "-y" : "-n", "-ss", info.start, "-i", outputPath]
      if (info.end !== "inf") trimArgs.push("-t", String(seconds(info.end) - seconds(info.start)))
      onProgress("i18n:download_processing")
      await exec(ffmpeg, [...trimArgs, "-c", "copy", trimmed], { maxBuffer: 10 * 1024 * 1024 })
      if (enabled(s.delete_original_after_trim) && (await exists(trimmed))) await fs.unlink(outputPath)
    }
    onProgress("i18n:download_finished")
    await api.Notify(ctx, `Download finished: ${dir}`)
    if (enabled(s.auto_open_folder, true)) open(dir)
  } catch (error) {
    onProgress(`Download failed: ${String(error)}`)
    await api.Notify(ctx, `Download failed: ${String(error)}`)
  } finally {
    await fs.rm(marker, { force: true })
  }
}
export function formatResults(
  info: Info,
  url: string,
  s: Settings,
  ytdlp: string,
  ffmpeg: string,
  trim: ReturnType<typeof parseInput>,
  filter = "all",
  audioLabel = "Audio",
  videoLabel = "Video"
): Result[] {
  const rawFormats = (info.formats || (info.format_id ? [info as Format] : [])).filter(f => f.format_id && (f.vcodec !== "none" || f.acodec !== "none"))
  const dimensions = (f: Format): [number, number] => {
    const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(f.resolution || "")
    return [Number(f.width) || Number(match?.[1]) || 0, Number(f.height) || Number(match?.[2]) || 0]
  }
  const isVideo = (f: Format): boolean => f.vcodec !== "none" && (!!f.vcodec || dimensions(f).every(value => value > 0))
  const videoFormats = new Map<string, Format>()
  for (const f of rawFormats.filter(isVideo)) {
    const [width, height] = dimensions(f)
    // Keep formats with unknown dimensions separate; there is no safe way to compare them.
    const key = width && height ? JSON.stringify([width, height, f.ext || "", f.fps || 0]) : f.format_id
    const previous = videoFormats.get(key)
    if (!previous || (Number(f.tbr) || 0) > (Number(previous.tbr) || 0)) videoFormats.set(key, f)
  }
  const formats = [...videoFormats.values(), ...rawFormats.filter(f => !isVideo(f))]
  const metric = (f: Format) =>
    s.sorting_order === "size"
      ? f.filesize || f.filesize_approx || 0
      : s.sorting_order === "bitrate"
        ? f.tbr || 0
        : s.sorting_order === "fps"
          ? f.fps || 0
          : dimensions(f)[1] * 10000 + dimensions(f)[0]
  formats.sort((a, b) => metric(b) - metric(a))
  const videos = formats.filter(isVideo)
  const audios = formats.filter(f => f.vcodec === "none" && f.acodec !== "none")
  const bestVideo = [...videos].sort((a, b) => dimensions(b)[1] - dimensions(a)[1] || dimensions(b)[0] - dimensions(a)[0] || (Number(b.tbr) || 0) - (Number(a.tbr) || 0))[0]
  const bestAudio = [...audios].sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0]
  const recommended = [bestVideo, bestAudio].filter((f): f is Format => !!f && (filter === "all" || (filter === "audio" ? f.vcodec === "none" : f.vcodec !== "none")))
  const recommendedIds = new Set(recommended.map(f => f.format_id))
  const chosen = formats
    .filter(f => filter === "all" || (filter === "audio" ? f.vcodec === "none" : f.vcodec !== "none"))
    .filter(f => !recommendedIds.has(f.format_id))
    .slice(0, 40)
  const rows = [...recommended, ...chosen]
  const results = rows.map<Result>((f, index) => {
    const isBest = recommendedIds.has(f.format_id)
    const isAudio = f.vcodec === "none"
    const resolution = f.resolution || (f.height ? (f.width ? f.width + "×" + f.height : f.height + "p") : videoLabel)
    const bitrate = f.tbr ? Math.round(f.tbr) + " kbps" : ""
    const details = [
      bitrate,
      f.fps ? f.fps + " FPS" : "",
      f.filesize || f.filesize_approx ? ((f.filesize || f.filesize_approx || 0) / 1048576).toFixed(1) + " MB" : "",
      trim.section ? trim.start + "–" + trim.end : ""
    ].filter(Boolean)
    const displayTitle = isAudio ? [audioLabel, bitrate].filter(Boolean).join(" · ") : resolution
    const subtitle = isAudio && bitrate ? details.slice(1).join(" · ") : details.join(" · ")
    const tails = [isBest ? "i18n:format_best" : "", f.ext].filter(Boolean)
    return {
      Title: displayTitle,
      SubTitle: subtitle,
      Group: isAudio ? audioLabel : videoLabel,
      GroupScore: isAudio ? 100 : 200,
      Score: isAudio ? (isBest ? 5000 : 4000 - index) : isBest ? 10000 : 9000 - index,
      Icon: info.thumbnail ? { ImageType: "url", ImageData: info.thumbnail } : logo,
      IdentityKey: JSON.stringify([url, f.format_id, trim.section]),
      Tails: tails.map(text => ({ Type: "text", Text: text! })),
      Actions: [
        {
          Name: "i18n:download",
          Icon: icons.execute,
          PreventHideAfterAction: true,
          Action: async (ctx, actionContext) => {
            const key = JSON.stringify([url, f.format_id, trim.section])
            if (downloading.has(key)) return
            downloading.add(key)
            let updates = Promise.resolve()
            const report = (value: string) => {
              updates = updates
                .then(async () => {
                  await api.UpdateResult(ctx, { Id: actionContext.ResultId, SubTitle: value })
                })
                .catch(() => undefined)
            }
            void runDownload(ctx, { ...trim, url, format: f, isAudio }, s, ytdlp, ffmpeg, report)
              .catch(error => report(`Download failed: ${String(error)}`))
              .finally(() => downloading.delete(key))
          }
        },
        action("i18n:copy_url", icons.copy, async ctx => {
          await api.Copy(ctx, { type: "text", text: url })
        }),
        action("i18n:open_page", icons.open, async () => open(info.webpage_url || url)),
        action("i18n:open_folder", icons.folder, async () => open(expand(s.download_path || path.join(os.homedir(), "Downloads"))))
      ]
    }
  })
  return results.sort((a, b) => (b.Score || 0) - (a.Score || 0))
}
const readyResults = new Map<string, QueryResponse>()
let pendingQuery: ReturnType<typeof setTimeout> | undefined

async function resolveQuery(ctx: Context, q: Query): Promise<QueryResponse> {
  const s = await settings(ctx),
    ytdlp = await tool("yt-dlp"),
    ffmpeg = await tool("ffmpeg")
  if (!ytdlp) return { Results: [dependencyResult("yt-dlp", api, cacheFolder, logo)] }
  if (q.Command === "update" || q.Search.trim() === "update")
    return {
      Results: [
        message("i18n:update_ytdlp", ytdlp, [
          action("i18n:update_ytdlp", icons.execute, async c => {
            try {
              await exec(ytdlp, ["-U"])
              await api.Notify(c, "yt-dlp updated")
            } catch (e) {
              await api.Notify(c, `yt-dlp: ${String(e)}`)
            }
          })
        ])
      ]
    }
  if (!q.Search.trim() && !q.Command) {
    const results = [message("i18n:hint_title", "i18n:hint_usage", [action("i18n:open_folder", icons.folder, async () => open(expand(s.download_path || path.join(os.homedir(), "Downloads"))))])]
    if (!ffmpeg) results.push(dependencyResult("ffmpeg", api, cacheFolder, logo))
    return { Results: results }
  }
  let input: ReturnType<typeof parseInput>
  try {
    input = parseInput([q.Command, q.Search].filter(Boolean).join(" "))
  } catch {
    return { Results: [message("i18n:invalid_url", "Invalid trim range")] }
  }
  if (!validUrl(input.url)) return { Results: [message("i18n:invalid_url", "i18n:invalid_url_sub")] }
  if (input.section && (!s.trim_mode || s.trim_mode === "off")) return { Results: [message("i18n:trim_disabled", "i18n:trim_disabled_sub")] }
  if (s.cookie_file_path && !(await exists(expand(s.cookie_file_path)))) return { Results: [message("i18n:cookie_error", "cookies.txt not found")] }
  const [videoGroup, audioGroup] = await Promise.all([api.GetTranslation(ctx, "format_video"), api.GetTranslation(ctx, "format_audio")])
  const infoRow = (info: Info): Result => {
    const duration =
      info.duration != null && Number.isFinite(info.duration)
        ? [Math.floor(info.duration / 3600), Math.floor(info.duration / 60) % 60, Math.floor(info.duration % 60)]
            .map((part, index) => (index ? String(part).padStart(2, "0") : String(part)))
            .slice(info.duration >= 3600 ? 0 : 1)
            .join(":")
            .replace(/^0(?=\d:)/, "")
        : ""
    return {
      Title: info.title || input.url,
      SubTitle: info.uploader || input.url,
      Icon: info.thumbnail ? { ImageType: "url", ImageData: info.thumbnail } : logo,
      GroupScore: 300,
      Score: 20000,
      Tails: duration ? [{ Type: "text", Text: duration }] : [],
      Actions: [
        action("i18n:copy_url", icons.copy, async c => {
          await api.Copy(c, { type: "text", text: input.url })
        }),
        action("i18n:open_page", icons.open, async () => open(info.webpage_url || input.url))
      ]
    }
  }
  try {
    const info = await probe(input.url, ytdlp, s)
    const rows = formatResults(info, input.url, s, ytdlp, ffmpeg, input, "all", audioGroup, videoGroup)
    if (!ffmpeg) {
      const dependency = dependencyResult("ffmpeg", api, cacheFolder, logo)
      dependency.GroupScore = 300
      dependency.Score = 19000
      rows.unshift(dependency)
    }
    if (!rows.length) rows.push(message("i18n:empty_formats", input.url))
    return { Results: [infoRow(info), ...rows] }
  } catch (error) {
    return { Results: [message("i18n:fetch_error", String(error))] }
  }
}

export const plugin: Plugin = {
  init: async (ctx, params) => {
    api = params.API
    cacheFolder = await api.GetCacheFolder(ctx)
    await api.RegisterPluginTool(ctx, {
      Tool: {
        Name: "list_formats",
        Description: "Fetch available media formats for a video URL.",
        InputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
        OutputSchema: { type: "object", properties: { title: { type: "string" }, formats: { type: "array", items: { type: "object" } } }, required: ["title", "formats"] },
        Annotations: { ReadOnly: true, Destructive: false, Idempotent: true, RequiresUI: false }
      },
      Handler: async (toolCtx, option) => {
        const url = String(option.Arguments.url)
        if (!validUrl(url)) return { Error: { Code: "INVALID_ARGUMENTS", Message: "Invalid URL" } }
        const s = await settings(toolCtx)
        const exe = await tool("yt-dlp")
        if (!exe) return { Error: { Code: "EXECUTION_FAILED", Message: "yt-dlp not found" } }
        try {
          const info = await probe(url, exe, s)
          return { Output: { title: info.title || "", formats: info.formats || [] } }
        } catch (error) {
          return { Error: { Code: "EXECUTION_FAILED", Message: String(error) } }
        }
      }
    })
  },
  query: async (ctx, q: Query): Promise<QueryResponse> => {
    if (pendingQuery) clearTimeout(pendingQuery)
    pendingQuery = undefined
    const key = JSON.stringify([q.TriggerKeyword || "", q.Command || "", q.Search || ""])
    const ready = readyResults.get(key)
    if (ready) {
      readyResults.delete(key)
      return ready
    }
    let url = ""
    try {
      url = parseInput([q.Command, q.Search].filter(Boolean).join(" ")).url
    } catch {
      /* Let normal validation describe invalid input. */
    }
    if (!validUrl(url)) return resolveQuery(ctx, q)

    const id = randomUUID()
    const loading: Result = { Id: id, Title: "i18n:fetching", SubTitle: url, Icon: logo, Score: 20000 }
    pendingQuery = setTimeout(() => {
      pendingQuery = undefined
      void (async () => {
        try {
          const response = await resolveQuery(ctx, q)
          const first = response.Results[0]
          if (!first) return
          let updated = false
          for (let attempt = 0; attempt < 10 && !updated; attempt++) {
            updated = await api.UpdateResult(ctx, { Id: id, Title: first.Title, SubTitle: first.SubTitle, Icon: first.Icon, Tails: first.Tails, Actions: first.Actions })
            if (!updated) await new Promise(resolve => setTimeout(resolve, 100))
          }
          if (!updated || first.Title === "i18n:fetch_error") return
          readyResults.set(key, response)
          const expiry = setTimeout(() => {
            if (readyResults.get(key) === response) readyResults.delete(key)
          }, 5000)
          expiry.unref()
          await api.RefreshQuery(ctx, { PreserveSelectedIndex: true })
        } catch (error) {
          await api.UpdateResult(ctx, { Id: id, Title: "i18n:fetch_error", SubTitle: String(error) })
        }
      })().catch(error => api.Log(ctx, "Error", String(error)))
    }, 150)
    return { Results: [loading] }
  }
}
