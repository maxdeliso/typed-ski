import { readFileSync } from 'fs';
import { resolve } from 'path';

export function loadInput(filename: string, dirname: string): string {
  const filePath = resolve(dirname, 'inputs', filename);
  return readFileSync(filePath, 'utf-8').trim();
}
