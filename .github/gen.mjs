import sharp from 'sharp'

const W = 1280
const H = 640

function hash(x, y, seed = 0) {
  const n = Math.sin(x * 12.9898 + y * 78.233 + seed * 43.12) * 43758.5453
  return n - Math.floor(n)
}

function smoothNoise(x, y, seed = 0) {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  return (
    hash(ix, iy, seed) * (1 - ux) * (1 - uy)
    + hash(ix + 1, iy, seed) * ux * (1 - uy)
    + hash(ix, iy + 1, seed) * (1 - ux) * uy
    + hash(ix + 1, iy + 1, seed) * ux * uy
  )
}

function fbm(x, y, octaves = 6, seed = 0) {
  let val = 0
  let amp = 0.5
  let freq = 1
  for (let i = 0; i < octaves; i++) {
    val += smoothNoise(x * freq, y * freq, seed + i * 100) * amp
    freq *= 2
    amp *= 0.5
  }
  return val
}

function clifford(x, y, a, b, c, d) {
  return {
    x: Math.sin(a * y) + c * Math.cos(a * x),
    y: Math.sin(b * x) + d * Math.cos(b * y),
  }
}

// Dark palette (vibrant on dark)
const darkPalette = [
  [1.0, 0.50, 0.28],
  [0.92, 0.38, 0.32],
  [0.40, 0.45, 0.98],
  [0.65, 0.35, 0.88],
  [0.25, 0.82, 0.92],
  [0.92, 0.75, 0.38],
]

// Light palette (deeper/richer on light)
const lightPalette = [
  [0.85, 0.35, 0.15],
  [0.78, 0.22, 0.20],
  [0.20, 0.25, 0.75],
  [0.50, 0.18, 0.70],
  [0.08, 0.55, 0.65],
  [0.75, 0.55, 0.15],
]

function lerpColor(c1, c2, t) {
  return [
    c1[0] + (c2[0] - c1[0]) * t,
    c1[1] + (c2[1] - c1[1]) * t,
    c1[2] + (c2[2] - c1[2]) * t,
  ]
}

