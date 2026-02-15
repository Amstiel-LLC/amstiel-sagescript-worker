import fs from 'fs'
import path from 'path'
import os from 'os'
import OpenAI from 'openai'
import type { AzureOpenAI } from 'openai'

// ─────────────────────────────────────────────
// Client configuration
// ─────────────────────────────────────────────

const USE_AZURE = process.env.USE_AZURE_OPENAI === 'true'

let openai: OpenAI | AzureOpenAI

if (USE_AZURE) {
  // Azure OpenAI configuration (HIPAA-compliant, zero data retention)
  const { AzureOpenAI } = await import('openai')

  const endpoint = process.env.AZURE_OPENAI_ENDPOINT
  const apiKey = process.env.AZURE_OPENAI_API_KEY

  if (!endpoint || !apiKey) {
    throw new Error('Missing Azure OpenAI credentials: AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY required')
  }

  openai = new AzureOpenAI({
    endpoint,
    apiKey,
    apiVersion: '2024-10-01-preview', // Latest API version with Whisper support
  })
} else {
  // Standard OpenAI configuration (30-day data retention, NOT HIPAA-compliant)
  console.warn('⚠️  WARNING: Using standard OpenAI API (30-day data retention). Not suitable for PHI.')

  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  })
}

// ─────────────────────────────────────────────
// Post-processing: flag consecutive duplicates
// ─────────────────────────────────────────────

function flagConsecutiveDuplicates(text: string): string {
  const paragraphs = text.split(/\n+/)
  const result: string[] = []

  for (let i = 0; i < paragraphs.length; i++) {
    const trimmed = paragraphs[i].trim()
    if (!trimmed) continue

    const prev = result.length > 0 ? result[result.length - 1] : ''
    // Strip any existing flag to compare raw text
    const prevClean = prev.replace(/\s*\[DUPLICATE - FLAGGED FOR REVIEW\]\s*$/, '').trim()

    if (trimmed === prevClean) {
      result.push(`${trimmed} [DUPLICATE - FLAGGED FOR REVIEW]`)
    } else {
      result.push(trimmed)
    }
  }

  return result.join('\n\n')
}

// ─────────────────────────────────────────────
// Transcription function
// ─────────────────────────────────────────────

export async function transcribeAudio(
  audioBuffer: Buffer
): Promise<{ text: string; segments: any[] }> {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'whisper-')
  )

  const audioPath = path.join(tmpDir, 'audio.mp3')
  fs.writeFileSync(audioPath, audioBuffer)

  try {
    const response = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: USE_AZURE
        ? process.env.AZURE_WHISPER_DEPLOYMENT_NAME! // Your Azure deployment name
        : 'gpt-4o-transcribe', // OpenAI model name
      response_format: 'json',
      prompt:
        'Dear Sirs, Yours faithfully, witness statement, claimant, quantum, accident circumstances, opinion, recommendation, enclosures, time sheet, client interviewed, we are pleased to confirm, inspector, claim technician, solicitors, postcode, reference',
    })

    // ── Post-processing: flag consecutive duplicate paragraphs ──
    const text = flagConsecutiveDuplicates(response.text)

    return {
      text,
      segments: [],
    }
  } finally {
    // Always clean up temp files
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
