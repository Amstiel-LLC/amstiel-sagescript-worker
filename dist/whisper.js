import fs from 'fs';
import path from 'path';
import os from 'os';
import OpenAI from 'openai';
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});
export async function transcribeAudio(audioBuffer) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));
    const audioPath = path.join(tmpDir, 'audio.mp3');
    fs.writeFileSync(audioPath, audioBuffer);
    const response = await openai.audio.transcriptions.create({
        file: fs.createReadStream(audioPath),
        model: 'gpt-4o-transcribe',
        response_format: 'json',
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return {
        text: response.text,
        segments: [],
    };
}
