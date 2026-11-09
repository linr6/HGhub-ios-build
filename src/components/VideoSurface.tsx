import { useEffect, useImperativeHandle, useRef, forwardRef, useState } from "react";
import Hls from "hls.js";
import { isIos } from "../api";
import { nativePlaybackError, resolvePlaybackSource } from "../playbackSource";
import { mediaResource, observeHls, usePlayerDiagnostics } from "../playbackDiagnostics";
import { usePlaybackActivity } from "../usePlaybackActivity";

export type VideoHandle = {
  el: () => HTMLVideoElement | null;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number, source?: string) => void;
  trace: (event: string, data?: Record<string, unknown>) => void;
  rate: (r: number) => void;
  mute: (m: boolean) => void;
  volume: (v: number) => void;
};

type Props = {
  src: string;
  poster?: string;
  autoPlay?: boolean;
  active?: boolean;
  diagnosticContext?: Record<string, unknown>;
  muted?: boolean;
  loop?: boolean;
  fit?: "contain" | "cover";
  /** 换源后重新套用，避免切集时音量/倍速被浏览器重置 */
  volume?: number;
  rate?: number;
  onTime?: (t: number) => void;
  onDuration?: (d: number) => void;
  onSize?: (w: number, h: number) => void;
  onPlaying?: () => void;
  onPause?: () => void;
  onWaiting?: () => void;
  onEnded?: () => void;
  onError?: (msg: string) => void;
  onClick?: () => void;
  className?: string;
};

/** 只负责「播」：hls.js + video 元素，控制条由外层渲染。 */
const VideoSurface = forwardRef<VideoHandle, Props>(function VideoSurface(
  { src, poster, autoPlay = true, active = true, diagnosticContext = {}, muted = false, loop = false, fit = "contain", volume = 1, rate = 1,
    onTime, onDuration, onSize, onPlaying, onPause, onWaiting, onEnded, onError, onClick, className = "" },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [ready, setReady] = useState(false);
  const { trace, requestSeek } = usePlayerDiagnostics(videoRef, hlsRef, { ...diagnosticContext, active, resource: mediaResource(src) });
  const activity = usePlaybackActivity(videoRef, hlsRef, { active, autoPlay, src, trace });

  useImperativeHandle(ref, () => ({
    el: () => videoRef.current,
    play: () => activity.play("handle"),
    pause: () => activity.pause(),
    toggle: () => {
      const v = videoRef.current;
      if (!v) return;
      trace("toggle.request");
      if (v.paused) activity.play("toggle"); else activity.pause("toggle");
    },
    seek: (t: number, source = "handle") => {
      const v = videoRef.current;
      if (v && Number.isFinite(t)) {
        requestSeek(t, source);
        try { v.currentTime = t; trace("seek.assigned", { target: t, source }); }
        catch (e) { trace("seek.rejected", { error_name: (e as Error).name }); throw e; }
      }
    },
    trace,
    rate: (r: number) => { const v = videoRef.current; if (v) v.playbackRate = r; },
    mute: (m: boolean) => { const v = videoRef.current; if (v) v.muted = m; },
    volume: (vol: number) => { const v = videoRef.current; if (v) v.volume = vol; },
  }), []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    setReady(false);
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    let cancelled = false;
    resolvePlaybackSource(src).then(({ url, native }) => {
      if (cancelled) return;
      const useHls = !url.includes("/seg?u=");
      trace("source.load", { engine: !native && useHls && Hls.isSupported() ? "hls.js" : "native", transport: native ? "ios_loopback" : "protocol", auto_play: autoPlay, resource: mediaResource(src) });

      /* 换源时先把音量/倍速套回去：hls 重新 attach 后浏览器会把它们重置成默认值 */
      const applySettings = () => {
        const v = videoRef.current;
        if (!v) return;
        v.volume = volume;
        v.muted = muted;
        v.playbackRate = rate;
      };
      applySettings();

      if (!native && useHls && Hls.isSupported()) {
        const hls = new Hls({
          // 禁用从插播/内容引导 JSON 派生直连 URL 的可选功能。
          interstitialsController: undefined,
          contentSteeringController: undefined,
          enableInterstitialPlayback: false,
          enableWorker: true,
          // Prefer standard MSE on macOS; hls.js handles MMS-only fallback and seek recovery.
          preferManagedMediaSource: false,
          autoStartLoad: false,
          maxBufferLength: 30,
          backBufferLength: 30,
          manifestLoadingTimeOut: 20000,
          manifestLoadingMaxRetry: 3,
          fragLoadingMaxRetry: 4,
        });
        hlsRef.current = hls;
        observeHls(hls, trace);
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (activity.isActive()) hls.startLoad();
          if (autoPlay) activity.play("manifest_autoplay", true);
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          onError?.(`${data.type}/${data.details}`);
          if (!activity.isActive()) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          else { hls.destroy(); hlsRef.current = null; }
        });
      } else {
        video.src = url;
        if (autoPlay) activity.play("native_autoplay", true);
      }
    }).catch(() => {
      if (!cancelled) { trace("source.prepare_failed"); onError?.("本机播放通道启动失败，请重新打开 App"); }
    });

    return () => {
      cancelled = true;
      trace("source.cleanup");
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => { if (videoRef.current) videoRef.current.muted = muted; }, [muted]);
  useEffect(() => { if (videoRef.current) videoRef.current.volume = volume; }, [volume]);
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = rate; }, [rate]);

  const reapply = (v: HTMLVideoElement) => {
    v.volume = volume;
    v.muted = muted;
    v.playbackRate = rate;
  };

  return (
    <video
      ref={videoRef}
      poster={poster}
      playsInline
      muted={muted}
      loop={loop}
      onClick={onClick}
      className={`w-full h-full bg-black ${fit === "cover" ? "object-cover" : "object-contain"} ${className}`}
      style={isIos ? undefined : { opacity: ready ? 1 : 0, transition: "opacity .35s" }}
      onLoadedData={(e) => { setReady(true); reapply(e.target as HTMLVideoElement); }}
      onTimeUpdate={(e) => onTime?.((e.target as HTMLVideoElement).currentTime)}
      onLoadedMetadata={(e) => {
        const v = e.target as HTMLVideoElement;
        reapply(v);
        onDuration?.(v.duration || 0);
        onSize?.(v.videoWidth || 0, v.videoHeight || 0);
      }}
      onPlay={() => { if (activity.isActive()) onPlaying?.(); }}
      onPause={() => onPause?.()}
      onWaiting={() => onWaiting?.()}
      onPlaying={() => { if (activity.isActive()) onPlaying?.(); }}
      onEnded={() => { if (activity.isActive()) onEnded?.(); }}
      onError={(e) => {
        const video = e.currentTarget;
        if (!hlsRef.current && video.error && video.getAttribute("src")) onError?.(nativePlaybackError(video));
      }}
    />
  );
});

export default VideoSurface;
