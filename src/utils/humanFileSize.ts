export function humanFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  // Clamp the unit index on BOTH ends: size in (0, 1) floors to -1 (units[-1]
  // is undefined -> "512.00 undefined"), while the upper clamp bounds the top.
  const i = Math.max(0, Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024))));
  return (size / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}
