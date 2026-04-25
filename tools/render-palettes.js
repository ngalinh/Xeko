// Render glass mockup with multiple color palettes for comparison.
const path = require('path');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const PALETTES = {
  indigo: {
    name: 'Indigo / Royal Blue',
    primary: '#3b5bff',         // royal blue
    primary2: '#6b7eff',
    primaryDark: '#2547f0',
    blob1: 'rgba(180,200,255,0.30)',
    blob2: 'rgba(180,200,255,0.22)',
    base: '#fafaff',
    pillBg: 'rgba(180,200,255,0.18)',
  },
  mint: {
    name: 'Mint / Teal',
    primary: '#10b981',
    primary2: '#34d399',
    primaryDark: '#059669',
    blob1: 'rgba(190,235,220,0.40)',
    blob2: 'rgba(180,225,235,0.30)',
    base: '#f7fffc',
    pillBg: 'rgba(180,225,210,0.22)',
  },
  coral: {
    name: 'Coral / Peach',
    primary: '#fb6f59',
    primary2: '#ff8c70',
    primaryDark: '#e84d3b',
    blob1: 'rgba(255,210,195,0.40)',
    blob2: 'rgba(255,225,200,0.30)',
    base: '#fffbf8',
    pillBg: 'rgba(255,210,195,0.22)',
  },
  slate: {
    name: 'Slate / Neutral',
    primary: '#0f172a',
    primary2: '#334155',
    primaryDark: '#0a0f1c',
    blob1: 'rgba(200,210,225,0.30)',
    blob2: 'rgba(200,210,225,0.22)',
    base: '#fafafa',
    pillBg: 'rgba(200,210,225,0.18)',
  },
};

function paletteCss(p) {
  return `
    body {
      background:
        radial-gradient(40rem 30rem at 100% 0%, ${p.blob1} 0%, transparent 55%),
        radial-gradient(36rem 26rem at 0% 100%, ${p.blob2} 0%, transparent 55%),
        linear-gradient(180deg, ${p.base} 0%, #ffffff 100%) !important;
    }
    /* Sidebar logo */
    .logo-img { background: linear-gradient(135deg, ${p.primary}, ${p.primary2}) !important; }
    .logo b { color: ${p.primaryDark} !important; }

    /* Active nav */
    .nav-item.active { background: ${p.pillBg} !important; color: ${p.primaryDark} !important; }
    .nav-item .nav-icon, .nav-item.active .nav-icon { color: ${p.primary} !important; }
    #navDash .nav-icon { background: ${p.pillBg} !important; color: ${p.primaryDark} !important; }
    #navPost .nav-icon { background: ${p.pillBg} !important; color: ${p.primaryDark} !important; }
    #navAcc  .nav-icon { background: ${p.pillBg} !important; color: ${p.primaryDark} !important; }
    #navSpy  .nav-icon { background: ${p.pillBg} !important; color: ${p.primaryDark} !important; }

    /* Header emoji tile */
    .header-emoji {
      background: linear-gradient(135deg, ${p.pillBg}, ${p.pillBg}) !important;
      color: ${p.primaryDark} !important;
    }
    .theme-btn { color: ${p.primary} !important; }

    /* Stat values */
    .stat.green .value { color: ${p.primary} !important; }
    .stat.blue .value  { color: ${p.primaryDark} !important; }
    .stat.purple .value{ color: ${p.primary2} !important; }

    /* Profile avatar */
    .pcard .avatar {
      background: linear-gradient(135deg, ${p.pillBg}, ${p.pillBg}) !important;
      color: ${p.primaryDark} !important;
    }

    /* Panel header dot */
    .panel h3 .dot {
      background: linear-gradient(135deg, ${p.pillBg}, ${p.pillBg}) !important;
      color: ${p.primaryDark} !important;
    }

    /* Chat bubbles */
    .msg.user .bubble {
      background: linear-gradient(135deg, ${hexToRgba(p.primary, 0.92)}, ${hexToRgba(p.primary2, 0.92)}) !important;
    }

    /* CTA */
    .cta {
      background: linear-gradient(135deg, ${hexToRgba(p.primary, 0.92)}, ${hexToRgba(p.primary2, 0.92)}) !important;
      box-shadow: 0 8px 22px ${hexToRgba(p.primary, 0.30)}, inset 0 1px 0 rgba(255,255,255,0.45) !important;
    }

    /* Glass cards: tint shadow màu primary */
    .glass {
      box-shadow:
        0 10px 36px ${hexToRgba(p.primary, 0.10)},
        inset 0 1px 0 rgba(255,255,255,0.7) !important;
    }
  `;
}

function hexToRgba(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  });
  const url = 'file://' + path.resolve(__dirname, 'glass-mockup.html');

  for (const [key, palette] of Object.entries(PALETTES)) {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: paletteCss(palette) });
    // small banner so you can see palette name in screenshot
    await page.addStyleTag({ content: `
      body::after {
        content: "${palette.name}";
        position: fixed; left: 50%; top: 6px; transform: translateX(-50%);
        background: rgba(255,255,255,0.7);
        padding: 4px 14px; border-radius: 999px;
        font-size: 11px; font-weight: 600; color: #555;
        backdrop-filter: blur(8px); z-index: 100;
        box-shadow: 0 2px 8px rgba(0,0,0,0.06);
      }
    ` });
    await page.waitForTimeout(200);
    const out = path.resolve(__dirname, `preview/palette-${key}.png`);
    await page.screenshot({ path: out, fullPage: false });
    console.log('Wrote', out);
    await page.close();
  }
  await browser.close();
})();
