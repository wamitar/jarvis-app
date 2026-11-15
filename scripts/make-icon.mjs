import { chromium } from 'playwright-core'
const b = await chromium.launch({ channel: 'chrome' })
const p = await b.newPage({ viewport: { width: 1024, height: 1024 } })
// macOS app icon: rounded square inset from the canvas, orange with a white J.
await p.setContent(`<body style="margin:0;background:transparent"><div style="position:absolute;left:100px;top:100px;width:824px;height:824px;border-radius:186px;background:linear-gradient(160deg,#F58A34,#E9651A);display:grid;place-items:center;box-shadow:0 12px 30px rgba(0,0,0,.22)">
<svg width="560" height="560" viewBox="0 0 100 100"><path d="M38 22 H68 V60 a22 22 0 0 1 -44 0 V56" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/></svg></div></body>`)
await p.screenshot({ path: process.argv[2], omitBackground: true }); await b.close()