async function generateVariant(variant, isLight) {
  const accum = new Float32Array(W * H * 3)
  const pixels = Buffer.alloc(W * H * 3)
  const palette = isLight ? lightPalette : darkPalette

  const addPoint = (x, y, r, g, b, intensity = 1, radius = 2) => {
    const px = Math.floor((x + 2.5) / 5 * W)
    const py = Math.floor((y + 1.25) / 2.5 * H)
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = px + dx
        const ny = py + dy
        if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
          const dist = Math.sqrt(dx * dx + dy * dy)
          const falloff = Math.exp(-dist * 0.6) * intensity
          const i = (ny * W + nx) * 3
          accum[i] += r * falloff
          accum[i + 1] += g * falloff
          accum[i + 2] += b * falloff
        }
      }
    }
  }

  const mode = isLight ? 'light' : 'dark'
  console.log(`V${variant} ${mode}: Rendering...`)

  if (variant === 1) {
    // SPIRAL GALAXY
    for (let arm = 0; arm < 6; arm++) {
      const armAngle = (arm / 6) * Math.PI * 2
      const armColor = palette[arm % palette.length]

      for (let i = 0; i < 150000; i++) {
        const t = i / 150000
        const r = t * 2.2
        const theta = armAngle + t * 8 + Math.sin(t * 20) * 0.3
        const wobble = fbm(t * 10, arm, 3, 123) * 0.15

        const x = Math.cos(theta) * (r + wobble)
        const y = Math.sin(theta) * (r + wobble) * 0.5

        const fade = Math.sin(t * Math.PI) * 0.8 + 0.2
        const color = lerpColor(armColor, palette[(arm + 2) % palette.length], t)
        addPoint(x, y, color[0], color[1], color[2], 0.012 * fade)
      }
    }
    for (let i = 0; i < 50000; i++) {
      const angle = Math.random() * Math.PI * 2
      const r = Math.random() ** 2 * 0.5
      const c = isLight ? [0.6, 0.4, 0.2] : [1, 0.9, 0.7]
      addPoint(Math.cos(angle) * r, Math.sin(angle) * r * 0.5, c[0], c[1], c[2], 0.02)
    }
  }

  else if (variant === 2) {
    // NEURAL MESH
    const nodes = []
    for (let i = 0; i < 40; i++) {
      nodes.push({
        x: (Math.random() - 0.5) * 4,
        y: (Math.random() - 0.5) * 2,
        color: palette[i % palette.length],
      })
    }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dist = Math.sqrt((nodes[i].x - nodes[j].x) ** 2 + (nodes[i].y - nodes[j].y) ** 2)
        if (dist < 1.5) {
          const steps = Math.floor(dist * 200)
          for (let s = 0; s < steps; s++) {
            const t = s / steps
            const midWobble = Math.sin(t * Math.PI) * 0.15
            const wobbleX = fbm(t * 5 + i, j, 3, 42) * midWobble
            const wobbleY = fbm(t * 5 + i + 10, j + 10, 3, 42) * midWobble
            const x = nodes[i].x + (nodes[j].x - nodes[i].x) * t + wobbleX
            const y = nodes[i].y + (nodes[j].y - nodes[i].y) * t + wobbleY
            const color = lerpColor(nodes[i].color, nodes[j].color, t)
            const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 3 + i * 0.5)
            addPoint(x, y, color[0], color[1], color[2], 0.015 * pulse, 3)
          }
        }
      }
    }
    for (const node of nodes) {
      for (let i = 0; i < 3000; i++) {
        const angle = Math.random() * Math.PI * 2
        const r = Math.random() ** 1.5 * 0.2
        addPoint(node.x + Math.cos(angle) * r, node.y + Math.sin(angle) * r, node.color[0], node.color[1], node.color[2], 0.03)
      }
    }
  }

  else if (variant === 3) {
    // AURORA CURTAINS
    for (let curtain = 0; curtain < 12; curtain++) {
      const baseX = (curtain - 5.5) * 0.45
      const color1 = palette[curtain % palette.length]
      const color2 = palette[(curtain + 1) % palette.length]
      for (let layer = 0; layer < 3; layer++) {
        const layerOffset = layer * 0.08
        for (let i = 0; i < 200000; i++) {
          const t = (i % 2000) / 2000
          const strand = Math.floor(i / 2000)
          const strandOffset = (strand - 50) * 0.006
          const y = (t - 0.5) * 2.4
          const wave1 = Math.sin(y * 3 + curtain * 0.7 + layer) * 0.35
          const wave2 = Math.sin(y * 7 + curtain * 1.3) * 0.15
          const wave3 = fbm(y * 2 + layer, curtain * 0.3, 4, 77) * 0.5
          const x = baseX + wave1 + wave2 + wave3 + strandOffset + layerOffset
          const vertFade = (1 - t) ** 0.4
          const horizFade = 1 - Math.abs(strandOffset) * 8
          const fade = vertFade * Math.max(0, horizFade)
          const color = lerpColor(color1, color2, t)
          addPoint(x, y, color[0], color[1], color[2], 0.025 * fade, 3)
        }
      }
    }
    for (let i = 0; i < 30000; i++) {
      const x = (Math.random() - 0.5) * 4.5
      const y = -0.8 - Math.random() * 0.4
      const color = palette[Math.floor(Math.random() * palette.length)]
      addPoint(x, y, color[0], color[1], color[2], 0.08, 2)
    }
  }

  else if (variant === 4) {
    // MANDALA
    const symmetry = 12
    let ax = 0.1
    let ay = 0.1
    for (let i = 0; i < 600000; i++) {
      const next = clifford(ax, ay, -1.7, 1.8, -1.9, -0.4)
      ax = next.x
      ay = next.y
      if (i < 100)
        continue
      const r = Math.sqrt(ax * ax + ay * ay) * 0.5
      const theta = Math.atan2(ay, ax)
      const colorT = (i / 600000)
      const color = lerpColor(palette[0], palette[3], colorT)
      for (let s = 0; s < symmetry; s++) {
        const angle = theta + (s / symmetry) * Math.PI * 2
        const x = Math.cos(angle) * r
        const y = Math.sin(angle) * r * 0.5
        addPoint(x, y, color[0], color[1], color[2], 0.006)
      }
    }
    for (let ray = 0; ray < symmetry; ray++) {
      const angle = (ray / symmetry) * Math.PI * 2
      const color = palette[ray % palette.length]
      for (let i = 0; i < 30000; i++) {
        const t = i / 30000
        const r = t * 2.3
        const wobble = fbm(t * 8, ray, 3, 99) * 0.1 * t
        const x = Math.cos(angle + wobble) * r
        const y = Math.sin(angle + wobble) * r * 0.5
        const fade = (1 - t) * 0.7 + 0.3
        addPoint(x, y, color[0], color[1], color[2], 0.008 * fade)
      }
    }
  }

  else if (variant === 5) {
    // FLUID CURRENTS
    for (let stream = 0; stream < 100; stream++) {
      const startX = (stream / 100 - 0.5) * 6
      const startY = (hash(stream, 0, 42) - 0.5) * 1.5
      const color1 = palette[stream % palette.length]
      const color2 = palette[(stream + 3) % palette.length]
      let x = startX
      let y = startY
      for (let i = 0; i < 500; i++) {
        const angle = fbm(x * 0.4, y * 0.4, 5, 33) * Math.PI * 4
        x += Math.cos(angle) * 0.018
        y += Math.sin(angle) * 0.018
        const t = i / 500
        const color = lerpColor(color1, color2, t)
        const perpAngle = angle + Math.PI / 2
        const width = (1 - t * 0.7) * 0.12
        for (let w = -15; w <= 15; w++) {
          const wt = w / 15
          const wx = x + Math.cos(perpAngle) * wt * width
          const wy = y + Math.sin(perpAngle) * wt * width
          const edgeFade = (1 - Math.abs(wt)) ** 0.5
          addPoint(wx, wy, color[0], color[1], color[2], 0.025 * edgeFade, 2)
        }
      }
    }
    for (let p = 0; p < 150000; p++) {
      let x = (Math.random() - 0.5) * 5
      let y = (Math.random() - 0.5) * 2.5
      const color = palette[Math.floor(Math.random() * palette.length)]
      for (let i = 0; i < 25; i++) {
        const angle = fbm(x * 0.4, y * 0.4, 5, 33) * Math.PI * 4
        x += Math.cos(angle) * 0.015
        y += Math.sin(angle) * 0.015
        addPoint(x, y, color[0], color[1], color[2], 0.008)
      }
    }
  }

  // Tone map with light/dark background
  let maxVal = 0.001
  for (let i = 0; i < accum.length; i++) maxVal = Math.max(maxVal, accum[i])

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3
      const px = (x - W / 2) / W
      const py = (y - H / 2) / H

      // Background
      const bgSeed = variant * 100
      const warp = fbm(px * 2, py * 2, 4, bgSeed) * 0.3
      const nebula = fbm(px * 3 + warp, py * 3 + warp, 5, bgSeed + 50)

      let bgR, bgG, bgB
      if (isLight) {
        bgR = 0.96 - nebula * 0.04
        bgG = 0.95 - nebula * 0.05
        bgB = 0.94 - nebula * 0.03
      }
      else {
        bgR = 0.015 + nebula * 0.02
        bgG = 0.012 + nebula * 0.015
        bgB = 0.025 + nebula * 0.03
      }

      // Blend foreground
      let r = accum[i] / (1 + accum[i] * 0.3)
      let g = accum[i + 1] / (1 + accum[i + 1] * 0.3)
      let b = accum[i + 2] / (1 + accum[i + 2] * 0.3)

      if (isLight) {
        // Subtractive blending for light mode
        r = bgR - r * 0.8
        g = bgG - g * 0.8
        b = bgB - b * 0.8
      }
      else {
        // Additive for dark
        r = bgR + r ** 0.85
        g = bgG + g ** 0.85
        b = bgB + b ** 0.85
      }

      // Vignette
      const vig = isLight ? (1 - Math.sqrt(px * px + py * py) * 0.15) : (1 - Math.sqrt(px * px + py * py) * 0.4)
      r *= vig
      g *= vig
      b *= vig

      // Grain
      const grain = (Math.random() - 0.5) * (isLight ? 0.02 : 0.03)
      r += grain
      g += grain
      b += grain

      pixels[i] = Math.max(0, Math.min(255, r * 255))
      pixels[i + 1] = Math.max(0, Math.min(255, g * 255))
      pixels[i + 2] = Math.max(0, Math.min(255, b * 255))
    }
  }

  const suffix = isLight ? '-light' : '-dark'
  const filename = `.github/banner-v${variant}${suffix}.png`
  await sharp(pixels, { raw: { width: W, height: H, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toFile(filename)
  console.log(`  Saved ${filename}`)
}

// Generate all variants in both light and dark
for (let v = 1; v <= 5; v++) {
  await generateVariant(v, false) // dark
  await generateVariant(v, true) // light
}

console.log('\nAll 10 variants complete!')
