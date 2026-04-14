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

export class ShortCreator {
  private queue: {
    sceneInput: SceneInput[];
    config: RenderConfig;
    id: string;
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
    const { sceneInput, config, id } = this.queue[0];
    logger.info(
      { videoId: id, sceneInput, config, queueLength: this.queue.length },
      "Processing video item in the queue",
    );
    try {
      await this.createShort(id, sceneInput, config);
      logger.info({ videoId: id }, "Video created successfully");
    } catch (error: unknown) {
      logger.error(
        {
          videoId: id,
          err: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        "Error creating video — item removed from queue",
      );
    } finally {
      this.queue.shift();
      this.processQueue();
    }
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

      // ── Step 1: TTS (Kokoro) ─────────────────────────────────────────────
      let audio: { audio: ArrayBuffer; audioLength: number };
      try {
        logger.debug({ ...sceneCtx, voice: config.voice }, "Generating TTS audio with Kokoro");
        audio = await this.kokoro.generate(
          scene.text,
          config.voice ?? "af_heart",
        );
        logger.debug(
          { ...sceneCtx, audioLength: audio.audioLength },
          "Kokoro TTS audio generated",
        );
      } catch (err: unknown) {
        logger.error(
          {
            ...sceneCtx,
            err: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          "Kokoro TTS generation failed",
        );
        throw err;
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
          "Failed to save normalised WAV",
        );
        throw err;
      }

      // ── Step 3: Whisper captioning ───────────────────────────────────────
      let captions;
      try {
        logger.debug({ ...sceneCtx, tempWavPath }, "Running Whisper captioning");
        captions = await this.whisper.CreateCaption(tempWavPath);
        logger.debug(
          { ...sceneCtx, captionCount: captions.length },
          "Whisper captioning complete",
        );
      } catch (err: unknown) {
        logger.error(
          {
            ...sceneCtx,
            tempWavPath,
            err: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          "Whisper captioning failed",
        );
        throw err;
      }

      // ── Step 4: Save MP3 for Remotion ────────────────────────────────────
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
          "Failed to save MP3 audio",
        );
        throw err;
      }

      // ── Step 5: Find Pexels video ────────────────────────────────────────
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
          "Pexels video search failed",
        );
        throw err;
      }

      // ── Step 6: Download Pexels video ────────────────────────────────────
      logger.debug(
        { ...sceneCtx, videoUrl: video.url, tempVideoPath },
        "Downloading Pexels video",
      );
      try {
        await new Promise<void>((resolve, reject) => {
          const fileStream = fs.createWriteStream(tempVideoPath);
          https
            .get(video.url, (response: http.IncomingMessage) => {
              if (response.statusCode !== 200) {
                const dlErr = new Error(
                  `Failed to download Pexels video: HTTP ${response.statusCode} from ${video.url}`,
                );
                logger.error(
                  {
                    ...sceneCtx,
                    videoUrl: video.url,
                    statusCode: response.statusCode,
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
                    const emptyErr = new Error(
                      `Downloaded Pexels video is empty (0 bytes): ${tempVideoPath}`,
                    );
                    logger.error(
                      { ...sceneCtx, tempVideoPath },
                      emptyErr.message,
                    );
                    return reject(emptyErr);
                  }
                  logger.debug(
                    {
                      ...sceneCtx,
                      tempVideoPath,
                      fileSizeBytes: dlStat.size,
                    },
                    "Pexels video downloaded successfully",
                  );
                  resolve();
                } catch (statErr: unknown) {
                  logger.error(
                    {
                      ...sceneCtx,
                      tempVideoPath,
                      err:
                        statErr instanceof Error
                          ? statErr.message
                          : String(statErr),
                    },
                    "Error verifying downloaded video file",
                  );
                  reject(statErr);
                }
              });

              fileStream.on("error", (streamErr: Error) => {
                logger.error(
                  {
                    ...sceneCtx,
                    tempVideoPath,
                    err: streamErr.message,
                    stack: streamErr.stack,
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
                  videoUrl: video.url,
                  tempVideoPath,
                  err: err.message,
                  stack: err.stack,
                },
                "HTTPS request error downloading Pexels video",
              );
              fs.unlink(tempVideoPath, () => {});
              reject(err);
            });
        });
      } catch (err: unknown) {
        logger.error(
          {
            ...sceneCtx,
            videoUrl: video.url,
            tempVideoPath,
            err: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          "Pexels video download failed",
        );
        throw err;
      }

      excludeVideoIds.push(video.id);

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
