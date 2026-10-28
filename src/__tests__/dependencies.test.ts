import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Context, PublicAPI } from "@wox-launcher/wox-plugin"
import { dependencyAssets, dependencyResult, downloadFile } from "../dependencies"

test("selects supported binaries and downloads ffprobe before ffmpeg", () => {
  expect(dependencyAssets("yt-dlp", "linux", "arm64")[0].url).toContain("yt-dlp_linux_aarch64")
  expect(dependencyAssets("ffmpeg", "win32", "x64").map(x => x.filename)).toEqual(["ffprobe.exe", "ffmpeg.exe"])
  expect(() => dependencyAssets("ffmpeg", "win32", "arm64")).toThrow()
})

test("streams a download and reports progress", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wox-video-test-"))
  const target = path.join(directory, "tool")
  const original = global.fetch
  global.fetch = jest.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } }))
  const progress = jest.fn().mockResolvedValue(undefined)
  try {
    await downloadFile("https://example.com/tool", target, progress)
    expect(await fs.readFile(target)).toEqual(Buffer.from([1, 2, 3]))
    expect(progress).toHaveBeenCalledWith(3, 3)
  } finally {
    global.fetch = original
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("keeps the result visible and updates its progress", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wox-video-test-"))
  const original = global.fetch
  global.fetch = jest.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-length": "3" } }))
  let finished!: () => void
  const completed = new Promise<void>(resolve => {
    finished = resolve
  })
  const api = {
    GetTranslation: jest.fn(async (_ctx, key) => key),
    UpdateResult: jest.fn().mockResolvedValue(true),
    GetUpdatableResult: jest.fn().mockResolvedValue({}),
    RefreshQuery: jest.fn(async () => finished()),
    Log: jest.fn()
  } as unknown as PublicAPI
  try {
    const row = dependencyResult("yt-dlp", api, dir, { ImageType: "emoji", ImageData: "x" })
    const action = row.Actions![0]
    if (action.Type === "form") throw new Error("Expected execute action")
    expect(action.PreventHideAfterAction).toBe(true)
    await action.Action({} as Context, { ResultId: row.Id!, ResultActionId: "1", ContextData: {} })
    await completed
    expect(api.UpdateResult).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ Id: row.Id, SubTitle: expect.stringContaining("100%") }))
    expect(api.RefreshQuery).toHaveBeenCalledTimes(1)
  } finally {
    global.fetch = original
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("removes an incomplete download so it can be retried", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wox-video-test-"))
  const target = path.join(directory, "tool")
  const original = global.fetch
  global.fetch = jest.fn().mockResolvedValue(new Response(new Uint8Array([1, 2]), { headers: { "content-length": "3" } }))
  try {
    await expect(downloadFile("https://example.com/tool", target, async () => undefined)).rejects.toThrow("Incomplete download")
    await expect(fs.access(target + ".part")).rejects.toThrow()
    await expect(fs.access(target)).rejects.toThrow()
  } finally {
    global.fetch = original
    await fs.rm(directory, { recursive: true, force: true })
  }
})
