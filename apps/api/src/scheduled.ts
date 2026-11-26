// Entry points for the job runner. Each is a plain async function of the
// database and the current time (or key ring), safe to run repeatedly and
// concurrently; schedule them as below.
//
// | Step                       | When                                   |
// | -------------------------- | -------------------------------------- |
// | `processDueDeletions`      | daily                                  |
// | `purgeExpiredTelemetry`    | daily                                  |
// | `rotateTaxEncryptionKeys`  | after a new key is put first; or daily |

export { type DeletionRun, processDueDeletions } from "./accounts/deletion.ts";
export { purgeExpiredTelemetry, type TelemetryPurge } from "./compliance/retention.ts";
export { rotateTaxEncryptionKeys } from "./data/tax-details.ts";
