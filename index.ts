import { File } from "node:buffer";

(globalThis as any).File = File;

import 'dotenv/config'
import { transcribeAudio } from './whisper.js'

import { createClient } from '@supabase/supabase-js'
import { transcodeAudio } from './ffmpeg.js'

// ─────────────────────────────────────────────
// Supabase setup
// ─────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing Supabase environment variables')
}

// Re-bind with non-null assertion for TS
const supabaseUrl = SUPABASE_URL
const serviceRoleKey = SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: { persistSession: false },
  }
);

// ─────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─────────────────────────────────────────────
// Job helpers
// ─────────────────────────────────────────────

async function claimJob() {
  const { data, error } = await supabase.rpc(
    'claim_next_transcription_job'
  )

  if (error) {
    console.error('Failed to claim job:', error)
    return null
  }

  if (!data) return null

  const job = Array.isArray(data) ? data[0] : data

  // IMPORTANT: Postgres returns a row of nulls when no update happened
  if (!job || !job.id) return null

  return job
}



async function downloadAudio(path: string): Promise<Buffer> {
  const { data, error } = await supabase.storage
    .from('audio-uploads')
    .download(path)

  if (error) throw error

  return Buffer.from(await data.arrayBuffer())
}

async function insertTranscript(job: any, text: string, segments: any[]) {
  const { data, error } = await supabase
    .from('transcripts')
    .upsert({
      job_id: job.id,
      organization_id: job.organization_id,
      text,
      segments,
    })
    .select('id')
    .single()

  if (error) throw error

  return data.id
}

async function markJobCompleted(jobId: string, transcriptId: string) {
  const { error } = await supabase
    .from('transcription_jobs')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      output_transcript_id: transcriptId,
    })
    .eq('id', jobId)

  if (error) throw error
}

// ─────────────────────────────────────────────
// Failure handling
// ─────────────────────────────────────────────

function classifyError(err: any): boolean {
  if (err?.message?.includes('rate limit')) return true
  if (err?.message?.includes('timeout')) return true
  return false
}

async function handleJobFailure(job: any, err: any) {
  const retryable = classifyError(err)
  const now = new Date().toISOString()
  const nextRetryCount = job.retry_count + 1

  if (retryable && nextRetryCount <= job.max_retries) {
    await supabase
      .from('transcription_jobs')
      .update({
        status: 'pending',
        retry_count: nextRetryCount,
        next_attempt_at: new Date(
          Date.now() + Math.pow(2, nextRetryCount) * 60_000
        ).toISOString(),
        last_error_message: err.message,
        last_error_at: now,
      })
      .eq('id', job.id)
  } else {
    await supabase
      .from('transcription_jobs')
      .update({
        status: 'failed',
        last_error_message: err.message,
        last_error_at: now,
      })
      .eq('id', job.id)
  }
}

// ─────────────────────────────────────────────
// Worker loop
// ─────────────────────────────────────────────

async function workerLoop() {
  console.log("Worker started");

  while (true) {
    let job: any = null;
    let heartbeat: NodeJS.Timeout | null = null;

    try {
      job = await claimJob();

      if (!job || !job.id) {
        console.log("No jobs available. Sleeping...");
        await sleep(3000);
        continue;
      }

      console.log(`Processing job ${job.id}`);

      // 🔁 START HEARTBEAT
      heartbeat = setInterval(() => {
        supabase
          .from("transcription_jobs")
          .update({ last_heartbeat_at: new Date().toISOString() })
          .eq("id", job.id);
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
      // Insert transcript + complete job

      console.log("JOB", job.id, "inserting transcript");
      const transcriptId = await insertTranscript(job, text, segments);
      console.log("JOB", job.id, "transcript inserted");

      console.log(`Job ${job.id} completed`);
      console.log("JOB", job.id, "marking completed");
      await markJobCompleted(job.id, transcriptId);
      console.log("JOB", job.id, "completed");
    } catch (err: any) {
      if (!job) {
        console.error("Worker error before job assignment:", err);
        await sleep(2000);
        continue;
      }

      console.error(`Job ${job.id} failed`, err);
      await handleJobFailure(job, err);
    } finally {
      // 🧹 ALWAYS CLEAR HEARTBEAT
      if (heartbeat) {
        clearInterval(heartbeat);
      }
    }
  }
}

// ─────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────

workerLoop().catch(err => {
  console.error('Worker crashed:', err)
  process.exit(1)
})
