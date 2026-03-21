let _counter = 0;

export function incrementProfileRebuildCounter(): number {
  return ++_counter;
}

export function resetProfileRebuildCounter(): void {
  _counter = 0;
}
