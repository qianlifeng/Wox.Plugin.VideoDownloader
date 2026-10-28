import { parseInput } from "../index"

test("parses a URL and a valid trim range", () => {
  expect(parseInput("https://example.com/watch?v=1 1:00 2:30")).toEqual({ url: "https://example.com/watch?v=1", start: "1:00", end: "2:30", section: "*1:00-2:30" })
  expect(parseInput("https://example.com/watch?v=1 1:00 inf").section).toBe("*1:00-inf")
})

test("rejects incomplete and reversed trim ranges", () => {
  expect(() => parseInput("https://example.com/watch?v=1 1:00")).toThrow()
  expect(() => parseInput("https://example.com/watch?v=1 2:30 1:00")).toThrow()
})
import { Context, PublicAPI, Query } from "@wox-launcher/wox-plugin"
import { plugin } from "../index"

test("SDK offers to install a missing tool", async () => {
  const originalPath = process.env.PATH
  process.env.PATH = ""
  const ctx = {} as Context
  const api = {
    GetCacheFolder: jest.fn().mockResolvedValue(process.cwd()),
    RegisterPluginTool: jest.fn().mockResolvedValue({}),
    GetSetting: jest.fn(async (_ctx: Context, key: string) => (["ytdlp_path", "ffmpeg_path"].includes(key) ? process.execPath : ""))
  } as unknown as PublicAPI
  await plugin.init(ctx, { API: api, PluginDirectory: process.cwd() })
  const result = await plugin.query(ctx, { Command: "", Search: "bad-url" } as Query)
  process.env.PATH = originalPath
  if (Array.isArray(result)) throw new Error("Expected QueryResponse")
  expect(result.Results[0].Title).toBe("i18n:missing_ytdlp")
  expect(api.RegisterPluginTool).toHaveBeenCalled()
})
