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
const SCALE = 2;
const CARD_W = 340; // matches the real BrowserWindow width in main.js

// name -> query string for preview.html
const SHOTS = {
  lcars: 'skin=lcars&mon=1',
  nixie: 'skin=nixie',
  reactor: 'skin=reactor',
  scribble: 'skin=scribble',
  macos: 'skin=macos',
  win11: 'skin=win11',
  dash: 'skin=dash',
  enigma: 'skin=enigma',
  term: 'skin=term',
  synth: 'skin=synth',
  cockpit: 'skin=cockpit',
  gameboy: 'skin=gameboy',
};

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const wanted = only.length ? only : Object.keys(SHOTS);

async function shoot(win, name) {
  const qs = SHOTS[name];
  if (!qs) throw new Error(`unknown skin: ${name}`);

  await win.loadURL(`file://${PREVIEW}?${qs}`);
  // Let fonts, SVG centrepieces and the ECG canvas settle before capturing.
  await new Promise((r) => setTimeout(r, 900));

  const box = await win.webContents.executeJavaScript(`(() => {
    const r = document.getElementById('card').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  })()`);

  const img = await win.webContents.capturePage({
    x: Math.floor(box.x * SCALE),
    y: Math.floor(box.y * SCALE),
    width: Math.ceil(box.w * SCALE),
    height: Math.ceil(box.h * SCALE),
  });

  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, img.toPNG());
  console.log(`${name.padEnd(9)} ${Math.round(box.w)}x${Math.round(box.h)} -> ${path.relative(process.cwd(), file)}`);
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({
    width: CARD_W * SCALE,
    height: 1400,
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
