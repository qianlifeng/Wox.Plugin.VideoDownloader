import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Context, PublicAPI, ResultAction } from "@wox-launcher/wox-plugin"

const errors = ["first error " + "x".repeat(5000), "fallback error 中文"]
jest.mock("node:child_process", () => ({
  execFile: jest.fn(),
  spawn: jest.fn(() => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    const error = errors.shift()
    process.nextTick(() => {
      if (error) child.stderr.write(error)
      child.emit("close", error ? 1 : 0)
    })
    return child
  })
}))
import { formatResults, parseInput, plugin } from "../index"

test("preserves both complete errors in the preview and copy action, then clears them on retry", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wox-download-errors-"))
  let completed!: () => void
  const failure = new Promise<void>(resolve => { completed = resolve })
  let finished!: () => void
  const success = new Promise<void>(resolve => { finished = resolve })
  const api = {
    GetCacheFolder: jest.fn().mockResolvedValue(dir),
    RegisterPluginTool: jest.fn(),
    GetSetting: jest.fn().mockResolvedValue("false"),
    GetTranslation: jest.fn(async (_ctx, key) => ({ download_first_attempt: "首次尝试", download_fallback_attempt: "备用格式重试", download_finished: "下载完成" })[key as string] || key),
    UpdateResult: jest.fn(async (_ctx, update) => {
      if (update.SubTitle === "i18n:download_failed") completed()
      if (update.SubTitle === "i18n:download_finished") finished()
      return true
    }),
    Notify: jest.fn(),
    Copy: jest.fn()
  } as unknown as PublicAPI
  try {
    const ctx = {} as Context
    await plugin.init(ctx, { API: api, PluginDirectory: dir })
    const settings = { download_path: dir } as Parameters<typeof formatResults>[2]
    const row = formatResults({ formats: [{ format_id: "v", vcodec: "h264", acodec: "aac", height: 720 }] }, "https://example.com/video", settings, "yt-dlp", "ffmpeg", parseInput("https://example.com/video"), "all", "音频", "视频")[0]
    const download = row.Actions![0]
    if (download.Type === "form") throw new Error("Expected execute action")
    await download.Action!(ctx, { ResultId: "row" } as Parameters<NonNullable<typeof download.Action>>[1])
    await failure
    const update = jest.mocked(api.UpdateResult).mock.calls.find(([, value]) => value.SubTitle === "i18n:download_failed")![1]
    expect(update.Preview?.PreviewData).toContain("first error " + "x".repeat(5000))
    expect(update.Preview?.PreviewData).toContain("fallback error 中文")
    expect(update.Preview?.PreviewData).toContain("首次尝试:")
    expect(update.Preview?.PreviewData).toContain("备用格式重试:")
    const copy = update.Actions!.find((item: ResultAction) => item.Name === "i18n:copy_error")!
    if (copy.Type === "form") throw new Error("Expected execute action")
    await copy.Action!(ctx, {} as Parameters<NonNullable<typeof copy.Action>>[1])
    expect(api.Copy).toHaveBeenCalledWith(ctx, { type: "text", text: update.Preview?.PreviewData })
    // The next action can start once the background failure handler finishes.
    await new Promise(resolve => setImmediate(resolve))
    await download.Action!(ctx, { ResultId: "row" } as Parameters<NonNullable<typeof download.Action>>[1])
    await success
    expect(api.UpdateResult).toHaveBeenLastCalledWith(ctx, expect.objectContaining({ SubTitle: "i18n:download_finished" }))
    expect(api.UpdateResult).toHaveBeenCalledWith(ctx, expect.objectContaining({ Preview: { PreviewType: "text", PreviewData: "" }, Actions: row.Actions }))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
