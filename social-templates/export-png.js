const { firefox } = require('/home/paperclip/paperclip/node_modules/@playwright/test');
const path = require('path');
const fs = require('fs');

const TEMPLATES_DIR = '/home/paperclip/despacho/web/social-templates';
const PNG_DIR = path.join(TEMPLATES_DIR, 'png');

const templates = [
  { file: 'post-deudas-1080.html', width: 1080, height: 1080, output: 'post-deudas-1080.png' },
  { file: 'story-bancario-1920.html', width: 1080, height: 1920, output: 'story-bancario-1920.png' },
];

async function exportCarrusel(page) {
  const file = 'carrusel-multas-1080.html';
  const filePath = path.join(TEMPLATES_DIR, file);
  await page.setViewportSize({ width: 1080, height: 1080 });
  await page.goto(`file://${filePath}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // Export slide 1 (default)
  await page.screenshot({ path: path.join(PNG_DIR, 'carrusel-multas-slide1.png'), clip: { x: 0, y: 0, width: 1080, height: 1080 } });
  console.log('Exported carrusel-multas-slide1.png');

  // Try to navigate to slide 2
  const dots = await page.$$('.nav-dot, [data-slide], .dot');
  if (dots.length >= 2) {
    await dots[1].click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(PNG_DIR, 'carrusel-multas-slide2.png'), clip: { x: 0, y: 0, width: 1080, height: 1080 } });
    console.log('Exported carrusel-multas-slide2.png');
  }
  if (dots.length >= 3) {
    await dots[2].click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(PNG_DIR, 'carrusel-multas-slide3.png'), clip: { x: 0, y: 0, width: 1080, height: 1080 } });
    console.log('Exported carrusel-multas-slide3.png');
  }

  // If no nav dots found, try next button
  if (dots.length === 0) {
    // Just export full page as one slide
    await page.screenshot({ path: path.join(PNG_DIR, 'carrusel-multas-full.png'), fullPage: false });
    console.log('Exported carrusel-multas-full.png (no nav dots found)');
  }
}

(async () => {
  fs.mkdirSync(PNG_DIR, { recursive: true });
  const browser = await firefox.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  for (const t of templates) {
    const filePath = path.join(TEMPLATES_DIR, t.file);
    await page.setViewportSize({ width: t.width, height: t.height });
    await page.goto(`file://${filePath}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const outPath = path.join(PNG_DIR, t.output);
    await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: t.width, height: t.height } });
    console.log(`Exported ${t.output}`);
  }

  await exportCarrusel(page);

  await browser.close();
  console.log('All exports done.');
})();
