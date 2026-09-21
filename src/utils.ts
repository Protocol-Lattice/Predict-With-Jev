import type { Horizon } from '../shared/types';

export const money = (value: number, compact = false) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', notation: compact ? 'compact' : 'standard',
  maximumFractionDigits: compact ? 2 : value < 0.01 ? 10 : value < 1 ? 5 : 2,
}).format(value);
export const percent = (value: number, digits = 2) => `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
export const horizonLabel = (horizon: Horizon) => horizon === 168 ? '7 days' : `${horizon} hours`;
export const timeLabel = (time: number) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(time);
export const shortTime = (time: number) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(time);
export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'The request failed. Please retry.');
  return data as T;
}
export function exportJson(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
