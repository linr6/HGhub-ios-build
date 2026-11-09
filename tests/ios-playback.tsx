import { useState } from "react";
import { createRoot } from "react-dom/client";
import VideoSurface from "../src/components/VideoSurface";
import Player from "../src/components/Player";
import { iosPlaybackApi } from "../src/playbackSource";

const query = new URLSearchParams(location.search);
let release: () => void;
const pending = new Promise<void>(resolve => { release = resolve; });
const fixture = {
  calls: 0, errors: [] as string[], release: () => release(),
  source: (_src: string) => {}, active: (_active: boolean) => {}, unmount: () => {},
};
iosPlaybackApi.origin = async () => { fixture.calls++; if (query.has("delay")) await pending; return query.get("bridge")!; };
function Fixture() {
  const [src, setSrc] = useState("https://media.fixture/first.mp4");
  const [active, setActive] = useState(true);
  const [visible, setVisible] = useState(true);
  fixture.source = setSrc; fixture.active = setActive; fixture.unmount = () => setVisible(false);
  if (!visible) return null;
  return query.has("legacy") ? <Player src={src} autoPlay active={active} muted />
    : <VideoSurface src={src} autoPlay active={active} muted onError={message => fixture.errors.push(message)} />;
}
Object.assign(window, { iosFixture: fixture });
createRoot(document.getElementById("root")!).render(<Fixture />);
