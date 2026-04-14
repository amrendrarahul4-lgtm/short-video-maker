/* eslint-disable @typescript-eslint/no-unused-vars */
import path from "path";
import fs from "fs-extra";

import { Kokoro } from "./short-creator/libraries/Kokoro";
import { Remotion } from "./short-creator/libraries/Remotion";
import { Whisper } from "./short-creator/libraries/Whisper";
import { FFMpeg } from "./short-creator/libraries/FFmpeg";
import { PexelsAPI } from "./short-creator/libraries/Pexels";
import { Config } from "./config";
import { ShortCreator } from "./short-creator/ShortCreator";
import { logger } from "./logger";
import { Server } from "./server/server";
import { MusicManager } from "./short-creator/music";



/**
 * Verifies that all external dependencies are reachable.
 * Returns a summary of which checks passed/failed without throwing.
 * The service starts in degraded mode if any check fails — it will keep
 * retrying in the background.
 */
async function runHealthChecks(
  kokoro: Kokoro,
  ffmpeg: FFMpeg,
  pexelsApi: PexelsAPI,
  remotion: Remotion,
  config: Config,
): Promise<{ allPassed: boolean; results: Record<string, boolean> }> {
  const results: Record<string, boolean> = {};

  // 1. FFmpeg — generate a tiny silence WAV
  try {
    const silence = ShortCreator.createSilenceAudio(0.1);
    const testWavPath = path.join(config.tempDirPath, `healthcheck-${Date.now()}.wav`);
    await ffmpeg.saveNormalizedAudio(silence.audio, testWavPath);
    fs.removeSync(testWavPath);
    results["ffmpeg"] = true;
    logger.info("Health check passed: FFmpeg");
  } catch (err: unknown) {
    results["ffmpeg"] = false;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Health check failed: FFmpeg",
    );
  }

  // 2. Kokoro TTS — generate a very short phrase
  try {
    await kokoro.generate("hi", "af_heart");
    results["kokoro"] = true;
    logger.info("Health check passed: Kokoro TTS");
  } catch (err: unknown) {
    results["kokoro"] = false;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Health check failed: Kokoro TTS",
    );
  }

  // 3. Pexels API — search for a short clip
  try {
    await pexelsApi.findVideo(["dog"], 2.4);
    results["pexels"] = true;
    logger.info("Health check passed: Pexels API");
  } catch (err: unknown) {
    results["pexels"] = false;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Health check failed: Pexels API",
    );
  }

  // 4. Remotion — test render
  try {
    const testVideoPath = path.join(config.tempDirPath, `healthcheck-${Date.now()}.mp4`);
    await remotion.testRender(testVideoPath);
    fs.rmSync(testVideoPath, { force: true });
    results["remotion"] = true;
    logger.info("Health check passed: Remotion test render");
  } catch (err: unknown) {
    results["remotion"] = false;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Health check failed: Remotion test render",
    );
  }

  const allPassed = Object.values(results).every(Boolean);
  return { allPassed, results };
}

async function main() {
  const config = new Config();
  try {
    config.ensureConfig();
  } catch (err: unknown) {
    logger.error(err, "Error in config");
    process.exit(1);
  }

  const musicManager = new MusicManager(config);
  try {
    logger.debug("checking music files");
    musicManager.ensureMusicFilesExist();
  } catch (error: unknown) {
    logger.error(error, "Missing music files");
    process.exit(1);
  }

  logger.debug("initializing remotion");
  const remotion = await Remotion.init(config);
  logger.debug("initializing kokoro");
  const kokoro = await Kokoro.init(config.kokoroModelPrecision);
  logger.debug("initializing whisper");
  const whisper = await Whisper.init(config);
  logger.debug("initializing ffmpeg");
  const ffmpeg = await FFMpeg.init();
  const pexelsApi = new PexelsAPI(config.pexelsApiKey);

  logger.debug("initializing the short creator");
  const shortCreator = new ShortCreator(
    config,
    remotion,
    kokoro,
    whisper,
    ffmpeg,
    pexelsApi,
    musicManager,
  );

  if (!config.runningInDocker) {
    // the project is running with npm - we need to check if the installation is correct
    if (fs.existsSync(config.installationSuccessfulPath)) {
      logger.info("the installation is successful - starting the server");
    } else {
      logger.info(
        "testing if the installation was successful - this may take a while...",
      );
      try {
        const audioBuffer = (await kokoro.generate("hi", "af_heart")).audio;
        await ffmpeg.createMp3DataUri(audioBuffer);
        await pexelsApi.findVideo(["dog"], 2.4);
        const testVideoPath = path.join(config.tempDirPath, "test.mp4");
        await remotion.testRender(testVideoPath);
        fs.rmSync(testVideoPath, { force: true });
        fs.writeFileSync(config.installationSuccessfulPath, "ok", {
          encoding: "utf-8",
        });
        logger.info("the installation was successful - starting the server");
      } catch (error: unknown) {
        logger.fatal(
          error,
          "The environment is not set up correctly - please follow the instructions in the README.md file https://github.com/gyoridavid/short-video-maker",
        );
        process.exit(1);
      }
    }
  } else {
    // Running in Docker — run health checks but start in degraded mode if any fail
    logger.info("Running in Docker — performing startup health checks");
    const { allPassed, results } = await runHealthChecks(
      kokoro,
      ffmpeg,
      pexelsApi,
      remotion,
      config,
    );

    if (allPassed) {
      logger.info({ results }, "All startup health checks passed");
    } else {
      logger.warn(
        { results },
        "Some startup health checks failed — starting in degraded mode. " +
          "The service will still accept requests; individual render steps " +
          "will retry automatically.",
      );
    }
  }

  logger.debug("initializing the server");
  const server = new Server(config, shortCreator);
  const app = server.start();

  // todo add shutdown handler
}

main().catch((error: unknown) => {
  logger.error(error, "Error starting server");
});
