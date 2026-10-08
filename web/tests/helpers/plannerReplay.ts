// Independent motion-planner replay of a coupon's G-code: a test oracle for the input shaper
// coupon's corners, kicks and timing. It imports NO production code; every rule is ported from
// the firmware sources, pinned here:
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
// - Marlin 2.1.2.5, Marlin/src/module/planner.cpp _populate_block: per-axis feedrate limit,
//   acceleration (print, travel or retract acceleration, then the per-axis M201 limits),
//   junction deviation (unit vector over the axes and E, in motor space on CoreXY, normalized
//   with E; JD_HANDLE_SMALL_SEGMENTS polynomial acos, enabled by default), classic jerk
//   (safe_speed, the empty-queue branch vmax_junction = safe_speed, the coasting/reversal jerk
//   rule, the previous_safe_speed override; per motor on CoreXY because current_speed is
//   steps_dist_mm), reverse_pass_kernel / forward_pass_kernel with max_allowable_speed_sqr and
//   MINIMUM_PLANNER_SPEED 0.05 mm/s. Conditionals_adv.h: CLASSIC_JERK and junction deviation
//   are exclusive on Cartesian and CoreXY machines. gcode/motion/G4.cpp: G4 always calls
//   planner.synchronize(). stepper.cpp: S_CURVE_ACCELERATION replaces each acceleration phase
//   by the quintic Bezier v0 + dv (10 tau^3 - 15 tau^4 + 6 tau^5) over the same duration.
//   Configuration.h defaults: E jerk 5 mm/s, retract acceleration 3000 mm/s^2, maximum
//   accelerations Z 100 and E 10000 mm/s^2.
// - RepRapFirmware 3.5.4, src/Movement/DDA.cpp: InitStandardMove (directionVector is the
//   user-space Cartesian delta, extruders as E per mm of the linear move; moves meld only when
//   isPrintingMove, xyMoving and isNonPrintingExtruderMove agree at jerk policy 0),
//   MatchSpeeds (per-drive jerk on the direction vector difference); Kinematics/
//   CoreKinematics.cpp LimitSpeedAndAcceleration (only speed and acceleration are limited per
//   motor); GCodes.cpp DoDwell (G4 waits for standstill once motion was commanded);
//   Config/Configuration.h DefaultEInstantDv 5 mm/s.
//
// Finding on CoreXY jerk: RepRapFirmware applies M566 to the Cartesian move direction also on
// CoreXY (MatchSpeeds reads directionVector, the user-space delta; CoreKinematics limits only
// speed and acceleration per motor), so the value a Cartesian corner needs is also the value a
// CoreXY corner needs. Marlin classic jerk works per motor on CoreXY (A = X + Y, B = X - Y),
// where its reversal rule counts a motor reversing from -c to +c as a jerk of c.
//
// Limitations, stated rather than modelled: Klipper's limited_cartesian / limited_corexy
// max_x_accel and max_y_accel, Marlin's M200 L volumetric limit, the firmwares' finite lookahead
// buffers (the planner is assumed to see each stop-bounded segment whole), step quantization,
// and Z moves, which the oracle treats as planner boundaries (the coupon moves Z only between
// layers, retracted, nowhere near a measured corner).

export type ReplayFirmware = 'klipper' | 'marlinJd' | 'marlinClassic' | 'rrf'
export type ReplayKinematics = 'cartesian' | 'corexy'

