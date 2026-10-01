export function humanFileSize(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
  return (size / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}
