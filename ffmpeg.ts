import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

export async function transcodeAudio(
  inputBuffer: Buffer
): Promise<Buffer> {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ffmpeg-')
  );

  const inputPath = path.join(tempDir, 'input');
  const outputPath = path.join(tempDir, 'output.mp3');

  fs.writeFileSync(inputPath, inputBuffer);

  await runFfmpeg(inputPath, outputPath);

  const outputBuffer = fs.readFileSync(outputPath);

  fs.rmSync(tempDir, { recursive: true, force: true });

  return outputBuffer;
}

function runFfmpeg(inputPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', inputPath,
      '-ac', '1',
      '-ar', '16000',
      '-b:a', '32k',
      outputPath,
    ];

    const ffmpeg = spawn('ffmpeg', args);

    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('error', (err) => {
      reject(err);
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`ffmpeg exited with code ${code}: ${stderr}`)
        );
      }
    });
  });
}
