// Independent motion-planner replay of a coupon's G-code: a test oracle for the input shaper
// coupon's corners, kicks and timing. It imports NO production code; every rule is ported from
// the Klipper sources, pinned here:
//
// - Klipper v0.13.0, klippy/toolhead.py: Move.__init__ (accel, junction_deviation and velocity
//   fixed when the move is queued), Move.calc_junction (extruder term, junction deviation,
//   approximated centripetal velocity), LookAheadQueue.flush (ported non-lazy: the lazy flushes
//   only commit moves whose plan can no longer change, so the result is identical),
//   cmd_SET_VELOCITY_LIMIT (no flush) and _calc_junction_deviation, cmd_G4 -> dwell ->
//   get_last_move_time -> lookahead.flush. klippy/kinematics/extruder.py: calc_junction
//   (instantaneous_corner_velocity, default 1.0 mm/s) and check_move (max_extrude_cross_section
//   default 4 * nozzle_diameter^2, tiny-extrusion exemption, E-only and retract moves are not
//   kinematic, so they bound the lookahead on both sides).
//
// The kinematics only decide how a Cartesian velocity maps onto the motors (A = X + Y,
// B = X - Y on CoreXY), which the junction and start reports use for the per-motor kick.
//
// Limitations, stated rather than modelled: Klipper's limited_cartesian / limited_corexy
// max_x_accel and max_y_accel, the finite lookahead buffer (the planner is assumed to see each
// stop-bounded segment whole), step quantization, and Z moves, which the oracle treats as
// planner boundaries (the coupon moves Z only between layers, retracted, nowhere near a
// measured corner).

export type ReplayKinematics = 'cartesian' | 'corexy'

export interface ReplayConfig {
  kinematics: ReplayKinematics
  nozzleDiameterMm?: number
  filamentDiameterMm?: number
  /** A speed factor (M220) persisted from before the print, as a fraction. */
  initialSpeedFactor?: number
}

/** One planned move. Speeds are along the path, mm/s. */
export interface PlannedMove {
  /** Index of the G-code line that commanded the move. */
  line: number
  kind: 'xy' | 'eOnly'
  x0: number
  y0: number
  x1: number
  y1: number
  /** Relative extrusion of the move, mm. */
  e: number
  /** XY length, or |E| for an E-only move, mm. */
  lengthMm: number
  /** Commanded speed after the speed factor, mm/s. */
  feedMmS: number
  /** Speed the planner may cruise at (feed after the velocity limits), mm/s. */
  nominalMmS: number
  accelMmS2: number
  startMmS: number
  cruiseMmS: number
  endMmS: number
  /** The square corner velocity in force when the move was queued, mm/s. */
  cornerLimit: number
}

/** A junction between two consecutive moves of one planner segment. */
export interface PlannedJunction {
  prev: PlannedMove
  next: PlannedMove
  x: number
  y: number
  /** Shared speed at the junction, mm/s. */
  speedMmS: number
  /** Largest per-axis (Cartesian X, Y) velocity jump, mm/s. */
  cartesianStepMmS: number
  /** Largest per-motor velocity jump in the configured kinematics, mm/s. */
  motorStepMmS: number
}

/** The first move of a planner segment, starting from rest. */
export interface PlannedStart {
  move: PlannedMove
  /** Largest per-motor speed the move starts with, mm/s. */
  motorSpeedMmS: number
}

export interface ReplayResult {
  moves: PlannedMove[]
  junctions: PlannedJunction[]
  starts: PlannedStart[]
  /** Moves Klipper's extruder check would refuse ("Move exceeds maximum extrusion"). */
  crossSectionViolations: { line: number; areaMm2: number }[]
}

const KLIPPER_INSTANT_CORNER_V = 1.0

interface Limits {
  kMaxVelocity: number
  kMaxAccel: number
  kScv: number
  kMinCruiseRatio: number
  speedFactor: number
}

/** Klipper config defaults of the coupon's profile, where the G-code sets nothing. */
function initialLimits(config: ReplayConfig): Limits {
  return {
    kMaxVelocity: 300,
    kMaxAccel: 3000,
    kScv: 5,
    kMinCruiseRatio: 0.5,
    speedFactor: config.initialSpeedFactor ?? 1,
  }
}

