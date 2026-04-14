import z from "zod";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import path from "path";
import { ensureBrowser } from "@remotion/renderer";
import fs from "fs-extra";

import { Config } from "../../config";
import { shortVideoSchema } from "../../components/utils";
import { logger } from "../../logger";
import { OrientationEnum } from "../../types/shorts";
import { getOrientationConfig } from "../../components/utils";

export class Remotion {
  constructor(
    private bundled: string,
    private config: Config,
  ) {}

  static async init(config: Config): Promise<Remotion> {
    logger.info("Initializing Remotion: ensuring browser is available");
    try {
      await ensureBrowser();
      logger.info("Browser ensured for Remotion");
    } catch (err: unknown) {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        "Failed to ensure browser for Remotion (Chrome/Puppeteer unavailable)",
      );
      throw err;
    }

    const entryPoint = path.join(
      config.packageDirPath,
      config.devMode ? "src" : "dist",
      "components",
      "root",
      `index.${config.devMode ? "ts" : "js"}`,
    );

    logger.info({ entryPoint }, "Bundling Remotion entry point");
    let bundled: string;
    try {
      bundled = await bundle({ entryPoint });
      logger.info({ entryPoint, bundled }, "Remotion bundle created");
    } catch (err: unknown) {
      logger.error(
        {
          entryPoint,
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        "Failed to bundle Remotion entry point",
      );
      throw err;
    }

    return new Remotion(bundled, config);
  }

  async render(
    data: z.infer<typeof shortVideoSchema>,
    id: string,
    orientation: OrientationEnum,
  ) {
    const { component } = getOrientationConfig(orientation);
    const outputLocation = path.join(this.config.videosDirPath, `${id}.mp4`);

    logger.info(
      {
        videoID: id,
        component,
        orientation,
        outputLocation,
        sceneCount: data.scenes?.length ?? 0,
        durationMs: data.config?.durationMs,
      },
      "Starting Remotion render",
    );

    // Verify output directory exists and is writable before attempting render
    try {
      fs.ensureDirSync(this.config.videosDirPath);
      fs.accessSync(this.config.videosDirPath, fs.constants.W_OK);
      logger.debug(
        { videosDirPath: this.config.videosDirPath },
        "Output directory exists and is writable",
      );
    } catch (err: unknown) {
      logger.error(
        {
          videoID: id,
          videosDirPath: this.config.videosDirPath,
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        "Output directory is missing or not writable",
      );
      throw new Error(
        `Output directory is not writable: ${this.config.videosDirPath} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let composition;
    try {
      composition = await selectComposition({
        serveUrl: this.bundled,
        id: component,
        inputProps: data,
      });
      logger.debug(
        { videoID: id, component, compositionId: composition.id },
        "Remotion composition selected",
      );
    } catch (err: unknown) {
      logger.error(
        {
          videoID: id,
          component,
          serveUrl: this.bundled,
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        "Failed to select Remotion composition",
      );
      throw err;
    }

    try {
      await renderMedia({
        codec: "h264",
        composition,
        serveUrl: this.bundled,
        outputLocation,
        inputProps: data,
        onProgress: ({ progress }) => {
          logger.debug(
            { videoID: id, progressPct: Math.floor(progress * 100) },
            `Rendering ${id} ${Math.floor(progress * 100)}% complete`,
          );
        },
        // preventing memory issues with docker
        concurrency: this.config.concurrency,
        offthreadVideoCacheSizeInBytes: this.config.videoCacheSizeInBytes,
      });
    } catch (err: unknown) {
      logger.error(
        {
          videoID: id,
          component,
          outputLocation,
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        "Remotion renderMedia failed",
      );
      throw err;
    }

    // Verify the output file was actually created with non-zero size
    if (!fs.existsSync(outputLocation)) {
      const missingErr = new Error(
        `Remotion render completed but output file is missing: ${outputLocation}`,
      );
      logger.error(
        { videoID: id, outputLocation },
        missingErr.message,
      );
      throw missingErr;
    }

    const stat = fs.statSync(outputLocation);
    if (stat.size === 0) {
      const emptyErr = new Error(
        `Remotion render completed but output file is empty (0 bytes): ${outputLocation}`,
      );
      logger.error(
        { videoID: id, outputLocation, fileSizeBytes: stat.size },
        emptyErr.message,
      );
      throw emptyErr;
    }

    logger.info(
      {
        outputLocation,
        component,
        videoID: id,
        fileSizeBytes: stat.size,
      },
      "Video rendered successfully with Remotion",
    );
  }

  async testRender(outputLocation: string) {
    logger.info({ outputLocation }, "Starting Remotion test render");
    try {
      const composition = await selectComposition({
        serveUrl: this.bundled,
        id: "TestVideo",
      });

      await renderMedia({
        codec: "h264",
        composition,
        serveUrl: this.bundled,
        outputLocation,
        onProgress: ({ progress }) => {
          logger.debug(
            { progressPct: Math.floor(progress * 100) },
            `Rendering test video: ${Math.floor(progress * 100)}% complete`,
          );
        },
        // preventing memory issues with docker
        concurrency: this.config.concurrency,
        offthreadVideoCacheSizeInBytes: this.config.videoCacheSizeInBytes,
      });
      logger.info({ outputLocation }, "Remotion test render completed");
    } catch (err: unknown) {
      logger.error(
        {
          outputLocation,
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        "Remotion test render failed",
      );
      throw err;
    }
  }
}
