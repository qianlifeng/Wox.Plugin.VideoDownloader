import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Context, PublicAPI, Query } from "@wox-launcher/wox-plugin"

let probeError = false
jest.mock("node:child_process", () => {
  const execFile = Object.assign(jest.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      if (probeError) throw new Error("probe failed")
      return { stdout: JSON.stringify({ title: "Sample", duration: 65, formats: [{ format_id: "v", vcodec: "h264", acodec: "aac", height: 720 }] }), stderr: "" }
    }
  })
  return { execFile, spawn: jest.fn() }
})
import { plugin } from "../index"

test.each([false, true])("returns a loading row and updates it after probe (failure: %s)", async failure => {
  probeError = failure
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wox-query-"))
  const name = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
  const ffmpeg = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
  await fs.writeFile(path.join(dir, name), "")
  await fs.writeFile(path.join(dir, ffmpeg), "")
  let done!: () => void
  const finished = new Promise<void>(resolve => {
    done = resolve
  })
  let releaseSettings!: () => void
  const settingsGate = new Promise<void>(resolve => {
    releaseSettings = resolve
  })
  const api = {
    GetCacheFolder: jest.fn().mockResolvedValue(dir),
    RegisterPluginTool: jest.fn().mockResolvedValue({}),
    GetSetting: jest.fn(async () => {
      await settingsGate
      return ""
    }),
    GetTranslation: jest.fn(async (_ctx: Context, key: string) => key),
    UpdateResult: jest.fn(async (_ctx, change) => {
      if (change.Title === "i18n:fetch_error") done()
      return true
    }),
    PushResults: jest.fn(),
    RefreshQuery: jest.fn(async () => {
      done()
    }),
    Log: jest.fn()
  } as unknown as PublicAPI
  try {
    const ctx = {} as Context
    await plugin.init(ctx, { API: api, PluginDirectory: dir })
    const query = { Id: failure ? "failure" : "success", Command: "", Search: failure ? "https://example.com/failure" : "https://example.com/success" } as Query
    const result = await Promise.race([plugin.query(ctx, query), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("query waited for settings")), 100))])
    if (Array.isArray(result)) throw new Error("Expected QueryResponse")
    expect(result.Results[0].Title).toBe("i18n:fetching")
    expect(result.Results[0].Group).toBeUndefined()
    expect(api.UpdateResult).not.toHaveBeenCalled()
    releaseSettings()
    await finished
    expect(api.UpdateResult).toHaveBeenCalledWith(ctx, expect.objectContaining({ Id: result.Results[0].Id, Title: failure ? "i18n:fetch_error" : "Sample" }))
    expect(api.PushResults).not.toHaveBeenCalled()
    expect(api.RefreshQuery).toHaveBeenCalledTimes(failure ? 0 : 1)
    if (!failure) {
      const refreshed = await plugin.query(ctx, query)
      if (Array.isArray(refreshed)) throw new Error("Expected QueryResponse")
      expect(refreshed.Results.filter(row => row.Title === "Sample")).toHaveLength(1)
      expect(refreshed.Results[0].Title).toBe("Sample")
      expect(refreshed.Results[0].Group).toBeUndefined()
      expect(refreshed.Results[0].GroupScore).toBe(300)
      expect(refreshed.Results.some(row => row.IdentityKey?.includes('"v"'))).toBe(true)
      expect(refreshed.Results.some(row => row.Group === "format_video" && row.GroupScore === 200)).toBe(true)
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
