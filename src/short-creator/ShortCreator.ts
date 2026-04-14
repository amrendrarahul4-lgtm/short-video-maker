import { OrientationEnum } from "./../types/shorts";
/* eslint-disable @remotion/deterministic-randomness */
import fs from "fs-extra";
import cuid from "cuid";
import path from "path";
import https from "https";
import http from "http";

import { Kokoro } from "./libraries/Kokoro";
import { Remotion } from "./libraries/Remotion";
import { Whisper } from "./libraries/Whisper";
import { FFMpeg } from "./libraries/FFmpeg";
import { PexelsAPI } from "./libraries/Pexels";
import { Config } from "../config";
import { logger } from "../logger";
import { MusicManager } from "./music";
import { sleep } from "./libraries/retry";
import type {
  SceneInput,
  RenderConfig,
  Scene,
  VideoStatus,
  MusicMoodEnum,
  MusicTag,
  MusicForVideo,
} from "../types/shorts";

/** Maximum time (ms) to wait for a single video render before aborting. */
const RENDER_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** Maximum number of times a queue item will be retried before being abandoned. */
const MAX_QUEUE_RETRIES = 5;

/** Base delay (ms) for queue-level exponential backoff between job retries. */
const QUEUE_RETRY_BASE_DELAY_MS = 5_000;

/** Maximum delay (ms) between queue-level retries. */
const QUEUE_RETRY_MAX_DELAY_MS = 5 * 60 * 1000; // 5 minutes

/** Maximum number of attempts to download a single Pexels video. */
const PEXELS_DOWNLOAD_MAX_ATTEMPTS = 3;


export class ShortCreator {
  private queue: {
    sceneInput: SceneInput[];
    config: RenderConfig;
    id: string;
    /** Number of times this job has already failed and been re-queued. */
    retryCount: number;
    /** Timestamp (ms) before which this job should not be processed again. */
    nextRetryAt: number;
  }[] = [];

  constructor(
    private config: Config,
    private remotion: Remotion,
    private kokoro: Kokoro,
    private whisper: Whisper,
    private ffmpeg: FFMpeg,
    private pexelsApi: PexelsAPI,
    private musicManager: MusicManager,
  ) {}

  public status(id: string): VideoStatus {
    const videoPath = this.getVideoPath(id);
    if (this.queue.find((item) => item.id === id)) {
      return "processing";
    }
    if (fs.existsSync(videoPath)) {
      return "ready";
    }
    return "failed";
  }

  public addToQueue(sceneInput: SceneInput[], config: RenderConfig): string {
    // todo add mutex lock
    const id = cuid();
    this.queue.push({
      sceneInput,
      config,
      id,
      retryCount: 0,
      nextRetryAt: 0,
    });
    logger.info(
      {
        videoId: id,
        queueLength: this.queue.length,
        sceneCount: sceneInput.length,
        config,
      },
      "Video added to render queue",
    );
    if (this.queue.length === 1) {
      this.processQueue();
    }
    return id;
  }