/** Motor-space components of a Cartesian XY vector: X, Y on Cartesian; A = X + Y,
 *  B = X - Y on CoreXY. */
function motors(kin: ReplayKinematics, x: number, y: number): [number, number] {
  return kin === 'corexy' ? [x + y, x - y] : [x, y]
}

function params(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of text.matchAll(/([A-Z])(-?[\d.]+)/g)) out[m[1]] = Number(m[2])
  return out
}

/** Raw queued move before planning. */
interface RawMove {
  line: number
  kind: 'xy' | 'eOnly'
  x0: number
  y0: number
  x1: number
  y1: number
  e: number
  feedMmS: number
  limits: Limits
}

export function replayGcode(gcode: string, config: ReplayConfig): ReplayResult {
  const nozzle = config.nozzleDiameterMm ?? 0.4
  const filArea = (config.filamentDiameterMm ?? 1.75) ** 2 * 0.25 * Math.PI
  const result: ReplayResult = { moves: [], junctions: [], starts: [], crossSectionViolations: [] }
  let limits = initialLimits(config)
  let x = 0
  let y = 0
  let feedMmMin = 3000
  let segment: RawMove[] = []

  const flush = () => {
    if (segment.length > 0) planSegment(segment, config, result)
    segment = []
  }

  const lines = gcode.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].split(';')[0].trim()
    if (raw === '') continue
    const word = raw.split(/\s+/)[0]
    if (word === 'G4' || word === 'G28') {
      flush()
      if (word === 'G28') {
        x = 0
        y = 0
      }
      continue
    }
    if (word === 'SET_VELOCITY_LIMIT') {
      const kv = Object.fromEntries([...raw.matchAll(/([A-Z_]+)=(-?[\d.]+)/g)].map((m) => [m[1], Number(m[2])]))
      limits = {
        ...limits,
        kMaxVelocity: kv.VELOCITY ?? limits.kMaxVelocity,
        kMaxAccel: kv.ACCEL ?? limits.kMaxAccel,
        kScv: kv.SQUARE_CORNER_VELOCITY ?? limits.kScv,
        kMinCruiseRatio: kv.MINIMUM_CRUISE_RATIO ?? limits.kMinCruiseRatio,
      }
      continue
    }
    const p = params(raw.slice(word.length))
    if (word === 'M204') {
      limits = {
        ...limits,
        // Klipper: S, else the smaller of P and T.
        kMaxAccel: p.S ?? (p.P !== undefined || p.T !== undefined
          ? Math.min(p.P ?? Infinity, p.T ?? Infinity)
          : limits.kMaxAccel),
      }
      continue
    }
    if (word === 'M220') {
      if (p.S !== undefined) limits = { ...limits, speedFactor: p.S / 100 }
      continue
    }
    if (word !== 'G0' && word !== 'G1') continue
    if (p.F !== undefined) feedMmMin = p.F
    if (p.Z !== undefined && p.X === undefined && p.Y === undefined) {
      // Z moves bound the planner segment (see the header).
      flush()
      continue
    }
    const nx = p.X ?? x
    const ny = p.Y ?? y
    const e = p.E ?? 0
    const xyLen = Math.hypot(nx - x, ny - y)
    if (xyLen < 1e-9 && e === 0) continue
    const move: RawMove = {
      line: i,
      kind: xyLen < 1e-9 ? 'eOnly' : 'xy',
      x0: x,
      y0: y,
      x1: nx,
      y1: ny,
      e,
      feedMmS: (feedMmMin / 60) * limits.speedFactor,
      limits,
    }
    if (move.kind === 'eOnly') {
      // Not kinematic: the moves before and after it cannot share a junction with it.
      flush()
      continue
    }
    // extruder.check_move: the cross-section of a forward extrusion move.
    const ratio = e / xyLen
    const maxRatio = (4 * nozzle * nozzle) / filArea
    if (e > 0 && ratio > maxRatio && e > nozzle * maxRatio) {
      result.crossSectionViolations.push({ line: i, areaMm2: ratio * filArea })
    }
    segment.push(move)
    x = nx
    y = ny
  }
  flush()
  return result
}

