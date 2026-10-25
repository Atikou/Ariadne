export const SCHEDULE_SUBMISSION_MAX_ATTEMPTS = 8;

/** Attempts are charged before I/O; the first failed attempt waits one second. */
export function scheduleSubmissionRetryDelay(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error('schedule_occurrence_attempts_invalid');
  return Math.min(60_000, 1_000 * 2 ** Math.min(6, attempts - 1));
}
