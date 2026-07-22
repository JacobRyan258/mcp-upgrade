import type { BigIntStats } from 'node:fs';
import type { FilesystemIdentity } from './types.js';

/** Captures fields that identify one filesystem object across pathname races. */
export function filesystemIdentity(stat: BigIntStats): FilesystemIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    ctimeNs: stat.ctimeNs,
    birthtimeNs: stat.birthtimeNs,
  };
}

export function sameFilesystemIdentity(
  left: FilesystemIdentity,
  right: FilesystemIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}
