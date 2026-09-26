/**
 * functions/lib/cloudTasksClient.js
 *
 * Thin wrapper around @google-cloud/tasks for the dose-alert queue.
 * Keep all Cloud Tasks specifics (queue path, client construction) here
 * so sendDoseAlert.js and updateNextDoseAt only deal with plain
 * "schedule this chart" / "cancel this chart's task" calls.
 *
 * Requires @google-cloud/tasks — added to functions/package.json.
 *
 * DEPLOY PREREQUISITES (do these before deploying updateNextDoseAt with
 * the new task-scheduling logic, or Cloud Tasks calls will fail — see
 * the try/catch around scheduleDoseAlertTask in updateNextDoseAt, which
 * makes that failure non-fatal to nextDoseAt, but Cloud Tasks still
 * won't actually work until these are done):
 *   1. Create the queue: gcloud tasks queues create dose-due-alerts
 *        --location=us-central1
 *   2. Deploy sendDoseAlert once to get its HTTPS URL, then set
 *      SEND_DOSE_ALERT_URL to that URL (functions config or env var).
 *   3. (Recommended) create a service account with
 *      roles/cloudfunctions.invoker and set TASKS_INVOKER_SA, so
 *      sendDoseAlert isn't a public unauthenticated endpoint.
 */

const { CloudTasksClient } = require('@google-cloud/tasks');

const client = new CloudTasksClient();

// Confirmed against the actual repo: every existing function
// (checkDueDrugs, updateNextDoseAt, onNewMessage, etc.) is deployed with
// region: 'us-central1', so the queue matches that rather than adding a
// third region. This does NOT resolve the existing us-central1 (functions)
// vs europe-west1 (Firestore/Pub-Sub triggers) mismatch — that's a
// separate, deliberately deferred decision (not part of this migration).
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'gen-lang-client-0406053716';
const REGION = 'us-central1';
const QUEUE_NAME = 'dose-due-alerts';

// Set this once sendDoseAlert is deployed and its URL is known — see
// DEPLOY PREREQUISITES above. Left unset, scheduleDoseAlertTask throws,
// which the updateNextDoseAt caller catches and logs (nextDoseAt itself
// still gets set either way).
const SEND_DOSE_ALERT_URL = process.env.SEND_DOSE_ALERT_URL || '';

// If set, sendDoseAlert requires an OIDC token from this service account
// (recommended — it's an internal endpoint). Left unset, tasks are
// created without auth, which works but leaves the endpoint open to
// anyone who learns the URL.
const INVOKER_SERVICE_ACCOUNT_EMAIL = process.env.TASKS_INVOKER_SA || '';

function queuePath() {
  return client.queuePath(PROJECT_ID, REGION, QUEUE_NAME);
}

/**
 * Schedule (or replace) the single dose-alert task for a chart.
 *
 * Caller (updateNextDoseAt) is responsible for:
 *   - calling cancelScheduledTask() first if scheduledTaskName already
 *     exists on the doc (this function does NOT check-and-cancel itself,
 *     to keep it a pure "create" primitive and the cancel-then-create
 *     sequencing explicit and visible at the call site)
 *   - persisting the returned task name back onto the chart doc
 *
 * @param {Object} args
 * @param {string} args.patientId
 * @param {string} args.chartId
 * @param {Date}   args.dueAt - absolute time the task should fire
 * @returns {Promise<string>} the created task's full resource name
 */
async function scheduleDoseAlertTask({ patientId, chartId, dueAt }) {
  if (!SEND_DOSE_ALERT_URL) {
    throw new Error('SEND_DOSE_ALERT_URL is not configured');
  }

  const payload = { patientId, chartId };

  const task = {
    httpRequest: {
      httpMethod: 'POST',
      url: SEND_DOSE_ALERT_URL,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(payload)).toString('base64'),
      ...(INVOKER_SERVICE_ACCOUNT_EMAIL && {
        oidcToken: { serviceAccountEmail: INVOKER_SERVICE_ACCOUNT_EMAIL },
      }),
    },
    scheduleTime: {
      // Cloud Tasks wants seconds since epoch. dueAt must already be a
      // real Date/Timestamp in correct UTC millis — do not re-interpret
      // it as Africa/Lagos local time here.
      seconds: Math.floor(dueAt.getTime() / 1000),
    },
    // Queue-level retry/backoff/max-attempts (separate from Cloud
    // Functions' own retry:true) is configured on the queue itself via
    // `gcloud tasks queues create/update`, not per-task. Not yet decided:
    // what dead-letter/alerting looks like on permanent failure.
  };

  const request = { parent: queuePath(), task };
  const [response] = await client.createTask(request);
  return response.name; // store this as scheduledTaskName on the chart doc
}

/**
 * Cancel a previously scheduled task, if it still exists.
 * Safe to call with a stale/already-fired task name — NOT_FOUND is
 * swallowed since that's the expected case after a task has run.
 *
 * @param {string} taskName - full resource name from scheduleDoseAlertTask
 */
async function cancelScheduledTask(taskName) {
  if (!taskName) return;
  try {
    await client.deleteTask({ name: taskName });
  } catch (err) {
    if (err.code === 5 /* NOT_FOUND */) return; // already fired or gone
    throw err;
  }
}

module.exports = { scheduleDoseAlertTask, cancelScheduledTask, queuePath };
