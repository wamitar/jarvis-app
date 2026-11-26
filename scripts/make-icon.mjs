// Renders the macOS app icon from build/logo.svg: the logo tile inset on a 1024 canvas (Apple's icon grid).
// Run: node scripts/make-icon.mjs build/icon.png [build/logo-dark.svg]   (build/icon.icns is made from the light one with iconutil;
// resources/icon-light.png and resources/icon-dark.png are the Dock icons the app swaps with the system theme)
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
const svg = readFileSync(process.argv[3] || new URL('../build/logo.svg', import.meta.url), 'utf8')
const b = await chromium.launch({ channel: 'chrome' })
const p = await b.newPage({ viewport: { width: 1024, height: 1024 } })
await p.setContent(`<body style="margin:0;background:transparent"><div style="position:absolute;left:100px;top:100px;width:824px;height:824px;filter:drop-shadow(0 12px 18px rgba(0,0,0,.25))">${svg.replace('<svg ', '<svg width="824" height="824" ')}</div></body>`)
await p.screenshot({ path: process.argv[2], omitBackground: true }); await b.close()