export interface ReplayConfig {
  firmware: ReplayFirmware
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
  /** The firmware corner limit in force when the move was queued: Klipper square corner
   *  velocity, Marlin classic X jerk, Marlin junction deviation (mm), RRF X jerk (mm/s). */
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

/** The first move of a planner segment, starting from rest or from a jerk-limited speed. */
export interface PlannedStart {
  move: PlannedMove
  /** Largest per-motor speed the move starts with, mm/s. */
  motorSpeedMmS: number
}

export interface ReplayResult {
  moves: PlannedMove[]
  junctions: PlannedJunction[]
  starts: PlannedStart[]
  /** Klipper only: moves its extruder check would refuse ("Move exceeds maximum extrusion"). */
  crossSectionViolations: { line: number; areaMm2: number }[]
}

const MARLIN_MINIMUM_PLANNER_SPEED = 0.05
const KLIPPER_INSTANT_CORNER_V = 1.0
const RRF_DEFAULT_E_JERK = 5

interface Limits {
  // Klipper
  kMaxVelocity: number
  kMaxAccel: number
  kScv: number
  kMinCruiseRatio: number
  // Marlin
  mPrintAccel: number
  mTravelAccel: number
  mRetractAccel: number
  mMaxAccel: [number, number, number, number]
  mMaxFeed: [number, number, number, number]
  mJerk: [number, number, number, number]
  mJdMm: number
  // RRF
  rPrintAccel: number
  rTravelAccel: number
  rMaxAccel: [number, number, number, number]
  rMaxFeed: [number, number, number, number]
  rJerk: [number, number, number, number]
  speedFactor: number
}

/** Firmware power-on defaults where the G-code sets nothing (Klipper config defaults of the
 *  coupon's profile; Marlin and RRF configuration defaults). */
function initialLimits(config: ReplayConfig): Limits {
  return {
    kMaxVelocity: 300,
    kMaxAccel: 3000,
    kScv: 5,
    kMinCruiseRatio: 0.5,
    mPrintAccel: 3000,
    mTravelAccel: 3000,
    mRetractAccel: 3000,
    mMaxAccel: [3000, 3000, 100, 10000],
    mMaxFeed: [300, 300, 5, 25],
    mJerk: [10, 10, 0.3, 5],
    mJdMm: 0.013,
    rPrintAccel: 3000,
    rTravelAccel: 3000,
    rMaxAccel: [3000, 3000, 100, 10000],
    rMaxFeed: [300, 300, 5, 25],
    rJerk: [15, 15, 10, RRF_DEFAULT_E_JERK],
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
        mPrintAccel: p.P ?? p.S ?? limits.mPrintAccel,
        mTravelAccel: p.T ?? p.S ?? limits.mTravelAccel,
        mRetractAccel: p.R ?? limits.mRetractAccel,
        rPrintAccel: p.P ?? limits.rPrintAccel,
        rTravelAccel: p.T ?? limits.rTravelAccel,
      }
      continue
    }
    if (word === 'M201') {
      const set = (a: [number, number, number, number]): [number, number, number, number] =>
        [p.X ?? a[0], p.Y ?? a[1], p.Z ?? a[2], p.E ?? a[3]]
      limits = { ...limits, mMaxAccel: set(limits.mMaxAccel), rMaxAccel: set(limits.rMaxAccel) }
      continue
    }
    if (word === 'M203') {
      const mm = [p.X, p.Y, p.Z, p.E]
      limits = {
        ...limits,
        mMaxFeed: limits.mMaxFeed.map((v, k) => mm[k] ?? v) as Limits['mMaxFeed'],
        // RRF M203 is in mm/min.
        rMaxFeed: limits.rMaxFeed.map((v, k) => (mm[k] !== undefined ? mm[k]! / 60 : v)) as Limits['rMaxFeed'],
      }
      continue
    }
    if (word === 'M205') {
      limits = {
        ...limits,
        mJerk: [p.X ?? limits.mJerk[0], p.Y ?? limits.mJerk[1], p.Z ?? limits.mJerk[2], p.E ?? limits.mJerk[3]],
        mJdMm: p.J ?? limits.mJdMm,
      }
      continue
    }
    if (word === 'M566') {
      const j = limits.rJerk
      limits = {
        ...limits,
        rJerk: [
          p.X !== undefined ? p.X / 60 : j[0],
          p.Y !== undefined ? p.Y / 60 : j[1],
          p.Z !== undefined ? p.Z / 60 : j[2],
          p.E !== undefined ? p.E / 60 : j[3],
        ],
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
    if (config.firmware === 'klipper') {
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
    }
    if (config.firmware === 'rrf') {
      if (move.kind === 'eOnly') {
        flush()
        continue
      }
      const prev = segment[segment.length - 1]
      if (prev && (prev.e > 0) !== (e > 0)) flush()
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
  const planned =
    config.firmware === 'klipper'
      ? planKlipper(segment)
      : config.firmware === 'rrf'
        ? planRrf(segment, config.kinematics)
        : planMarlin(segment, config)
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

// ----------------------------------------------------------------------------- Marlin

interface MBlock {
  raw: RawMove
  mm: number
  nominal: number
  accel: number
  maxEntryV2: number
  entryV2: number
  cornerLimit: number
}

function marlinAcos(junctionCos: number): number {
  // planner.cpp, JD_HANDLE_SMALL_SEGMENTS without JD_USE_MATH_ACOS / JD_USE_LOOKUP_TABLE.
  const neg = junctionCos < 0 ? -1 : 1
  const t = neg * junctionCos
  const asinx =
    0.032843707 +
    t * (-1.451838349 + t * (29.66153956 + t * (-131.1123477 + t * (262.8130562 + t * (-242.7199627 + t * 84.31466202)))))
  return Math.PI / 2 + neg * asinx
}

function planMarlin(segment: RawMove[], config: ReplayConfig): PlannedMove[] {
  const classic = config.firmware === 'marlinClassic'
  const blocks: MBlock[] = []
  // Planner statics, only consulted while moves are queued in this segment.
  let prevUnit: number[] = [0, 0, 0, 0]
  let prevSpeed: number[] = [0, 0, 0, 0]
  let prevNominal = 0
  let prevSafe = 0
  for (const m of segment) {
    const L = m.limits
    const dx = m.x1 - m.x0
    const dy = m.y1 - m.y0
    const [da, db] = motors(config.kinematics, dx, dy)
    const delta = [da, db, 0, m.e]
    const headMm = Math.hypot(dx, dy)
    const mm = headMm > 0 ? headMm : Math.abs(m.e)
    const inverseSecs = m.feedMmS / mm
    let speed = delta.map((d) => d * inverseSecs)
    let speedFactor = 1
    speed.forEach((cs, k) => {
      if (Math.abs(cs) > L.mMaxFeed[k]) speedFactor = Math.min(speedFactor, L.mMaxFeed[k] / Math.abs(cs))
    })
    speed = speed.map((cs) => cs * speedFactor)
    const nominal = mm * inverseSecs * speedFactor
    // Acceleration: retract-only, print or travel; then the per-axis maxima.
    let accel = headMm === 0 ? L.mRetractAccel : m.e !== 0 ? L.mPrintAccel : L.mTravelAccel
    if (headMm > 0) {
      delta.forEach((d, k) => {
        if (d !== 0) accel = Math.min(accel, (L.mMaxAccel[k] * mm) / Math.abs(d))
      })
    }
    const queued = blocks.length > 0 && prevNominal > 1e-9
    let vmaxV2: number
    if (!classic) {
      // Junction deviation.
      let unit = delta.slice()
      const norm = Math.hypot(...unit)
      unit = config.kinematics === 'corexy' || m.e !== 0 ? unit.map((u) => u / norm) : unit.map((u) => u / mm)
      if (queued) {
        let jcos = -(prevUnit[0] * unit[0] + prevUnit[1] * unit[1] + prevUnit[2] * unit[2] + prevUnit[3] * unit[3])
        if (jcos > 0.999999) {
          vmaxV2 = MARLIN_MINIMUM_PLANNER_SPEED ** 2
        } else {
          const jv = unit.map((u, k) => u - prevUnit[k])
          const jn = Math.hypot(...jv)
          const ju = jv.map((v) => v / jn)
          let ja = accel
          ju.forEach((u, k) => {
            if (u !== 0 && ja * Math.abs(u) > L.mMaxAccel[k]) ja = Math.abs(L.mMaxAccel[k] / u)
          })
          jcos = Math.max(jcos, -0.999999)
          const sinD2 = Math.sqrt(0.5 * (1 - jcos))
          vmaxV2 = (ja * L.mJdMm * sinD2) / (1 - sinD2)
          if (mm < 1 && jcos < -0.7071067812) {
            vmaxV2 = Math.min(vmaxV2, (mm * ja) / marlinAcos(jcos))
          }
        }
        vmaxV2 = Math.min(vmaxV2, nominal * nominal, prevNominal * prevNominal)
      } else {
        vmaxV2 = 0
      }
      prevUnit = unit
    } else {
      // Classic jerk.
      let safe = nominal
      let limited = 0
      speed.forEach((cs, k) => {
        const jerk = Math.abs(cs)
        const maxj = L.mJerk[k]
        if (jerk > maxj) {
          if (limited) {
            const mjerk = nominal * maxj
            if (jerk * safe > mjerk) safe = mjerk / jerk
          } else {
            safe *= maxj / jerk
            limited++
          }
        }
      })
      let vmax: number
      if (queued) {
        let vFactor = 1
        let lim = 0
        let smaller = 1
        if (nominal < prevNominal) {
          vmax = nominal
          smaller = vmax / prevNominal
        } else {
          vmax = prevNominal
        }
        speed.forEach((cs, k) => {
          let vExit = prevSpeed[k] * smaller
          let vEntry = cs
          if (lim) {
            vExit *= vFactor
            vEntry *= vFactor
          }
          const jerk =
            vExit > vEntry
              ? vEntry > 0 || vExit < 0
                ? vExit - vEntry
                : Math.max(vExit, -vEntry)
              : vEntry < 0 || vExit > 0
                ? vEntry - vExit
                : Math.max(-vExit, vEntry)
          if (jerk > L.mJerk[k]) {
            vFactor *= L.mJerk[k] / jerk
            lim++
          }
        })
        if (lim) vmax *= vFactor
        const threshold = vmax * 0.99
        if (prevSafe > threshold && safe > threshold) vmax = safe
      } else {
        vmax = safe
      }
      prevSafe = safe
      vmaxV2 = vmax * vmax
    }
    prevSpeed = speed
    prevNominal = nominal
    blocks.push({
      raw: m,
      mm,
      nominal,
      accel,
      maxEntryV2: vmaxV2,
      entryV2: 0,
      cornerLimit: classic ? L.mJerk[0] : L.mJdMm,
    })
  }
  // Reverse pass from the synchronize at the end, then the forward pass.
  let nextEntryV2 = MARLIN_MINIMUM_PLANNER_SPEED ** 2
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    b.entryV2 = Math.min(b.maxEntryV2, nextEntryV2 + 2 * b.accel * b.mm)
    nextEntryV2 = b.entryV2
  }
  for (let i = 1; i < blocks.length; i++) {
    const p = blocks[i - 1]
    blocks[i].entryV2 = Math.min(blocks[i].entryV2, p.entryV2 + 2 * p.accel * p.mm)
  }
  return blocks.map((b, i) => {
    const start = Math.sqrt(b.entryV2)
    const endV2 = i + 1 < blocks.length ? blocks[i + 1].entryV2 : MARLIN_MINIMUM_PLANNER_SPEED ** 2
    const cruise = Math.sqrt(Math.min(b.nominal * b.nominal, (2 * b.accel * b.mm + b.entryV2 + endV2) / 2))
    return toPlanned(b.raw, b.mm, b.nominal, b.accel, start, Math.max(cruise, start), Math.sqrt(endV2), b.cornerLimit)
  })
}

// ----------------------------------------------------------------------------- RepRapFirmware

function planRrf(segment: RawMove[], kin: ReplayKinematics): PlannedMove[] {
  const n = segment.length
  const dirs: number[][] = []
  const requested: number[] = []
  const accels: number[] = []
  const lens: number[] = []
  for (const m of segment) {
    const L = m.limits
    const len = Math.hypot(m.x1 - m.x0, m.y1 - m.y0)
    const dir = [(m.x1 - m.x0) / len, (m.y1 - m.y0) / len, 0, m.e / len]
    let speed = m.feedMmS
    let accel = m.e > 0 ? L.rPrintAccel : L.rTravelAccel
    if (kin === 'corexy') {
      // CoreKinematics::LimitSpeedAndAcceleration: per motor.
      const [fa, fb] = motors(kin, dir[0], dir[1])
      for (const [f, k] of [[fa, 0], [fb, 1]] as const) {
        if (f !== 0) {
          speed = Math.min(speed, L.rMaxFeed[k] / Math.abs(f))
          accel = Math.min(accel, L.rMaxAccel[k] / Math.abs(f))
        }
      }
    } else {
      for (let k = 0; k < 2; k++) {
        if (dir[k] !== 0) {
          speed = Math.min(speed, L.rMaxFeed[k] / Math.abs(dir[k]))
          accel = Math.min(accel, L.rMaxAccel[k] / Math.abs(dir[k]))
        }
      }
    }
    dirs.push(dir)
    requested.push(speed)
    accels.push(accel)
    lens.push(len)
  }
  // Junction limits: DDA::MatchSpeeds on the Cartesian direction vectors, with the jerk in
  // force when the later move was added.
  const maxEntry = new Array<number>(n).fill(0)
  for (let k = 1; k < n; k++) {
    let target = Math.min(requested[k - 1], requested[k])
    const jerk = segment[k].limits.rJerk
    for (let d = 0; d < 4; d++) {
      const tf = Math.abs(dirs[k - 1][d] - dirs[k][d])
      if (tf > 0 && tf * target > jerk[d]) target = jerk[d] / tf
    }
    maxEntry[k] = target
  }
  // Reachability: the segment starts and ends at standstill.
  const entry = maxEntry.slice()
  let next = 0
  for (let k = n - 1; k >= 0; k--) {
    entry[k] = Math.min(entry[k], Math.sqrt(next * next + 2 * accels[k] * lens[k]))
    next = entry[k]
  }
  for (let k = 1; k < n; k++) {
    entry[k] = Math.min(entry[k], Math.sqrt(entry[k - 1] ** 2 + 2 * accels[k - 1] * lens[k - 1]))
  }
  return segment.map((m, k) => {
    const end = k + 1 < n ? entry[k + 1] : 0
    const cruise = Math.sqrt(Math.min(requested[k] ** 2, (2 * accels[k] * lens[k] + entry[k] ** 2 + end ** 2) / 2))
    return toPlanned(m, lens[k], requested[k], accels[k], entry[k], cruise, end, m.limits.rJerk[0])
  })
}

// ----------------------------------------------------------------------------- timing

/**
 * Time since the start of a planned move at which it has covered sMm, through its planned
 * acceleration phase and cruise. With `sCurve` the acceleration phase follows Marlin's quintic
 * Bezier, v0 + dv (10 tau^3 - 15 tau^4 + 6 tau^5) over the trapezoid's duration, solved for
 * the time by bisection on its distance integral.
 */
export function timeAtDistanceInMove(move: PlannedMove, sMm: number, sCurve = false): number {
  const v0 = move.startMmS
  const vc = move.cruiseMmS
  const a = move.accelMmS2
  const T = (vc - v0) / a
  const rampMm = (vc * vc - v0 * v0) / (2 * a)
  if (sMm > rampMm) return T + (sMm - rampMm) / vc
  if (!sCurve) return (Math.sqrt(v0 * v0 + 2 * a * sMm) - v0) / a
  let lo = 0
  let hi = T
  for (let k = 0; k < 80; k++) {
    const mid = 0.5 * (lo + hi)
    const tau = mid / T
    const s = v0 * mid + (vc - v0) * T * (2.5 * tau ** 4 - 3 * tau ** 5 + tau ** 6)
    if (s < sMm) lo = mid
    else hi = mid
  }
  return 0.5 * (lo + hi)
}

/** Distance an S-curve acceleration phase from v0 to v1 at the trapezoid's duration covers,
 *  integrated numerically (Simpson's rule) from the Bezier velocity. */
export function sCurveRampDistanceMm(v0: number, v1: number, accelMmS2: number): number {
  const T = (v1 - v0) / accelMmS2
  const steps = 2000
  const h = T / steps
  const v = (t: number) => {
    const tau = t / T
    return v0 + (v1 - v0) * (10 * tau ** 3 - 15 * tau ** 4 + 6 * tau ** 5)
  }
  let sum = v(0) + v(T)
  for (let k = 1; k < steps; k++) sum += (k % 2 === 1 ? 4 : 2) * v(k * h)
  return (sum * h) / 3
}
