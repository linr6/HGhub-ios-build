import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";

const { values: args } = parseArgs({ options: { "browser-executable": { type: "string" } } });
const temporary = await mkdtemp(join(tmpdir(), "hghub-ios-test-"));
const requests = [], cases = [];
let media, vite, browser;
try {
  const mp4 = join(temporary, "clip.mp4");
  execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15", "-t", "12", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4], { timeout: 60000 });
  const bytes = await readFile(mp4);
  media = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const target = url.searchParams.get("u");
    requests.push({ route: url.pathname, target, range: req.headers.range });
    if (url.pathname.endsWith("/hls/list.m3u8")) {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      return res.end("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-ENDLIST\n");
    }
    if (target?.endsWith("missing.mp4")) { res.writeHead(404); return res.end(); }
    const start = Number(/^bytes=(\d+)-/.exec(req.headers.range || "")?.[1] || 0);
    res.writeHead(req.headers.range ? 206 : 200, {
      "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": bytes.length - start,
      ...(req.headers.range ? { "Content-Range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}),
    });
    res.end(bytes.subarray(start));
  });
  await new Promise(done => media.listen(0, "127.0.0.1", done));
  const bridge = `http://127.0.0.1:${media.address().port}/capability`;
  vite = await createViteServer({ server: { host: "127.0.0.1", port: 0, hmr: false, open: false } });
  await vite.listen();
  const ui = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: args["browser-executable"], args: ["--autoplay-policy=no-user-gesture-required"] });
  for (const legacy of [false, true]) {
    const context = await browser.newContext({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" });
    await context.route("**/*", route => [ui, new URL(bridge).origin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    await page.goto(`${ui}/tests/ios-playback.html?delay=1&bridge=${encodeURIComponent(bridge)}${legacy ? "&legacy=1" : ""}`);
    await page.waitForFunction(() => window.iosFixture?.calls === 1);
    const first = requests.length;
    await page.evaluate(() => window.iosFixture.source("https://media.fixture/second.mp4"));
    await page.waitForTimeout(50);
    await page.evaluate(() => window.iosFixture.release());
    await page.waitForFunction(() => document.querySelector("video").currentTime > .2);
    assert(requests.slice(first).every(r => r.target?.endsWith("second.mp4")), "A cancelled source must never start loading");
    assert.equal(await page.evaluate(() => window.iosFixture.calls), 1, "Reuse one bridge per app session");
    assert.equal(await page.locator("video").evaluate(v => getComputedStyle(v).opacity), "1", "Keep the iOS decoder layer visible");
    await page.locator("video").evaluate(v => { v.currentTime = 8; });
    await page.waitForFunction(() => document.querySelector("video").currentTime > 8.1);
    await page.evaluate(() => window.iosFixture.active(false));
    await page.waitForFunction(() => document.querySelector("video").paused);
    await page.evaluate(() => window.iosFixture.active(true));
    await page.waitForFunction(() => !document.querySelector("video").paused);
    await page.evaluate(() => window.iosFixture.source("https://media.fixture/missing.mp4"));
    await page.waitForFunction(() => document.querySelector("video").error);
    if (legacy) await page.getByText(/media [234]/).waitFor();
    else await page.waitForFunction(() => window.iosFixture.errors.some(e => /media [234]/.test(e)));
    await page.evaluate(() => window.iosFixture.source("https://media.fixture/master.m3u8?token=fixture"));
    await page.waitForFunction(() => document.querySelector("video").getAttribute("src")?.includes("/hls/list.m3u8?u="));
    const hls = new URL(await page.locator("video").getAttribute("src"));
    assert.equal(hls.searchParams.get("u"), "https://media.fixture/master.m3u8?token=fixture");
    await page.evaluate(() => window.iosFixture.unmount());
    await page.waitForFunction(() => !document.querySelector("video"));
    cases.push({ player: legacy ? "post" : "feed", passed: true, checks: ["late-source cancellation", "native MP4 playback and seek", "visible decoder layer", "page pause/resume", "native error feedback", "HLS loopback URL", "unmount"] });
    await context.close();
  }
  const output = resolve("test-results/ios-playback"); await mkdir(output, { recursive: true });
  await writeFile(join(output, "report.json"), JSON.stringify({ transport: "Chromium with iPhone UA; not an iOS device", cases, requests }, null, 2));
  console.log(JSON.stringify({ passed: cases.length, report: join(output, "report.json") }));
} finally {
  await browser?.close();
  media?.closeAllConnections();
  if (media) await new Promise(done => media.close(done));
  await vite?.close();
  await rm(temporary, { recursive: true, force: true });
}
