import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Context, PublicAPI } from "@wox-launcher/wox-plugin"

const mockSpawn = jest.fn()
jest.mock("node:child_process", () => ({ execFile: jest.fn(), spawn: (...args: unknown[]) => mockSpawn(...args) }))
import { formatResults, parseInput, plugin } from "../index"

test.each([
  ["false", false],
  ["true", true],
  ["", true]
])("uses the latest auto-open setting %j after download", async (value, shouldOpen) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wox-auto-open-"))
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  let started!: () => void
  const downloadStarted = new Promise<void>(resolve => { started = resolve })
  let checked!: () => void
  const settingChecked = new Promise<void>(resolve => { checked = resolve })
  mockSpawn.mockReset().mockImplementation((command: string) => {
    if (command === "yt-dlp") {
      started()
      return child
    }
    return Object.assign(new EventEmitter(), { unref: jest.fn() })
  })
  let currentSetting = "true"
  const api = {
    GetCacheFolder: jest.fn().mockResolvedValue(dir),
    RegisterPluginTool: jest.fn(),
    GetSetting: jest.fn(async () => { checked(); return currentSetting }),
    GetTranslation: jest.fn(async (_ctx, key) => key),
    UpdateResult: jest.fn().mockResolvedValue(true),
    Notify: jest.fn().mockResolvedValue(undefined)
  } as unknown as PublicAPI
  try {
    const ctx = {} as Context
    await plugin.init(ctx, { API: api, PluginDirectory: dir })
    const settings = { download_path: dir } as Parameters<typeof formatResults>[2]
    const row = formatResults({ formats: [{ format_id: value || "default", vcodec: "none", acodec: "aac" }] }, "https://example.com/video", settings, "yt-dlp", "ffmpeg", parseInput("https://example.com/video"), "all", "Audio", "Video")[0]
    const download = row.Actions![0]
    if (download.Type === "form") throw new Error("Expected execute action")
    await download.Action!(ctx, { ResultId: "row" } as Parameters<NonNullable<typeof download.Action>>[1])
    await downloadStarted
    currentSetting = value
    child.emit("close", 0)
    await settingChecked
    await new Promise(resolve => setImmediate(resolve))
    expect(api.GetSetting).toHaveBeenCalledWith(ctx, "auto_open_folder")
    expect(mockSpawn.mock.calls.filter(([command]) => command !== "yt-dlp")).toHaveLength(shouldOpen ? 1 : 0)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
