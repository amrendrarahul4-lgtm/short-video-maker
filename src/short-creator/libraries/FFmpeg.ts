import ffmpeg from "fluent-ffmpeg";
import { Readable } from "node:stream";
import fs from "fs-extra";
import { logger } from "../../logger";

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
    const inputStream = new Readable();
    inputStream.push(Buffer.from(audio));
    inputStream.push(null);

    return new Promise((resolve, reject) => {
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
    const inputStream = new Readable();
    inputStream.push(Buffer.from(audio));
    inputStream.push(null);
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(inputStream)
        .audioCodec("libmp3lame")
        .audioBitrate(128)
        .audioChannels(2)
        .toFormat("mp3")
        .on("end", () => {
          logger.debug({ filePath }, "Audio saved to MP3 successfully");

          // Verify the file was actually written with non-zero size
          try {
            if (!fs.existsSync(filePath)) {
              const err = new Error(
                `FFmpeg reported success but MP3 file is missing: ${filePath}`,
              );
              logger.error({ filePath }, err.message);
              return reject(err);
            }
            const stat = fs.statSync(filePath);
            if (stat.size === 0) {
              const err = new Error(
                `FFmpeg reported success but MP3 file is empty (0 bytes): ${filePath}`,
              );
              logger.error({ filePath, fileSizeBytes: stat.size }, err.message);
              return reject(err);
            }
            logger.debug(
              { filePath, fileSizeBytes: stat.size },
              "MP3 file verified",
            );
          } catch (statErr: unknown) {
            logger.error(
              {
                filePath,
                err:
                  statErr instanceof Error
                    ? statErr.message
                    : String(statErr),
                stack:
                  statErr instanceof Error ? statErr.stack : undefined,
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
  }
}
