import { DateTime } from 'luxon';
import type { User } from './types.js';

function at(day: string, hhmm: string, tz: string): DateTime {
  const [hour, minute] = hhmm.split(':').map(Number);
  return DateTime.fromISO(day, { zone: tz }).set({ hour, minute, second: 0, millisecond: 0 });
}

export const morningAt = (u: User, day: string) => at(day, u.morningTime, u.tz);
export const eveningAt = (u: User, day: string) => at(day, u.eveningTime, u.tz);

export function localDay(u: User, now: DateTime): string {
  return now.setZone(u.tz).toISODate()!;
}

// The day the current questions belong to: today once the morning time has passed,
// otherwise yesterday. Unfinished answers from an older cycle are discarded.
export function cycleDay(u: User, now: DateTime): string {
  const today = localDay(u, now);
  if (now >= morningAt(u, today)) return today;
  return DateTime.fromISO(today).minus({ days: 1 }).toISODate()!;
}

export function isActiveDay(u: User, day: string): boolean {
  return u.days.includes(DateTime.fromISO(day).weekday);
}

export function addDays(day: string, n: number): string {
  return DateTime.fromISO(day).plus({ days: n }).toISODate()!;
}

export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h < 12 ? 'am' : 'pm';
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')}${suffix}`;
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const dayName = (iso: number) => DAY_NAMES[iso - 1];

export function formatDays(days: number[]): string {
  const sorted = [...days].sort();
  if (sorted.length === 7) return 'every day';
  if (sorted.join() === '1,2,3,4,5') return 'weekdays';
  if (sorted.join() === '6,7') return 'weekends';
  return sorted.map(dayName).join(', ');
}
