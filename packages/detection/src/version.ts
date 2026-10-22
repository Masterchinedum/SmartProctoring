/**
 * Version of the in-browser detectors. The candidate app sends it with every event batch and the server stores it on
 * the events they raise, so the Quality page can tell when a new version was first seen (drift analysis) and a
 * change in flag rates can be traced to a detector update rather than to candidates.
 *
 * Bump it whenever a detector's logic or parameters change. version.test.ts fingerprints the exported parameter
 * objects and fails when they change without a bump; logic changes are on the author (and the reviewer).
 */
export const DETECTION_ENGINE_VERSION = 'detectors-2026.10.1';
