import { promises as fs } from "node:fs"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { Context, PublicAPI, Result, WoxImage } from "@wox-launcher/wox-plugin"
import { icons } from "./icons"

type Dependency = "yt-dlp" | "ffmpeg"
const installing = new Set<Dependency>()

export function dependencyAssets(name: Dependency, platform: NodeJS.Platform, arch: string): { url: string; filename: string }[] {
  if (name === "yt-dlp") {
    let asset = ""
    if (platform === "win32") asset = arch === "x64" ? "yt-dlp.exe" : arch === "arm64" ? "yt-dlp_arm64.exe" : arch === "ia32" ? "yt-dlp_x86.exe" : ""
    if (platform === "darwin" && ["x64", "arm64"].includes(arch)) asset = "yt-dlp_macos"
    if (platform === "linux") asset = arch === "x64" ? "yt-dlp_linux" : arch === "arm64" ? "yt-dlp_linux_aarch64" : ""
    if (!asset) throw new Error("Unsupported platform or architecture")
    return [{ url: `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, filename: platform === "win32" ? "yt-dlp.exe" : "yt-dlp" }]
  }
  const supported = platform === "win32" ? ["x64"] : platform === "darwin" ? ["x64", "arm64"] : platform === "linux" ? ["x64", "arm64", "arm", "ia32"] : []
  if (!supported.includes(arch)) throw new Error("Unsupported platform or architecture")
  return ["ffprobe", "ffmpeg"].map(binary => ({
    url: `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/${binary}-${platform}-${arch}`,
    filename: platform === "win32" ? binary + ".exe" : binary
  }))
}

export async function downloadFile(url: string, destination: string, progress: (bytes: number, total: number) => Promise<void>): Promise<void> {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
  const total = Number(response.headers.get("content-length")) || 0
  const temporary = destination + ".part"
  const file = await fs.open(temporary, "w", 0o755)
  let written = 0,
    lastUpdate = 0
  try {
    const reader = response.body.getReader()
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      await file.writeFile(value)
      written += value.length
      if (Date.now() - lastUpdate >= 250) {
        lastUpdate = Date.now()
        await progress(written, total)
      }
    }
    if (total && written !== total) throw new Error("Incomplete download")
    await file.close()
    await fs.chmod(temporary, 0o755)
    await fs.rename(temporary, destination)
  } catch (error) {
    await file.close().catch(() => undefined)
    await fs.rm(temporary, { force: true })
    throw error
  }
}

export function dependencyResult(name: Dependency, api: PublicAPI, cacheFolder: string, logo: WoxImage): Result {
  return {
    Id: randomUUID(),
    Title: name === "yt-dlp" ? "i18n:missing_ytdlp" : "i18n:missing_ffmpeg",
    SubTitle: name === "yt-dlp" ? "i18n:missing_ytdlp_sub" : "i18n:missing_ffmpeg_sub",
    Icon: logo,
    Actions: [
      {
        Name: name === "yt-dlp" ? "i18n:download_ytdlp" : "i18n:download_ffmpeg",
        Icon: icons.execute,
        PreventHideAfterAction: true,
        Action: async (ctx: Context, actionContext) => {
          if (installing.has(name)) return
          installing.add(name)
          const resultId = actionContext.ResultId
          const update = async (subtitle: string) => {
            await api.UpdateResult(ctx, { Id: resultId, SubTitle: subtitle })
          }
          void (async () => {
            try {
              const label = await api.GetTranslation(ctx, "dependency_downloading")
              await update(label)
              for (const asset of dependencyAssets(name, process.platform, process.arch)) {
                await downloadFile(asset.url, path.join(cacheFolder, asset.filename), async (bytes, total) => {
                  const amount = total ? `${Math.floor((bytes * 100) / total)}%` : `${(bytes / 1048576).toFixed(1)} MB`
                  await update(`${label} ${asset.filename}: ${amount}`)
                })
              }
              await update(await api.GetTranslation(ctx, "dependency_installed"))
              if (await api.GetUpdatableResult(ctx, resultId)) await api.RefreshQuery(ctx, { PreserveSelectedIndex: true })
            } catch (error) {
              await update(`${await api.GetTranslation(ctx, "dependency_failed")}: ${String(error)}`)
            } finally {
              installing.delete(name)
            }
          })().catch(error => api.Log(ctx, "Error", String(error)))
        }
      }
    ]
  }
}
