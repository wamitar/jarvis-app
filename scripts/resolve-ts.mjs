// Lets plain Node run the app's TypeScript sources (which import without file extensions) for tests.
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && !/\.(ts|mjs|js|json)$/.test(specifier) && context.parentURL) {
      const u = new URL(specifier + '.ts', context.parentURL)
      if (existsSync(fileURLToPath(u))) return next(u.href, context)
      const idx = new URL(specifier + '/index.ts', context.parentURL)
      if (existsSync(fileURLToPath(idx))) return next(idx.href, context)
    }
    return next(specifier, context)
  }
})
