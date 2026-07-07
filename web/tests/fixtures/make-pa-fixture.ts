// One-off generator for the e2e PA fixture. Run from web/ with:
//   npx tsx tests/fixtures/make-pa-fixture.ts
// Renders a synthetic PA coupon scan with ground truth PA 0.03, rotated 3 degrees,
// default noise, and writes it to web/e2e/fixtures/pa_synthetic.png.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { renderPaScan } from '../helpers/paRender'

const img = renderPaScan({ truePa: 0.03, rotationDegrees: 3 })
const png = new PNG({ width: img.width, height: img.height })
png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength)
const out = fileURLToPath(new URL('../../e2e/fixtures/pa_synthetic.png', import.meta.url))
writeFileSync(out, PNG.sync.write(png))
console.log(`wrote ${out} (${img.width}x${img.height})`)