/** Unit XY direction of a move (zero for E-only). */
function dirXY(m: RawMove): [number, number] {
  const len = Math.hypot(m.x1 - m.x0, m.y1 - m.y0)
  return len > 0 ? [(m.x1 - m.x0) / len, (m.y1 - m.y0) / len] : [0, 0]
}

function planSegment(segment: RawMove[], config: ReplayConfig, result: ReplayResult): void {
  const planned = planKlipper(segment)
  result.moves.push(...planned)
  // The start of the segment and every junction inside it.
  const first = planned[0]
  const [fx, fy] = dirXY(segment[0])
  const [ma, mb] = motors(config.kinematics, fx * first.startMmS, fy * first.startMmS)
  result.starts.push({ move: first, motorSpeedMmS: Math.max(Math.abs(ma), Math.abs(mb)) })
  for (let k = 1; k < planned.length; k++) {
    const prev = planned[k - 1]
    const next = planned[k]
    const v = next.startMmS
    const [px, py] = dirXY(segment[k - 1])
    const [nx, ny] = dirXY(segment[k])
    const dvx = v * (nx - px)
    const dvy = v * (ny - py)
    const [da, db] = motors(config.kinematics, dvx, dvy)
    result.junctions.push({
      prev,
      next,
      x: next.x0,
      y: next.y0,
      speedMmS: v,
      cartesianStepMmS: Math.max(Math.abs(dvx), Math.abs(dvy)),
      motorStepMmS: Math.max(Math.abs(da), Math.abs(db)),
    })
  }
}

function toPlanned(
  m: RawMove,
  lengthMm: number,
  nominalMmS: number,
  accelMmS2: number,
  startMmS: number,
  cruiseMmS: number,
  endMmS: number,
  cornerLimit: number,
): PlannedMove {
  return {
    line: m.line,
    kind: m.kind,
    x0: m.x0,
    y0: m.y0,
    x1: m.x1,
    y1: m.y1,
    e: m.e,
    lengthMm,
    feedMmS: m.feedMmS,
    nominalMmS,
    accelMmS2,
    startMmS,
    cruiseMmS,
    endMmS,
    cornerLimit,
  }
}

// ----------------------------------------------------------------------------- Klipper

interface KMove {
  raw: RawMove
  d: number
  accel: number
  jd: number
  axesR: [number, number, number]
  maxCruiseV2: number
  deltaV2: number
  smoothDeltaV2: number
  maxStartV2: number
  maxSmoothedV2: number
  nextJunctionV2: number
  start: number
  cruise: number
  end: number
}

function planKlipper(segment: RawMove[]): PlannedMove[] {
  const queue: KMove[] = []
  for (const m of segment) {
    const L = m.limits
    const d = Math.hypot(m.x1 - m.x0, m.y1 - m.y0)
    const velocity = Math.min(m.feedMmS, L.kMaxVelocity)
    const accel = L.kMaxAccel
    const accelToDecel = accel * (1 - L.kMinCruiseRatio)
    const move: KMove = {
      raw: m,
      d,
      accel,
      // toolhead._calc_junction_deviation
      jd: (L.kScv * L.kScv * (Math.SQRT2 - 1)) / accel,
      axesR: [(m.x1 - m.x0) / d, (m.y1 - m.y0) / d, m.e / d],
      maxCruiseV2: velocity * velocity,
      deltaV2: 2 * d * accel,
      smoothDeltaV2: 2 * d * accelToDecel,
      maxStartV2: 0,
      maxSmoothedV2: 0,
      nextJunctionV2: 999999999.9,
      start: 0,
      cruise: 0,
      end: 0,
    }
    const prev = queue[queue.length - 1]
    if (prev) klipperCalcJunction(move, prev)
    queue.push(move)
  }
  klipperFlush(queue)
  return queue.map((k) =>
    toPlanned(k.raw, k.d, Math.sqrt(k.maxCruiseV2), k.accel, k.start, k.cruise, k.end, k.raw.limits.kScv),
  )
}

