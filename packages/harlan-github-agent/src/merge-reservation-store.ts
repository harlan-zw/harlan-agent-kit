import type { DatabaseSync } from 'node:sqlite'
import type { ReservationObservation } from './merge-reservation-observation.ts'

export const reservationObservationSchema = `
  CREATE TABLE IF NOT EXISTS reservation_observations (
    id INTEGER PRIMARY KEY,
    observed_at TEXT NOT NULL,
    evidence TEXT NOT NULL CHECK (json_valid(evidence))
  );
`

const observationRetentionMs = 7 * 24 * 60 * 60_000

export function createReservationObservationStore(database: DatabaseSync) {
  const latest = database.prepare('SELECT id, evidence FROM reservation_observations ORDER BY id DESC LIMIT 1')
  const insert = database.prepare('INSERT INTO reservation_observations (observed_at, evidence) VALUES (?, ?)')
  const update = database.prepare('UPDATE reservation_observations SET observed_at = ? WHERE id = ?')
  const prune = database.prepare('DELETE FROM reservation_observations WHERE observed_at < ?')
  const recent = database.prepare('SELECT observed_at, evidence FROM reservation_observations ORDER BY id DESC LIMIT ?')
  return {
    recordReservationObservation(observation: ReservationObservation) {
      const { observedAt, ...evidence } = observation
      const encoded = JSON.stringify(evidence)
      const previous = latest.get() as { id: number, evidence: string } | undefined
      if (previous?.evidence === encoded)
        update.run(observedAt, previous.id)
      else
        insert.run(observedAt, encoded)
      prune.run(new Date(Date.parse(observedAt) - observationRetentionMs).toISOString())
    },
    listReservationObservations(limit = 12): ReservationObservation[] {
      return (recent.all(limit) as { observed_at: string, evidence: string }[]).map(row => ({
        ...JSON.parse(row.evidence) as Omit<ReservationObservation, 'observedAt'>,
        observedAt: row.observed_at,
      }))
    },
  }
}
