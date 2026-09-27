import { NIGHT_START_MINUTES, NIGHT_TOTAL_MINUTES, type ObsNight } from '../types/night';
import type { ObsTarget } from '../types/target';

export const DEG = Math.PI / 180;

/** 儒略日 */
export function julianDate(date: Date): number {
  return date.getTime() / 86_400_000 + 2440587.5;
}

/** 本地恒星时（小时，0~24） */
export function localSiderealTime(date: Date, lngDeg: number): number {
  const jd = julianDate(date);
  const t = (jd - 2451545.0) / 36525;
  let gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * t * t;
  gmst = ((gmst % 360) + 360) % 360;
  const lst = (((gmst + lngDeg) % 360) + 360) % 360;
  return lst / 15;
}

/** 地平高度角（度）：由赤经赤纬、站点经纬度与时刻计算 */
export function altitudeAt(
  target: Pick<ObsTarget, 'raHours' | 'decDeg'>,
  date: Date,
  latDeg: number,
  lngDeg: number,
): number {
  const lst = localSiderealTime(date, lngDeg);
  let ha = ((lst - target.raHours) * 15) % 360;
  if (ha > 180) ha -= 360;
  if (ha < -180) ha += 360;
  const sinAlt =
    Math.sin(target.decDeg * DEG) * Math.sin(latDeg * DEG) +
    Math.cos(target.decDeg * DEG) * Math.cos(latDeg * DEG) * Math.cos(ha * DEG);
  return Number((Math.asin(Math.max(-1, Math.min(1, sinAlt))) / DEG).toFixed(1));
}

/** 'HH:mm' → 该夜时间轴刻度（18:00 起算的分钟数，跨零点自动 +1440） */
export function axisMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((v) => Number(v) || 0);
  const clock = h * 60 + m;
  return clock >= NIGHT_START_MINUTES ? clock - NIGHT_START_MINUTES : clock + (1440 - NIGHT_START_MINUTES);
}

