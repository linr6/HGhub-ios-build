import { invoke } from "@tauri-apps/api/core";
import { isIos, isLocalMedia, mediaUrl } from "./api";

export const iosPlaybackApi = { origin: () => invoke<string>("ios_media_origin") };
let bridge: Promise<string> | undefined;

/** Native HLS runs outside WKURLSchemeHandler, so hg:// is only for WebView fetches. */
export async function resolvePlaybackSource(src: string): Promise<{ url: string; native: boolean }> {
  const local = isLocalMedia(src) ? src : mediaUrl(src);
  if (!isIos) return { url: local, native: false };
  const origin = await (bridge ??= iosPlaybackApi.origin().catch(error => { bridge = undefined; throw error; }));
  const source = new URL(local);
  const route = source.pathname === "/hls" ? "/hls/list.m3u8" : "/seg";
  return { url: `${origin}${route}${source.search}`, native: true };
}

export function nativePlaybackError(video: HTMLVideoElement): string {
  const code = video.error?.code;
  const reason = code === 2 ? "视频网络请求失败，请检查 VPN 的视频线路"
    : code === 3 ? "视频解码失败，请尝试其他集数"
    : code === 4 ? "视频源或格式暂不支持，请尝试其他集数" : "视频加载中断";
  return `${reason}（media ${code ?? 0}）`;
}
