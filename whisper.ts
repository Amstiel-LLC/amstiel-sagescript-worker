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
    })

    return {
      text: response.text,
      segments: [],
    }
  } finally {
    // Always clean up temp files
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