function klipperCalcJunction(move: KMove, prev: KMove): void {
  // extruder.calc_junction
  const diffR = move.axesR[2] - prev.axesR[2]
  const extruderV2 = diffR ? (KLIPPER_INSTANT_CORNER_V / Math.abs(diffR)) ** 2 : move.maxCruiseV2
  let maxStartV2 = Math.min(
    extruderV2,
    move.maxCruiseV2,
    prev.maxCruiseV2,
    prev.nextJunctionV2,
    prev.maxStartV2 + prev.deltaV2,
  )
  const jcos = -(move.axesR[0] * prev.axesR[0] + move.axesR[1] * prev.axesR[1])
  const sinD2 = Math.sqrt(Math.max(0.5 * (1 - jcos), 0))
  const cosD2 = Math.sqrt(Math.max(0.5 * (1 + jcos), 0))
  const oneMinusSin = 1 - sinD2
  if (oneMinusSin > 0 && cosD2 > 0) {
    const rJd = sinD2 / oneMinusSin
    const moveJdV2 = rJd * move.jd * move.accel
    const pmoveJdV2 = rJd * prev.jd * prev.accel
    const quarterTan = (0.25 * sinD2) / cosD2
    maxStartV2 = Math.min(maxStartV2, moveJdV2, pmoveJdV2, move.deltaV2 * quarterTan, prev.deltaV2 * quarterTan)
  }
  move.maxStartV2 = maxStartV2
  move.maxSmoothedV2 = Math.min(maxStartV2, prev.maxSmoothedV2 + prev.smoothDeltaV2)
}

function klipperSetJunction(m: KMove, startV2: number, cruiseV2: number, endV2: number): void {
  m.start = Math.sqrt(startV2)
  m.cruise = Math.sqrt(cruiseV2)
  m.end = Math.sqrt(endV2)
}

/** LookAheadQueue.flush(lazy=False): the queue ends at rest. */
function klipperFlush(queue: KMove[]): void {
  let delayed: [KMove, number, number][] = []
  let nextEndV2 = 0
  let nextSmoothedV2 = 0
  let peakCruiseV2 = 0
  for (let i = queue.length - 1; i >= 0; i--) {
    const move = queue[i]
    const reachableStartV2 = nextEndV2 + move.deltaV2
    const startV2 = Math.min(move.maxStartV2, reachableStartV2)
    const reachableSmoothedV2 = nextSmoothedV2 + move.smoothDeltaV2
    const smoothedV2 = Math.min(move.maxSmoothedV2, reachableSmoothedV2)
    if (smoothedV2 < reachableSmoothedV2) {
      if (smoothedV2 + move.smoothDeltaV2 > nextSmoothedV2 || delayed.length > 0) {
        peakCruiseV2 = Math.min(move.maxCruiseV2, (smoothedV2 + reachableSmoothedV2) * 0.5)
        if (delayed.length > 0) {
          let mcV2 = peakCruiseV2
          for (const [m, msV2, meV2] of [...delayed].reverse()) {
            mcV2 = Math.min(mcV2, msV2)
            klipperSetJunction(m, Math.min(msV2, mcV2), mcV2, Math.min(meV2, mcV2))
          }
          delayed = []
        }
      }
      const cruiseV2 = Math.min((startV2 + reachableStartV2) * 0.5, move.maxCruiseV2, peakCruiseV2)
      klipperSetJunction(move, Math.min(startV2, cruiseV2), cruiseV2, Math.min(nextEndV2, cruiseV2))
    } else {
      delayed.push([move, startV2, nextEndV2])
    }
    nextEndV2 = startV2
    nextSmoothedV2 = smoothedV2
  }
}

// ----------------------------------------------------------------------------- timing

/**
 * Time since the start of a planned move at which it has covered sMm, through its planned
 * acceleration phase and cruise.
 */
export function timeAtDistanceInMove(move: PlannedMove, sMm: number): number {
  const v0 = move.startMmS
  const vc = move.cruiseMmS
  const a = move.accelMmS2
  const T = (vc - v0) / a
  const rampMm = (vc * vc - v0 * v0) / (2 * a)
  if (sMm > rampMm) return T + (sMm - rampMm) / vc
  return (Math.sqrt(v0 * v0 + 2 * a * sMm) - v0) / a
}
