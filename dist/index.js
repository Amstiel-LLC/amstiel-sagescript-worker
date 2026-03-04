import { File } from "node:buffer";
globalThis.File = File;
import 'dotenv/config';
import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";
import { transcribeAudio } from './whisper.js';
import { transcodeAudio } from './ffmpeg.js';
import { query, closePool } from './lib/db.js';
import { downloadBlob } from './lib/azureStorage.js';
// ─────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function logAIUsage(evt) {
    await query(`INSERT INTO ai_usage_events
     (user_id, organization_id, job_id, event_type, model, audio_seconds, cost_usd, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
        evt.user_id,
        evt.organization_id,
        evt.job_id ?? null,
        evt.event_type,
        evt.model,
        evt.audio_seconds ?? null,
        evt.cost_usd ?? null,
        evt.metadata ? JSON.stringify(evt.metadata) : null,
    ]);
}
async function logWorkflow(evt) {
    await query(`INSERT INTO workflow_events
     (user_id, organization_id, job_id, event_type, metadata)
     VALUES ($1, $2, $3, $4, $5)`, [
        evt.user_id,
        evt.organization_id,
        evt.job_id ?? null,
        evt.event_type,
        evt.metadata ? JSON.stringify(evt.metadata) : null,
    ]);
}
async function logSystemEvent(evt) {
    await query(`INSERT INTO system_events
     (component, severity, message, metadata)
     VALUES ($1, $2, $3, $4)`, [
        evt.component,
        evt.severity,
        evt.message,
        evt.metadata ? JSON.stringify(evt.metadata) : null,
    ]);
}
// ─────────────────────────────────────────────
// Job helpers
// ─────────────────────────────────────────────
async function claimJob() {
    try {
        // Call the stored function directly
        const result = await query(`SELECT * FROM claim_next_transcription_job()`);
        if (result.rows.length === 0)
            return null;
        const job = result.rows[0];
        // IMPORTANT: Postgres returns a row of nulls when no update happened
        if (!job || !job.id)
            return null;
        return job;
    }
    catch (error) {
        console.error('Failed to claim job:', error);
        return null;
    }
}
async function downloadAudio(path) {
    // Download from Azure Blob Storage
    return downloadBlob(path);
}
async function insertTranscript(job, text, segments) {
    const result = await query(`INSERT INTO transcripts (job_id, organization_id, text, segments)
     VALUES ($1, $2, $3, $4)
     RETURNING id`, [job.id, job.organization_id, text, JSON.stringify(segments)]);
    if (result.rows.length === 0) {
        throw new Error('Failed to insert transcript');
    }
    return result.rows[0].id;
}
async function markJobCompleted(jobId, transcriptId) {
    await query(`UPDATE transcription_jobs
     SET status = 'completed',
         completed_at = $1,
         output_transcript_id = $2
     WHERE id = $3`, [new Date().toISOString(), transcriptId, jobId]);
}
// ─────────────────────────────────────────────
// Failure handling
// ─────────────────────────────────────────────
function classifyError(err) {
    if (err?.message?.includes('rate limit'))
        return true;
    if (err?.message?.includes('timeout'))
        return true;
    return false;
}
async function handleJobFailure(job, err) {
    const retryable = classifyError(err);
    const now = new Date().toISOString();
    const nextRetryCount = (job.retry_count ?? 0) + 1;
    if (retryable && nextRetryCount <= (job.max_retries ?? 3)) {
        const nextAttemptAt = new Date(Date.now() + Math.pow(2, nextRetryCount) * 60_000).toISOString();
        await query(`UPDATE transcription_jobs
       SET status = 'pending',
           retry_count = $1,
           next_attempt_at = $2,
           last_error_message = $3,
           last_error_at = $4
       WHERE id = $5`, [nextRetryCount, nextAttemptAt, err.message, now, job.id]);
    }
    else {
        await query(`UPDATE transcription_jobs
       SET status = 'failed',
           last_error_message = $1,
           last_error_at = $2
       WHERE id = $3`, [err.message, now, job.id]);
    }
}
// ─────────────────────────────────────────────
// Job processing (shared between polling and Service Bus)
// ─────────────────────────────────────────────
async function processJob(job, whisperRate, transcribeModel) {
    let heartbeat = null;
    try {
        console.log(`Processing job ${job.id}`);
        const userId = job.entra_oid ?? job.user_id;
        const organizationId = job.organization_id;
        if (userId && organizationId) {
            await logWorkflow({
                user_id: userId,
                organization_id: organizationId,
                job_id: job.id,
                event_type: "transcribing_started",
            });
        }
        else {
            await logSystemEvent({
                component: 'worker',
                severity: 'warning',
                message: 'Missing user/org for transcribing_started',
                metadata: { job_id: job.id },
            });
        }
        // 🔁 START HEARTBEAT
        heartbeat = setInterval(() => {
            query(`UPDATE transcription_jobs
         SET last_heartbeat_at = $1
         WHERE id = $2`, [new Date().toISOString(), job.id]).catch(err => console.error('Heartbeat failed:', err));
        }, 30_000);
        // Hard validation
        if (!job.audio_path) {
            throw new Error(`Job ${job.id} missing audio_path`);
        }
        // Download audio
        console.log("JOB", job.id, "starting download");
        const audio = await downloadAudio(job.audio_path);
        console.log("JOB", job.id, "downloaded audio");
        // Normalize / transcode
        console.log("JOB", job.id, "starting ffmpeg");
        const processedAudio = await transcodeAudio(audio);
        console.log("JOB", job.id, "ffmpeg complete");
        // Whisper transcription
        console.log("JOB", job.id, "starting whisper");
        const { text, segments } = await transcribeAudio(processedAudio);
        console.log("JOB", job.id, "whisper complete");
        const audioSecondsRaw = job.audio_seconds ??
            job.audio_duration_seconds ??
            job.audio_duration ??
            null;
        const audioSeconds = Number.isFinite(Number(audioSecondsRaw))
            ? Number(audioSecondsRaw)
            : undefined;
        const costUsd = audioSeconds !== undefined ? audioSeconds * whisperRate : undefined;
        if (userId && organizationId) {
            await logAIUsage({
                user_id: userId,
                organization_id: organizationId,
                job_id: job.id,
                event_type: "transcription",
                model: transcribeModel,
                audio_seconds: audioSeconds,
                cost_usd: costUsd,
            });
        }
        // Insert transcript + complete job
        console.log("JOB", job.id, "inserting transcript");
        const transcriptId = await insertTranscript(job, text, segments);
        console.log("JOB", job.id, "transcript inserted");
        if (userId && organizationId) {
            await logWorkflow({
                user_id: userId,
                organization_id: organizationId,
                job_id: job.id,
                event_type: "transcribing_completed",
            });
        }
        console.log("JOB", job.id, "marking completed");
        await markJobCompleted(job.id, transcriptId);
        console.log(`Job ${job.id} completed`);
    }
    finally {
        // 🧹 ALWAYS CLEAR HEARTBEAT
        if (heartbeat) {
            clearInterval(heartbeat);
        }
    }
}
// ─────────────────────────────────────────────
// Service Bus message handler
// ─────────────────────────────────────────────
async function fetchJobById(jobId) {
    const result = await query(`UPDATE transcription_jobs
     SET status = 'processing', last_heartbeat_at = NOW()
     WHERE id = $1 AND status = 'pending'
     RETURNING id, audio_path, organization_id, entra_oid, user_id,
               retry_count, max_retries`, [jobId]);
    return result.rows[0] ?? null;
}
async function serviceBusWorker(namespace, queueName, whisperRate, transcribeModel) {
    console.log("Worker started (Service Bus mode)");
    console.log(`Connecting to namespace: ${namespace}`);
    console.log(`Queue: ${queueName}`);
    // Managed Identity authentication (SOC2/HIPAA compliant)
    const credential = new DefaultAzureCredential();
    const sbClient = new ServiceBusClient(namespace, credential);
    const receiver = sbClient.createReceiver(queueName);
    try {
        await logSystemEvent({
            component: 'worker',
            severity: 'info',
            message: 'Worker booted (Service Bus mode, Managed Identity).',
        });
    }
    catch (err) {
        console.error('logSystemEvent failed:', err);
    }
    // Graceful shutdown
    const shutdown = async () => {
        console.log("Shutting down Service Bus receiver...");
        await receiver.close();
        await sbClient.close();
        await closePool();
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    // Message handler
    const messageHandler = async (message) => {
        const jobId = message.body?.job_id ?? message.body;
        console.log(`Received message for job: ${jobId}`);
        if (!jobId || typeof jobId !== 'string') {
            console.error('Invalid message body:', message.body);
            await receiver.completeMessage(message);
            return;
        }
        try {
            const job = await fetchJobById(jobId);
            if (!job) {
                console.log(`Job ${jobId} not found or already processing, skipping`);
                await receiver.completeMessage(message);
                return;
            }
            await processJob(job, whisperRate, transcribeModel);
            await receiver.completeMessage(message);
        }
        catch (err) {
            console.error(`Job ${jobId} failed:`, err);
            await logSystemEvent({
                component: 'worker',
                severity: 'error',
                message: err?.message || 'Worker job failed',
                metadata: { stack: err?.stack, job_id: jobId },
            }).catch(console.error);
            const failedJob = await query(`SELECT id, retry_count, max_retries FROM transcription_jobs WHERE id = $1`, [jobId]);
            const job = failedJob.rows[0];
            if (job) {
                await handleJobFailure(job, err);
            }
            if (job && (job.retry_count ?? 0) >= (job.max_retries ?? 3)) {
                await receiver.deadLetterMessage(message, {
                    deadLetterReason: "MaxRetriesExceeded",
                    deadLetterErrorDescription: err.message,
                });
            }
            else {
                await receiver.abandonMessage(message);
            }
        }
    };
    // Error handler
    const errorHandler = async (args) => {
        console.error("Service Bus error:", args.error);
        await logSystemEvent({
            component: 'worker',
            severity: 'error',
            message: 'Service Bus error',
            metadata: { error: args.error.message, stack: args.error.stack },
        }).catch(console.error);
    };
    receiver.subscribe({
        processMessage: messageHandler,
        processError: errorHandler,
    });
    console.log("Listening for Service Bus messages...");
    await new Promise(() => { });
}
// ─────────────────────────────────────────────
// Polling worker loop (fallback)
// ─────────────────────────────────────────────
async function pollingWorkerLoop(whisperRate, transcribeModel) {
    console.log("Worker started (polling mode)");
    try {
        await logSystemEvent({
            component: 'worker',
            severity: 'info',
            message: 'Worker booted (polling mode).',
        });
    }
    catch (err) {
        console.error('logSystemEvent failed:', err);
    }
    while (true) {
        let job = null;
        try {
            job = await claimJob();
            if (!job || !job.id) {
                console.log("No jobs available. Sleeping...");
                await sleep(3000);
                continue;
            }
            await processJob(job, whisperRate, transcribeModel);
        }
        catch (err) {
            if (!job) {
                console.error("Worker error before job assignment:", err);
                await sleep(2000);
                continue;
            }
            console.error(`Job ${job.id} failed`, err);
            try {
                await logSystemEvent({
                    component: 'worker',
                    severity: 'error',
                    message: err?.message || 'Worker job failed',
                    metadata: { stack: err?.stack, job_id: job.id },
                });
            }
            catch (logError) {
                console.error('logSystemEvent failed:', logError);
            }
            await handleJobFailure(job, err);
        }
    }
}
// ─────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────
async function main() {
    // ─────────────────────────────────────────────
    // Environment validation (inside main to ensure env vars are resolved)
    // ─────────────────────────────────────────────
    const postgresHost = process.env.AZURE_POSTGRES_HOST;
    const postgresDb = process.env.AZURE_POSTGRES_DB;
    if (!postgresHost || !postgresDb) {
        throw new Error('Missing database config: set AZURE_POSTGRES_HOST and AZURE_POSTGRES_DB');
    }
    if (!process.env.AZURE_STORAGE_ACCOUNT_NAME) {
        throw new Error('Missing AZURE_STORAGE_ACCOUNT_NAME environment variable');
    }
    // Config values
    const whisperRate = Number(process.env.WHISPER_RATE ?? '0');
    const transcribeModel = process.env.USE_AZURE_OPENAI === 'true'
        ? process.env.AZURE_WHISPER_DEPLOYMENT_NAME || 'whisper-1'
        : 'gpt-4o-transcribe';
    // Service Bus config
    const serviceBusNamespace = process.env.SERVICEBUS_NAMESPACE_FQDN;
    const serviceBusQueue = process.env.SERVICEBUS_QUEUE_NAME;
    const useServiceBus = Boolean(serviceBusNamespace && serviceBusQueue);
    console.log('─────────────────────────────────────────────');
    console.log('SageScript Worker Starting');
    console.log('─────────────────────────────────────────────');
    console.log(`Database: ${postgresHost}/${postgresDb}`);
    console.log(`Storage: ${process.env.AZURE_STORAGE_ACCOUNT_NAME}`);
    console.log(`Mode: ${useServiceBus ? 'Service Bus' : 'Polling'}`);
    if (useServiceBus) {
        console.log(`Service Bus: ${serviceBusNamespace}`);
        console.log(`Queue: ${serviceBusQueue}`);
    }
    console.log('─────────────────────────────────────────────');
    // Start worker
    if (useServiceBus) {
        await serviceBusWorker(serviceBusNamespace, serviceBusQueue, whisperRate, transcribeModel);
    }
    else {
        await pollingWorkerLoop(whisperRate, transcribeModel);
    }
}
// ─────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────
main().catch(err => {
    console.error('Worker crashed:', err);
    process.exit(1);
});
