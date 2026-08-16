// Screenshot generator for the README.
//
//   npx electron tools/shots.js            # all skins
//   npx electron tools/shots.js lcars      # just one
//
// Loads renderer/preview.html (the mock-data harness) at 2x, crops to the card,
// and writes PNGs into docs/shots/. Nothing here is used by the widget itself.

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'docs', 'shots');
const PREVIEW = path.join(__dirname, '..', 'renderer', 'preview.html');
// capturePage returns a retina (2x) image of the requested DIP rect, so a zoom of
// 1 already yields 2x-resolution PNGs. Raise it only if you want more than that.
const SCALE = 1;
const CARD_W = 340; // matches the real BrowserWindow width in main.js

// name -> query string for preview.html
const SHOTS = {
  // mon=1 shows the heartbeat monitor, opt=1 the settings panel — spread across
  // the skins so the README grid shows both without repeating the same view.
  lcars: 'skin=lcars&mon=1',
  nixie: 'skin=nixie',
  reactor: 'skin=reactor&mon=1',
  scribble: 'skin=scribble&opt=1',
  macos: 'skin=macos&opt=1',
  win11: 'skin=win11',
  dash: 'skin=dash',
  enigma: 'skin=enigma&opt=1',
  term: 'skin=term',
  synth: 'skin=synth&mon=1',
  cockpit: 'skin=cockpit',
  gameboy: 'skin=gameboy',
};

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const wanted = only.length ? only : Object.keys(SHOTS);

async function shoot(win, name) {
  const qs = SHOTS[name];
  if (!qs) throw new Error(`unknown skin: ${name}`);

  const measure = `(() => {
    const r = document.getElementById('card').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`;

  // bare=CARD_W strips the harness chrome so the card lays out at the real window width.
  const url = `file://${PREVIEW}?${qs}&bare=${CARD_W}`;

  // capturePage can only return what is actually rendered in the viewport, and
  // macOS caps the window at the screen work area. So: measure the card at 1x,
  // then pick the largest zoom that still fits it on screen, so a tall open
  // settings panel is never cut off at the bottom.
  await win.loadURL(url);
  win.webContents.setZoomFactor(1);
  await new Promise((r) => setTimeout(r, 400));
  const at1 = await win.webContents.executeJavaScript(measure);

  const viewH = win.getContentBounds().height;
  const zoom = Math.min(SCALE, (viewH - 8) / (at1.h + at1.y * 2));

  win.webContents.setZoomFactor(zoom);
  // Let fonts, SVG centrepieces and the ECG canvas settle before capturing.
  await new Promise((r) => setTimeout(r, 900));
  const box = await win.webContents.executeJavaScript(measure);

  const img = await win.webContents.capturePage({
    x: Math.floor(box.x * zoom),
    y: Math.floor(box.y * zoom),
    width: Math.ceil(box.w * zoom),
    height: Math.ceil(box.h * zoom),
  });

  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, img.toPNG());
  const size = img.getSize();
  console.log(
    `${name.padEnd(9)} ${Math.round(box.w)}x${Math.round(box.h)} @${zoom.toFixed(2)}x` +
    ` -> ${size.width}x${size.height}px ${path.relative(process.cwd(), file)}`
  );
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    width: CARD_W + 40,
    height: 4000, // macOS clamps this to the screen work area; we just want the max
    show: false,
    webPreferences: { zoomFactor: SCALE, backgroundThrottling: false },
  });

  try {
    for (const name of wanted) await shoot(win, name);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  app.quit();
});
