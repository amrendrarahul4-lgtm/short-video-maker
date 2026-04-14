import express from "express";
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
} from "express";
import fs from "fs-extra";
import path from "path";

import { validateCreateShortInput } from "../validator";
import { ShortCreator } from "../../short-creator/ShortCreator";
import { logger } from "../../logger";
import { Config } from "../../config";

// todo abstract class
export class APIRouter {
  public router: express.Router;
  private shortCreator: ShortCreator;
  private config: Config;

  constructor(config: Config, shortCreator: ShortCreator) {
    this.config = config;
    this.router = express.Router();
    this.shortCreator = shortCreator;

    this.router.use(express.json());

    this.setupRoutes();
  }

  private setupRoutes() {
    this.router.post(
      "/short-video",
      async (req: ExpressRequest, res: ExpressResponse) => {
        try {
          const input = validateCreateShortInput(req.body);

          logger.info({ input }, "Creating short video");

          const videoId = this.shortCreator.addToQueue(
            input.scenes,
            input.config,
          );

          res.status(201).json({
            videoId,
          });
        } catch (error: unknown) {
          logger.error(error, "Error validating input");

          // Handle validation errors specifically
          if (error instanceof Error && error.message.startsWith("{")) {
            try {
              const errorData = JSON.parse(error.message);
              res.status(400).json({
                error: "Validation failed",
                message: errorData.message,
                missingFields: errorData.missingFields,
              });
              return;
            } catch (parseError: unknown) {
              logger.error(parseError, "Error parsing validation error");
            }
          }

          // Fallback for other errors
          res.status(400).json({
            error: "Invalid input",
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }
      },
    );

    this.router.get(
      "/short-video/:videoId/status",
      async (req: ExpressRequest, res: ExpressResponse) => {
        const { videoId } = req.params;
        if (!videoId) {
          res.status(400).json({
            error: "videoId is required",
          });
          return;
        }
        const status = this.shortCreator.status(videoId);
        res.status(200).json({
          status,
        });
      },
    );

    this.router.get(
      "/music-tags",
      (req: ExpressRequest, res: ExpressResponse) => {
        res.status(200).json(this.shortCreator.ListAvailableMusicTags());
      },
    );

    this.router.get("/voices", (req: ExpressRequest, res: ExpressResponse) => {
      res.status(200).json(this.shortCreator.ListAvailableVoices());
    });

    this.router.get(
      "/short-videos",
      (req: ExpressRequest, res: ExpressResponse) => {
        const videos = this.shortCreator.listAllVideos();
        res.status(200).json({
          videos,
        });
      },
    );

    this.router.delete(
      "/short-video/:videoId",
      (req: ExpressRequest, res: ExpressResponse) => {
        const { videoId } = req.params;
        if (!videoId) {
          res.status(400).json({
            error: "videoId is required",
          });
          return;
        }
        this.shortCreator.deleteVideo(videoId);
        res.status(200).json({
          success: true,
        });
      },
    );

    this.router.get(
      "/tmp/:tmpFile",
      (req: ExpressRequest, res: ExpressResponse) => {
        const { tmpFile } = req.params;
        if (!tmpFile) {
          res.status(400).json({
            error: "tmpFile is required",
          });
          return;
        }
        const tmpFilePath = path.join(this.config.tempDirPath, tmpFile);
        if (!fs.existsSync(tmpFilePath)) {
          res.status(404).json({
            error: "tmpFile not found",
          });
          return;
        }

        if (tmpFile.endsWith(".mp3")) {
          res.setHeader("Content-Type", "audio/mpeg");
        }
        if (tmpFile.endsWith(".wav")) {
          res.setHeader("Content-Type", "audio/wav");
        }
        if (tmpFile.endsWith(".mp4")) {
          res.setHeader("Content-Type", "video/mp4");
        }

        const tmpFileStream = fs.createReadStream(tmpFilePath);
        tmpFileStream.on("error", (error) => {
          logger.error(error, "Error reading tmp file");
          res.status(500).json({
            error: "Error reading tmp file",
            tmpFile,
          });
        });
        tmpFileStream.pipe(res);
      },
    );

    this.router.get(
      "/music/:fileName",
      (req: ExpressRequest, res: ExpressResponse) => {
        const { fileName } = req.params;
        if (!fileName) {
          res.status(400).json({
            error: "fileName is required",
          });
          return;
        }
        const musicFilePath = path.join(this.config.musicDirPath, fileName);
        if (!fs.existsSync(musicFilePath)) {
          res.status(404).json({
            error: "music file not found",
          });
          return;
        }
        const musicFileStream = fs.createReadStream(musicFilePath);
        musicFileStream.on("error", (error) => {
          logger.error(error, "Error reading music file");
          res.status(500).json({
            error: "Error reading music file",
            fileName,
          });
        });
        musicFileStream.pipe(res);
      },
    );

    this.router.get(
      "/short-video/:videoId",
      (req: ExpressRequest, res: ExpressResponse) => {
        const { videoId } = req.params;
        if (!videoId) {
          res.status(400).json({
            error: "videoId is required",
          });
          return;
        }

        const videoPath = this.shortCreator.getVideoPath(videoId);
        if (!fs.existsSync(videoPath)) {
          logger.warn(
            { videoId, videoPath },
            "Video file not found on disk",
          );
          res.status(404).json({
            error: "Video not found",
            videoId,
          });
          return;
        }

        try {
          const stat = fs.statSync(videoPath);
          res.setHeader("Content-Type", "video/mp4");
          res.setHeader("Content-Length", stat.size);
          res.setHeader(
            "Content-Disposition",
            `inline; filename=${videoId}.mp4`,
          );

          const videoStream = fs.createReadStream(videoPath);
          videoStream.on("error", (streamError: Error) => {
            logger.error(
              { videoId, videoPath, err: streamError.message },
              "Error streaming video file",
            );
            if (!res.headersSent) {
              res.status(500).json({ error: "Error streaming video" });
            }
          });
          videoStream.pipe(res);
        } catch (error: unknown) {
          logger.error(
            {
              videoId,
              videoPath,
              err: error instanceof Error ? error.message : String(error),
            },
            "Error getting video",
          );
          res.status(500).json({
            error: "Error getting video",
            videoId,
          });
        }
      },
    );
  }
}
