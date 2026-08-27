import { config } from './config.js';

let entriesPaused = config.pauseNewEntries;

export function areEntriesPaused() { return entriesPaused; }
export function setEntriesPaused(paused) {
  entriesPaused = Boolean(paused);
  return entriesPaused;
}
