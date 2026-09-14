// Dev-only tooling: captures screenshots of the running Claude Brain app for
// README docs. Not part of the shipped Docker image. Requires the app to
// already be running (docker compose up -d) at BASE_URL.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4545';
const OUT_DIR = path.join(__dirname, '..', 'docs', 'screenshots');

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  console.log('Navigating to', BASE_URL);
  await page.goto(BASE_URL, { waitUntil: 'networkidle' });

  // Let the mind map physics settle and the initial data load finish.
  await page.waitForTimeout(4000);

  // 1. Mind Map — default overview
  await page.screenshot({ path: path.join(OUT_DIR, 'mindmap-overview.png') });
  console.log('captured mindmap-overview.png');

  // 2. Mind Map — node clicked, detail panel open
  const box = await page.locator('#graphContainer').boundingBox();
  if (box) {
    // Click roughly in the node-dense area near the center; the mind map
    // starts centered on the hub node with agent/session nodes radiating
    // out, so a center-ish click reliably lands on a node.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(600);
    const panelVisible = await page.locator('#detailPanel:not(.hidden)').count();
    if (!panelVisible) {
      // Try a few nearby points in case the click missed a node.
      const offsets = [[40, 0], [-40, 0], [0, 40], [0, -40], [80, 40], [-80, -40]];
      for (const [dx, dy] of offsets) {
        await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
        await page.waitForTimeout(500);
        if (await page.locator('#detailPanel:not(.hidden)').count()) break;
      }
    }
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_DIR, 'mindmap-node-detail.png') });
  console.log('captured mindmap-node-detail.png');

  // 3. Agent filter chips — toggle one off to show active/inactive state
  const chips = page.locator('.chip');
  const chipCount = await chips.count();
  if (chipCount > 0) {
    await chips.nth(0).click();
    await page.waitForTimeout(600);
  }
  await page.screenshot({ path: path.join(OUT_DIR, 'agent-filters.png') });
  console.log('captured agent-filters.png');
  if (chipCount > 0) {
    // restore
    await chips.nth(0).click();
    await page.waitForTimeout(300);
  }

  // 4. Stats / Overview view
  await page.click('.tab[data-tab="stats"]');
  await page.waitForTimeout(2000); // let the chart render
  await page.screenshot({ path: path.join(OUT_DIR, 'stats-overview.png') });
  console.log('captured stats-overview.png');

  // 5. Activity trend chart with custom date-range picker open (distinct
  // visual: the themed calendar popup)
  const customChip = page.locator('.period-chip[data-period="custom"]');
  if (await customChip.count()) {
    await customChip.click();
    await page.waitForTimeout(300);
    await page.click('#rangeFromBtn');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT_DIR, 'stats-date-picker.png') });
    console.log('captured stats-date-picker.png');
    await page.click('body', { position: { x: 5, y: 5 } });
  }

  // 6. Session Manager (Sessions tab)
  await page.click('.tab[data-tab="sessions"]');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT_DIR, 'session-manager.png') });
  console.log('captured session-manager.png');

  await browser.close();
  console.log('Done. Screenshots in', OUT_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