/** 时间轴刻度 → 'HH:mm' */
export function minutesToTime(axis: number): string {
  const total = ((NIGHT_START_MINUTES + axis) % 1440 + 1440) % 1440;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 排程段时长（分钟，支持跨零点） */
export function durationMinutes(startTime: string, endTime: string): number {
  const start = axisMinutes(startTime);
  let end = axisMinutes(endTime);
  if (end <= start) end += 1440;
  return end - start;
}

/** 两个区间重叠分钟数（跨零点安全） */
export function overlapMinutes(aStart: string, aEnd: string, bStart: string, bEnd: string): number {
  const a1 = axisMinutes(aStart);
  let a2 = axisMinutes(aEnd);
  if (a2 <= a1) a2 += 1440;
  const b1 = axisMinutes(bStart);
  let b2 = axisMinutes(bEnd);
  if (b2 <= b1) b2 += 1440;
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

/** 分钟数 → '6h30m' */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h${String(m).padStart(2, '0')}m`;
}

/** 可见窗口 */
export interface VisibilityWindow {
  /** 可观测起始时刻 HH:mm */
  startText: string;
  /** 可观测结束时刻 HH:mm */
  endText: string;
  /** 最大地平高度角（度） */
  maxAltitude: number;
  /** 可观测时长（分钟） */
  durationMinutes: number;
}

/**
 * 本地计算目标的可见窗口：从日落到日出每 stepMinutes 采样地平高度角，
 * 取连续满足最小高度阈值的区间。
 */
export function visibilityWindow(target: ObsTarget, night: ObsNight, stepMinutes = 10): VisibilityWindow | null {
  const base = new Date(`${night.date}T18:00:00`);
  const from = sunsetAxis(night);
  const to = sunriseAxis(night);
  const samples: Array<{ axis: number; altitude: number }> = [];
  for (let axis = from; axis <= to; axis += stepMinutes) {
    const date = new Date(base.getTime() + axis * 60_000);
    samples.push({ axis, altitude: altitudeAt(target, date, night.siteLat, night.siteLng) });
  }
  const visible = samples.filter((sample) => sample.altitude >= target.minAltitude);
  if (visible.length === 0) return null;
  const startAxis = visible[0].axis;
  const endAxis = visible[visible.length - 1].axis + stepMinutes;
  return {
    startText: minutesToTime(startAxis),
    endText: minutesToTime(endAxis),
    maxAltitude: Number(Math.max(...visible.map((sample) => sample.altitude)).toFixed(1)),
    durationMinutes: endAxis - startAxis,
  };
}

/** 是否低于最小地平高度角阈值（低于阈值排程时自动标灰） */
export function isBelowThreshold(altitude: number, minAltitude: number): boolean {
  return altitude < minAltitude;
}

/** 月相亮度折算（0~1）：月相百分比越高，天空背景越亮 */
export function moonBrightnessFactor(moonPhasePct: number): number {
  return Number((Math.max(0, Math.min(100, moonPhasePct)) / 100).toFixed(2));
}

/** 月相与目标亮度冲突提示（无冲突返回 undefined） */
export function moonConflict(target: Pick<ObsTarget, 'magnitude' | 'name'>, moonPhasePct: number): string | undefined {
  if (moonPhasePct >= 85 && target.magnitude >= 6) {
    return `接近满月（${moonPhasePct}%），目标 ${target.name} 视星等 ${target.magnitude}，建议改为明目标或转备用夜`;
  }
  if (moonPhasePct >= 60 && target.magnitude >= 8) {
    return `月相偏亮（${moonPhasePct}%），暗目标 ${target.name}（${target.magnitude} 等）对比度下降，建议加长曝光或转备用夜`;
  }
  return undefined;
}

/** 日落在时间轴上的刻度：18:00 前日落（axisMinutes 会映到次日）时按轴起点 0 处理 */
export function sunsetAxis(night: Pick<ObsNight, 'sunset'>): number {
  const axis = axisMinutes(night.sunset);
  return axis > NIGHT_TOTAL_MINUTES ? 0 : axis;
}

/** 日出在时间轴上的刻度：超出轴末端时按 NIGHT_TOTAL_MINUTES 截断 */
export function sunriseAxis(night: Pick<ObsNight, 'sunrise'>): number {
  return Math.min(axisMinutes(night.sunrise) || NIGHT_TOTAL_MINUTES, NIGHT_TOTAL_MINUTES);
}

/** 月出→月落区间（夜间时间轴刻度，跨零点安全；附带回绕副本，覆盖月出在 18:00 前等情形） */
export function moonUpIntervals(night: Pick<ObsNight, 'moonrise' | 'moonset'>): Array<[number, number]> {
  const rise = axisMinutes(night.moonrise);
  let set = axisMinutes(night.moonset);
  if (set <= rise) set += 1440;
  return [
    [rise, set],
    [rise - 1440, set - 1440],
  ];
}

/** 某刻度月亮是否在空中（时段落在月出到月落之间） */
export function isMoonUpAt(night: Pick<ObsNight, 'moonrise' | 'moonset'>, axis: number): boolean {
  return moonUpIntervals(night).some(([from, to]) => axis >= from && axis <= to);
}

/** 月光干扰判定：月相 ≥85% 时 6 等以上、≥60% 时 8 等以上暗目标受影响（不判定月出月落） */
export function moonInterferenceReason(target: Pick<ObsTarget, 'magnitude'>, moonPhasePct: number): string | undefined {
  if (moonPhasePct >= 85 && target.magnitude >= 6) {
    return `月相 ${moonPhasePct}%（≥85%），${target.magnitude} 等暗目标受强月光影响`;
  }
  if (moonPhasePct >= 60 && target.magnitude >= 8) {
    return `月相 ${moonPhasePct}%（≥60%），${target.magnitude} 等暗目标受月光影响`;
  }
  return undefined;
}

/** 时段核验失败采样点 */
export interface WindowFailure {
  /** 失败时刻（夜间时间轴刻度） */
  axis: number;
  /** 失败时刻 HH:mm */
  timeText: string;
  kind: 'moon' | 'altitude';
  /** 失败原因 */
  reason: string;
}

/** 排程时段核验结果 */
export interface SessionWindowResult {
  ok: boolean;
  failures: WindowFailure[];
  /** 首个失败采样（保存拦截与提示用） */
  firstFailure?: WindowFailure;
}

/**
 * 按 stepMinutes 逐段核验排程时段：时段落在月出到月落之间且月相达阈值时暗目标受月光影响；
 * 任一次采样低于最小高度也算不合格。
 */
export function validateSessionWindow(target: ObsTarget, night: ObsNight, startTime: string, endTime: string, stepMinutes = 10): SessionWindowResult {
  const base = new Date(`${night.date}T18:00:00`);
  const from = axisMinutes(startTime);
  let to = axisMinutes(endTime);
  if (to <= from) to += 1440;
  const moonReason = moonInterferenceReason(target, night.moonPhasePct);
  const failures: WindowFailure[] = [];
  for (let axis = from; axis <= to; axis += stepMinutes) {
    const date = new Date(base.getTime() + axis * 60_000);
    const altitude = altitudeAt(target, date, night.siteLat, night.siteLng);
    if (altitude < target.minAltitude) {
      failures.push({ axis, timeText: minutesToTime(axis), kind: 'altitude', reason: `高度角 ${altitude}° 低于最小高度 ${target.minAltitude}°` });
      continue;
    }
    if (moonReason && isMoonUpAt(night, axis)) {
      failures.push({ axis, timeText: minutesToTime(axis), kind: 'moon', reason: moonReason });
    }
  }
  return { ok: failures.length === 0, failures, firstFailure: failures[0] };
}

/** 把失败采样合并为连续区间（刻度，左闭右开，供时间轴标出不合格区间） */
export function failureIntervals(failures: WindowFailure[], stepMinutes = 10): Array<{ startAxis: number; endAxis: number; kinds: Array<WindowFailure['kind']> }> {
  const intervals: Array<{ startAxis: number; endAxis: number; kinds: Array<WindowFailure['kind']> }> = [];
  failures.forEach((failure) => {
    const last = intervals[intervals.length - 1];
    if (last && failure.axis <= last.endAxis) {
      last.endAxis = failure.axis + stepMinutes;
      if (!last.kinds.includes(failure.kind)) last.kinds.push(failure.kind);
    } else {
      intervals.push({ startAxis: failure.axis, endAxis: failure.axis + stepMinutes, kinds: [failure.kind] });
    }
  });
  return intervals;
}

/** 可用区间（起止 HH:mm） */
export interface UsableWindow {
  startText: string;
  endText: string;
}

/** 全夜可用起止：日落到日出每 stepMinutes 采样，取同时满足最小高度与月光约束的连续段 */
export function usableWindows(target: ObsTarget, night: ObsNight, stepMinutes = 10): UsableWindow[] {
  const base = new Date(`${night.date}T18:00:00`);
  const from = sunsetAxis(night);
  const to = sunriseAxis(night);
  const moonReason = moonInterferenceReason(target, night.moonPhasePct);
  const windows: UsableWindow[] = [];
  let start: number | null = null;
  for (let axis = from; axis <= to + stepMinutes; axis += stepMinutes) {
    let pass = false;
    if (axis <= to) {
      const date = new Date(base.getTime() + axis * 60_000);
      const altitude = altitudeAt(target, date, night.siteLat, night.siteLng);
      pass = altitude >= target.minAltitude && !(moonReason && isMoonUpAt(night, axis));
    }
    if (pass && start === null) start = axis;
    if (!pass && start !== null) {
      windows.push({ startText: minutesToTime(start), endText: minutesToTime(axis) });
      start = null;
    }
  }
  return windows;
}

/** 可用区间列表 → 'HH:mm-HH:mm；…' */
export function usableWindowsText(windows: UsableWindow[]): string {
  return windows.length ? windows.map((window) => `${window.startText}-${window.endText}`).join('；') : '无可用时段';
}

/** 夜间时间轴刻度（每 2 小时） */
export function timelineTicks(stepMinutes = 120): number[] {
  const ticks: number[] = [];
  for (let axis = 0; axis <= NIGHT_TOTAL_MINUTES; axis += stepMinutes) {
    ticks.push(axis);
  }
  return ticks;
}

/** 月相文字描述 */
export function moonPhaseText(pct: number): string {
  if (pct <= 5) return '新月';
  if (pct < 45) return '娥眉月';
  if (pct <= 55) return '上下弦';
  if (pct < 95) return '凸月';
  return '满月';
}
