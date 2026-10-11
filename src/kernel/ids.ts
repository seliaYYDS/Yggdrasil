let counter = 0;

export function makeId(prefix: string): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}${rand}`;
}

export const newNodeId = () => makeId('n');
export const newId = () => makeId('id');
