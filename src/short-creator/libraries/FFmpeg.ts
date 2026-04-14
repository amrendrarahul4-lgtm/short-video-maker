import ffmpeg from "fluent-ffmpeg";
import { Readable } from "node:stream";
import fs from "fs-extra";
import { logger } from "../../logger";
import { withRetry } from "./retry";

export class FFMpeg {
  static async init(): Promise<FFMpeg> {
    return import("@ffmpeg-installer/ffmpeg").then((ffmpegInstaller) => {
      ffmpeg.setFfmpegPath(ffmpegInstaller.path);
      logger.info(
        { ffmpegPath: ffmpegInstaller.path },
        "FFmpeg initialised",
      );

      // Verify the binary is actually executable
      try {
        fs.accessSync(ffmpegInstaller.path, fs.constants.X_OK);
        logger.info(
          { ffmpegPath: ffmpegInstaller.path },
          "FFmpeg binary is executable",
        );
      } catch (err: unknown) {
        logger.error(
          {
            ffmpegPath: ffmpegInstaller.path,
            err: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          "FFmpeg binary exists but is not executable — renders will fail",
        );
      }

      return new FFMpeg();
    });
  }

  async saveNormalizedAudio(
    audio: ArrayBuffer,
    outputPath: string,
  ): Promise<string> {
    logger.debug({ outputPath }, "Normalizing audio for Whisper");
    return withRetry(
      () => {
        // Recreate the stream on every attempt — a consumed Readable cannot be reused
        const inputStream = new Readable();
        inputStream.push(Buffer.from(audio));
        inputStream.push(null);

        // Remove any partial output from a previous failed attempt
        try {
          if (fs.existsSync(outputPath)) fs.removeSync(outputPath);
        } catch (_) {}

        return new Promise<string>((resolve, reject) => {
          ffmpeg()
            .input(inputStream)
            .audioCodec("pcm_s16le")
            .audioChannels(1)
            .audioFrequency(16000)
            .toFormat("wav")
            .on("end", () => {
              logger.debug({ outputPath }, "Audio normalization complete");
              resolve(outputPath);
            })
            .on("error", (error: unknown) => {
              logger.error(
                {
                  outputPath,
                  err: error instanceof Error ? error.message : String(error),
                  stack: error instanceof Error ? error.stack : undefined,
                },
                "FFmpeg error normalizing audio",
              );
              reject(error);
            })
            .save(outputPath);
        });
      },
      {
        label: "FFmpeg saveNormalizedAudio",
        maxAttempts: 3,
        baseDelayMs: 500,
        context: { outputPath },
      },
    );
  }

  async createMp3DataUri(audio: ArrayBuffer): Promise<string> {
    const inputStream = new Readable();
    inputStream.push(Buffer.from(audio));
    inputStream.push(null);
    return new Promise((resolve, reject) => {
      const chunk: Buffer[] = [];

      ffmpeg()
        .input(inputStream)
        .audioCodec("libmp3lame")
        .audioBitrate(128)
        .audioChannels(2)
        .toFormat("mp3")
        .on("error", (err) => {
          logger.error(
            {
              err: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? err.stack : undefined,
            },
            "FFmpeg error creating MP3 data URI",
          );
          reject(err);
        })
        .pipe()
        .on("data", (data: Buffer) => {
          chunk.push(data);
        })
        .on("end", () => {
          const buffer = Buffer.concat(chunk);
          resolve(`data:audio/mp3;base64,${buffer.toString("base64")}`);
        })
        .on("error", (err) => {
          logger.error(
            {
              err: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? err.stack : undefined,
            },
            "FFmpeg pipe error creating MP3 data URI",
          );
          reject(err);
        });
    });
  }

  async saveToMp3(audio: ArrayBuffer, filePath: string): Promise<string> {
    logger.debug({ filePath }, "Converting audio to MP3");

    /**
     * Retry with a fallback codec on the second attempt:
     *   attempt 1 — libmp3lame 128 kbps stereo (standard)
     *   attempt 2 — libmp3lame 96 kbps mono (reduced quality)
     *   attempt 3 — aac 96 kbps mono (different codec entirely)
     */
    const codecConfigs = [
      { audioCodec: "libmp3lame", audioBitrate: 128, audioChannels: 2, format: "mp3" },
      { audioCodec: "libmp3lame", audioBitrate: 96, audioChannels: 1, format: "mp3" },
      { audioCodec: "aac", audioBitrate: 96, audioChannels: 1, format: "mp4" },
    ];

    return withRetry(
      (attempt) => {
        const cfg = codecConfigs[Math.min(attempt - 1, codecConfigs.length - 1)];

        // Recreate the stream on every attempt
        const inputStream = new Readable();
        inputStream.push(Buffer.from(audio));
        inputStream.push(null);

        // Remove any partial output from a previous failed attempt
        try {
          if (fs.existsSync(filePath)) fs.removeSync(filePath);
        } catch (_) {}

        if (attempt > 1) {
          logger.warn(
            { filePath, attempt, codec: cfg.audioCodec, bitrate: cfg.audioBitrate },
            "FFmpeg saveToMp3 retrying with fallback codec settings",
          );
        }

        return new Promise<string>((resolve, reject) => {
          ffmpeg()
            .input(inputStream)
            .audioCodec(cfg.audioCodec)
            .audioBitrate(cfg.audioBitrate)
            .audioChannels(cfg.audioChannels)
            .toFormat(cfg.format)
            .on("end", () => {
              logger.debug({ filePath }, "Audio saved to MP3 successfully");

              // Verify the file was actually written with non-zero size
              try {
                if (!fs.existsSync(filePath)) {
                  return reject(
                    new Error(`FFmpeg reported success but MP3 file is missing: ${filePath}`),
                  );
                }
                const stat = fs.statSync(filePath);
                if (stat.size === 0) {
                  return reject(
                    new Error(`FFmpeg reported success but MP3 file is empty (0 bytes): ${filePath}`),
                  );
                }
                logger.debug({ filePath, fileSizeBytes: stat.size }, "MP3 file verified");
              } catch (statErr: unknown) {
                logger.error(
                  {
                    filePath,
                    err: statErr instanceof Error ? statErr.message : String(statErr),
                    stack: statErr instanceof Error ? statErr.stack : undefined,
                  },
                  "Error verifying MP3 output file",
                );
                return reject(statErr);
              }

              resolve(filePath);
            })
            .on("error", (err) => {
              logger.error(
                {
                  filePath,
                  err: err instanceof Error ? err.message : String(err),
                  stack: err instanceof Error ? err.stack : undefined,
                },
                "FFmpeg error saving audio to MP3",
              );
              reject(err);
            })
            .save(filePath);
        });
      },
      {
        label: "FFmpeg saveToMp3",
        maxAttempts: 3,
        baseDelayMs: 500,
        context: { filePath },
      },
    );
  }
}