  private async processQueue(): Promise<void> {
    // todo add a semaphore
    if (this.queue.length === 0) {
      return;
    }

    const item = this.queue[0];
    const { sceneInput, config, id, retryCount, nextRetryAt } = item;

    // If this item has a backoff delay, wait until it has elapsed
    const now = Date.now();
    if (nextRetryAt > now) {
      const waitMs = nextRetryAt - now;
      logger.info(
        { videoId: id, retryCount, waitMs },
        "Queue item is in backoff — waiting before next attempt",
      );
      await sleep(waitMs);
    }

    logger.info(
      { videoId: id, sceneInput, config, queueLength: this.queue.length, retryCount },
      "Processing video item in the queue",
    );

    try {
      await this.createShort(id, sceneInput, config);
      logger.info({ videoId: id }, "Video created successfully");
      // Success — remove from front of queue
      this.queue.shift();
    } catch (error: unknown) {
      const newRetryCount = retryCount + 1;

      if (newRetryCount > MAX_QUEUE_RETRIES) {
        logger.error(
          {
            videoId: id,
            retryCount: newRetryCount,
            maxRetries: MAX_QUEUE_RETRIES,
            err: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          "Video creation failed — max retries reached, removing from queue",
        );
        this.queue.shift();
      } else {
        const delayMs = Math.min(
          QUEUE_RETRY_BASE_DELAY_MS * Math.pow(2, retryCount),
          QUEUE_RETRY_MAX_DELAY_MS,
        );
        logger.warn(
          {
            videoId: id,
            retryCount: newRetryCount,
            maxRetries: MAX_QUEUE_RETRIES,
            nextRetryDelayMs: delayMs,
            err: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          },
          "Video creation failed — moving to back of queue for retry",
        );
        // Remove from front and push to back with updated retry metadata
        this.queue.shift();
        this.queue.push({
          ...item,
          retryCount: newRetryCount,
          nextRetryAt: Date.now() + delayMs,
        });
      }
    }

    // Continue processing the queue
    this.processQueue();
  }


  private async createShort(
    videoId: string,
    inputScenes: SceneInput[],
    config: RenderConfig,
  ): Promise<string> {
    logger.info(
      {
        videoId,
        sceneCount: inputScenes.length,
        config,
        searchTerms: inputScenes.map((s) => s.searchTerms),
      },
      "Starting short video creation",
    );

    // ── Pre-flight: verify output directories are writable ──────────────────
    for (const [label, dirPath] of [
      ["videosDirPath", this.config.videosDirPath],
      ["tempDirPath", this.config.tempDirPath],
    ] as [string, string][]) {
      try {
        fs.ensureDirSync(dirPath);
        fs.accessSync(dirPath, fs.constants.W_OK);
        logger.debug({ videoId, [label]: dirPath }, `${label} is writable`);
      } catch (err: unknown) {
        logger.error(
          {
            videoId,
            [label]: dirPath,
            err: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          `Pre-flight check failed: ${label} is not writable`,
        );
        throw new Error(
          `Directory not writable (${label}): ${dirPath} — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const scenes: Scene[] = [];
    let totalDuration = 0;
    const excludeVideoIds: string[] = [];
    const tempFiles: string[] = [];

    const orientation: OrientationEnum =
      config.orientation || OrientationEnum.portrait;

    let index = 0;
    for (const scene of inputScenes) {
      const sceneCtx = {
        videoId,
        sceneIndex: index,
        searchTerms: scene.searchTerms,
        textLength: scene.text.length,
      };
      logger.info(sceneCtx, "Processing scene");

      // ── Step 1: TTS (Kokoro) — with silence fallback ─────────────────────
      let audio: { audio: ArrayBuffer; audioLength: number };
      try {
        logger.debug({ ...sceneCtx, voice: config.voice }, "Generating TTS audio with Kokoro");
        // Kokoro.generate() already retries internally (up to 3 attempts)
        audio = await this.kokoro.generate(
          scene.text,
          config.voice ?? "af_heart",
        );
        logger.debug(
          { ...sceneCtx, audioLength: audio.audioLength },
          "Kokoro TTS audio generated",
        );
      } catch (err: unknown) {
        // All Kokoro retries exhausted — fall back to a 3-second silence WAV
        logger.warn(
          {
            ...sceneCtx,
            err: err instanceof Error ? err.message : String(err),
          },
          "Kokoro TTS failed after all retries — using silence fallback",
        );
        audio = ShortCreator.createSilenceAudio(3);
      }

      let { audioLength } = audio;
      const { audio: audioStream } = audio;

      // add the paddingBack in seconds to the last scene
      if (index + 1 === inputScenes.length && config.paddingBack) {
        audioLength += config.paddingBack / 1000;
      }

      const tempId = cuid();
      const tempWavFileName = `${tempId}.wav`;
      const tempMp3FileName = `${tempId}.mp3`;
      const tempVideoFileName = `${tempId}.mp4`;
      const tempWavPath = path.join(this.config.tempDirPath, tempWavFileName);
      const tempMp3Path = path.join(this.config.tempDirPath, tempMp3FileName);
      const tempVideoPath = path.join(
        this.config.tempDirPath,
        tempVideoFileName,
      );
      tempFiles.push(tempVideoPath);
      tempFiles.push(tempWavPath, tempMp3Path);

      // ── Step 2: Save normalised WAV for Whisper ──────────────────────────
      // FFmpeg.saveNormalizedAudio() already retries internally (up to 3 attempts)
      try {
        logger.debug({ ...sceneCtx, tempWavPath }, "Saving normalised WAV");
        await this.ffmpeg.saveNormalizedAudio(audioStream, tempWavPath);
        const wavStat = fs.statSync(tempWavPath);
        logger.debug(
          { ...sceneCtx, tempWavPath, fileSizeBytes: wavStat.size },
          "Normalised WAV saved",
        );
      } catch (err: unknown) {
        logger.error(
          {
            ...sceneCtx,
            tempWavPath,
            err: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          "Failed to save normalised WAV — this is unrecoverable, re-throwing",
        );
        throw err;
      }

      // ── Step 3: Whisper captioning — with empty-caption fallback ─────────
      // Whisper.CreateCaption() already retries internally (up to 3 attempts)
      let captions;
      try {
        logger.debug({ ...sceneCtx, tempWavPath }, "Running Whisper captioning");
        captions = await this.whisper.CreateCaption(tempWavPath);
        logger.debug(
          { ...sceneCtx, captionCount: captions.length },
          "Whisper captioning complete",
        );
      } catch (err: unknown) {
        // All Whisper retries exhausted — degrade gracefully with empty captions
        logger.warn(
          {
            ...sceneCtx,
            tempWavPath,
            err: err instanceof Error ? err.message : String(err),
          },
          "Whisper captioning failed after all retries — using empty captions fallback",
        );
        captions = [];
      }

      // ── Step 4: Save MP3 for Remotion ────────────────────────────────────
      // FFmpeg.saveToMp3() already retries internally with codec fallbacks
      try {
        logger.debug({ ...sceneCtx, tempMp3Path }, "Saving MP3 audio");
        await this.ffmpeg.saveToMp3(audioStream, tempMp3Path);
        const mp3Stat = fs.statSync(tempMp3Path);
        logger.debug(
          { ...sceneCtx, tempMp3Path, fileSizeBytes: mp3Stat.size },
          "MP3 audio saved",
        );
      } catch (err: unknown) {
        logger.error(
          {
            ...sceneCtx,
            tempMp3Path,
            err: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          "Failed to save MP3 audio — this is unrecoverable, re-throwing",
        );
        throw err;
      }

      // ── Step 5: Find Pexels video ────────────────────────────────────────
      // PexelsAPI.findVideo() already has its own retry/fallback-term logic
      let video: { url: string; id: string };
      try {
        logger.debug(
          { ...sceneCtx, audioLength, excludeVideoIds },
          "Searching Pexels for video",
        );
        video = await this.pexelsApi.findVideo(
          scene.searchTerms,
          audioLength,
          excludeVideoIds,
          orientation,
        );
        logger.debug(
          { ...sceneCtx, videoUrl: video.url, pexelsVideoId: video.id },
          "Pexels video found",
        );
      } catch (err: unknown) {
        logger.error(
          {
            ...sceneCtx,
            searchTerms: scene.searchTerms,
            audioLength,
            err: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          "Pexels video search failed — this is unrecoverable, re-throwing",
        );
        throw err;
      }

      // ── Step 6: Download Pexels video — with per-attempt retry ───────────
      // On each download failure we fetch a fresh video URL from Pexels so we
      // are not retrying the same potentially-expired CDN link.
      let downloadedVideoId = video.id;
      {
        let downloadAttempt = 0;
        let currentVideo = video;
        let downloadSuccess = false;
        const downloadExcludeIds = [...excludeVideoIds];

        while (downloadAttempt < PEXELS_DOWNLOAD_MAX_ATTEMPTS) {
          downloadAttempt++;
          logger.debug(
            { ...sceneCtx, videoUrl: currentVideo.url, tempVideoPath, downloadAttempt },
            "Downloading Pexels video",
          );

          try {
            // Remove any partial file from a previous failed attempt
            try {
              if (fs.existsSync(tempVideoPath)) fs.removeSync(tempVideoPath);
            } catch (_) {}

            await new Promise<void>((resolve, reject) => {
              const fileStream = fs.createWriteStream(tempVideoPath);
              https
                .get(currentVideo.url, (response: http.IncomingMessage) => {
                  if (response.statusCode !== 200) {
                    const dlErr = new Error(
                      `Failed to download Pexels video: HTTP ${response.statusCode} from ${currentVideo.url}`,
                    );
                    logger.error(
                      {
                        ...sceneCtx,
                        videoUrl: currentVideo.url,
                        statusCode: response.statusCode,
                        downloadAttempt,
                      },
                      dlErr.message,
                    );
                    reject(dlErr);
                    return;
                  }

                  response.pipe(fileStream);

                  fileStream.on("finish", () => {
                    fileStream.close();
                    try {
                      const dlStat = fs.statSync(tempVideoPath);
                      if (dlStat.size === 0) {
                        return reject(
                          new Error(
                            `Downloaded Pexels video is empty (0 bytes): ${tempVideoPath}`,
                          ),
                        );
                      }
                      logger.debug(
                        {
                          ...sceneCtx,
                          tempVideoPath,
                          fileSizeBytes: dlStat.size,
                          downloadAttempt,
                        },
                        "Pexels video downloaded successfully",
                      );
                      resolve();
                    } catch (statErr: unknown) {
                      reject(statErr);
                    }
                  });

                  fileStream.on("error", (streamErr: Error) => {
                    logger.error(
                      {
                        ...sceneCtx,
                        tempVideoPath,
                        err: streamErr.message,
                        downloadAttempt,
                      },
                      "File stream error while downloading Pexels video",
                    );
                    fs.unlink(tempVideoPath, () => {});
                    reject(streamErr);
                  });
                })
                .on("error", (err: Error) => {
                  logger.error(
                    {
                      ...sceneCtx,
                      videoUrl: currentVideo.url,
                      tempVideoPath,
                      err: err.message,
                      downloadAttempt,
                    },
                    "HTTPS request error downloading Pexels video",
                  );
                  fs.unlink(tempVideoPath, () => {});
                  reject(err);
                });
            });

            downloadedVideoId = currentVideo.id;
            downloadSuccess = true;
            break; // download succeeded
          } catch (dlErr: unknown) {
            logger.warn(
              {
                ...sceneCtx,
                videoUrl: currentVideo.url,
                downloadAttempt,
                maxAttempts: PEXELS_DOWNLOAD_MAX_ATTEMPTS,
                err: dlErr instanceof Error ? dlErr.message : String(dlErr),
              },
              "Pexels video download failed — will try a different video",
            );

            if (downloadAttempt < PEXELS_DOWNLOAD_MAX_ATTEMPTS) {
              // Exclude the failed video and search for a fresh one
              downloadExcludeIds.push(currentVideo.id);
              const delayMs = 1000 * downloadAttempt;
              await sleep(delayMs);
              try {
                currentVideo = await this.pexelsApi.findVideo(
                  scene.searchTerms,
                  audioLength,
                  downloadExcludeIds,
                  orientation,
                );
                logger.debug(
                  { ...sceneCtx, newVideoUrl: currentVideo.url, downloadAttempt },
                  "Found replacement Pexels video for retry",
                );
              } catch (searchErr: unknown) {
                logger.error(
                  {
                    ...sceneCtx,
                    err: searchErr instanceof Error ? searchErr.message : String(searchErr),
                    downloadAttempt,
                  },
                  "Could not find replacement Pexels video — giving up on download retries",
                );
                break;
              }
            }
          }
        }

        if (!downloadSuccess) {
          throw new Error(
            `Failed to download a Pexels video for scene ${index} after ${PEXELS_DOWNLOAD_MAX_ATTEMPTS} attempts`,
          );
        }
      }

      excludeVideoIds.push(downloadedVideoId);

      scenes.push({
        captions,
        video: `http://localhost:${this.config.port}/api/tmp/${tempVideoFileName}`,
        audio: {
          url: `http://localhost:${this.config.port}/api/tmp/${tempMp3FileName}`,
          duration: audioLength,
        },
      });

      totalDuration += audioLength;
      index++;
      logger.info(
        { ...sceneCtx, totalDuration },
        "Scene processed successfully",
      );
    }

    if (config.paddingBack) {
      totalDuration += config.paddingBack / 1000;
    }

    const selectedMusic = this.findMusic(totalDuration, config.music);
    logger.info(
      { videoId, selectedMusic, totalDuration },
      "Selected music for the video",
    );

    // ── Step 7: Remotion render with timeout ─────────────────────────────
    // Remotion.render() already retries internally with degraded settings
    logger.info(
      {
        videoId,
        totalDuration,
        sceneCount: scenes.length,
        timeoutMs: RENDER_TIMEOUT_MS,
      },
      "Starting Remotion render",
    );

    const renderPayload = {
      music: selectedMusic,
      scenes,
      config: {
        durationMs: totalDuration * 1000,
        paddingBack: config.paddingBack,
        ...{
          captionBackgroundColor: config.captionBackgroundColor,
          captionPosition: config.captionPosition,
        },
        musicVolume: config.musicVolume,
      },
    };

    try {
      await Promise.race([
        this.remotion.render(renderPayload, videoId, orientation),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  `Remotion render timed out after ${RENDER_TIMEOUT_MS / 1000}s for videoId=${videoId}`,
                ),
              ),
            RENDER_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (err: unknown) {
      logger.error(
        {
          videoId,
          totalDuration,
          sceneCount: scenes.length,
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        "Remotion render failed",
      );
      throw err;
    }


    // ── Step 8: Verify final output file ────────────────────────────────
    const finalOutputPath = this.getVideoPath(videoId);
    if (!fs.existsSync(finalOutputPath)) {
      const missingErr = new Error(
        `Render pipeline completed but final video file is missing: ${finalOutputPath}`,
      );
      logger.error(
        { videoId, finalOutputPath },
        missingErr.message,
      );
      throw missingErr;
    }
    const finalStat = fs.statSync(finalOutputPath);
    if (finalStat.size === 0) {
      const emptyErr = new Error(
        `Render pipeline completed but final video file is empty (0 bytes): ${finalOutputPath}`,
      );
      logger.error(
        { videoId, finalOutputPath, fileSizeBytes: finalStat.size },
        emptyErr.message,
      );
      throw emptyErr;
    }
    logger.info(
      { videoId, finalOutputPath, fileSizeBytes: finalStat.size },
      "Final video file verified — render pipeline complete",
    );

    // ── Cleanup temp files ───────────────────────────────────────────────
    for (const file of tempFiles) {
      try {
        fs.removeSync(file);
        logger.debug({ videoId, file }, "Temp file removed");
      } catch (cleanupErr: unknown) {
        // Non-fatal: log but don't fail the render
        logger.warn(
          {
            videoId,
            file,
            err:
              cleanupErr instanceof Error
                ? cleanupErr.message
                : String(cleanupErr),
          },
          "Failed to remove temp file (non-fatal)",
        );
      }
    }

    return videoId;
  }

  public getVideoPath(videoId: string): string {
    return path.join(this.config.videosDirPath, `${videoId}.mp4`);
  }

  public deleteVideo(videoId: string): void {
    const videoPath = this.getVideoPath(videoId);
    fs.removeSync(videoPath);
    logger.debug({ videoId }, "Deleted video file");
  }

  public getVideo(videoId: string): Buffer {
    const videoPath = this.getVideoPath(videoId);
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video ${videoId} not found`);
    }
    return fs.readFileSync(videoPath);
  }

  private findMusic(videoDuration: number, tag?: MusicMoodEnum): MusicForVideo {
    const musicFiles = this.musicManager.musicList().filter((music) => {
      if (tag) {
        return music.mood === tag;
      }
      return true;
    });
    return musicFiles[Math.floor(Math.random() * musicFiles.length)];
  }

  /**
   * Generates a minimal PCM WAV buffer containing `durationSeconds` of silence.
   * Used as a fallback when Kokoro TTS fails after all retries.
   */
  static createSilenceAudio(durationSeconds: number): {
    audio: ArrayBuffer;
    audioLength: number;
  } {
    const sampleRate = 16000;
    const numChannels = 1;
    const bitsPerSample = 16;
    const numSamples = Math.floor(sampleRate * durationSeconds);
    const dataSize = numSamples * numChannels * (bitsPerSample / 8);
    const buffer = Buffer.alloc(44 + dataSize, 0);

    // RIFF header
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write("WAVE", 8);
    // fmt chunk
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16); // chunk size
    buffer.writeUInt16LE(1, 20);  // PCM format
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28); // byte rate
    buffer.writeUInt16LE(numChannels * (bitsPerSample / 8), 32); // block align
    buffer.writeUInt16LE(bitsPerSample, 34);
    // data chunk
    buffer.write("data", 36);
    buffer.writeUInt32LE(dataSize, 40);
    // samples are already zero (silence)

    return {
      audio: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      audioLength: durationSeconds,
    };
  }


  public ListAvailableMusicTags(): MusicTag[] {
    const tags = new Set<MusicTag>();
    this.musicManager.musicList().forEach((music) => {
      tags.add(music.mood as MusicTag);
    });
    return Array.from(tags.values());
  }

  public listAllVideos(): { id: string; status: VideoStatus }[] {
    const videos: { id: string; status: VideoStatus }[] = [];

    // Check if videos directory exists
    if (!fs.existsSync(this.config.videosDirPath)) {
      return videos;
    }

    // Read all files in the videos directory
    const files = fs.readdirSync(this.config.videosDirPath);

    // Filter for MP4 files and extract video IDs
    for (const file of files) {
      if (file.endsWith(".mp4")) {
        const videoId = file.replace(".mp4", "");

        let status: VideoStatus = "ready";
        const inQueue = this.queue.find((item) => item.id === videoId);
        if (inQueue) {
          status = "processing";
        }

        videos.push({ id: videoId, status });
      }
    }

    // Add videos that are in the queue but not yet rendered
    for (const queueItem of this.queue) {
      const existingVideo = videos.find((v) => v.id === queueItem.id);
      if (!existingVideo) {
        videos.push({ id: queueItem.id, status: "processing" });
      }
    }

    return videos;
  }

  public ListAvailableVoices(): string[] {
    return this.kokoro.listAvailableVoices();
  }
}
