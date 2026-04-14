/* eslint-disable @remotion/deterministic-randomness */
import { getOrientationConfig } from "../../components/utils";
import { logger } from "../../logger";
import { OrientationEnum, type Video } from "../../types/shorts";

const jokerTerms: string[] = ["nature", "globe", "space", "ocean"];
const durationBufferSeconds = 3;
const defaultTimeoutMs = 10000;
const retryTimes = 3;
// Exponential back-off base delay in ms between per-term retries
const retryBaseDelayMs = 500;

/** Returns true for errors that should abort all retries immediately (e.g. auth failures). */
function isFatalError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith("Invalid Pexels API key") ||
      error.message === "API key not set")
  );
}

/** Returns true when the error is an AbortSignal timeout. */
function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

/** Resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PexelsAPI {
  constructor(private API_KEY: string) {
    if (!API_KEY) {
      logger.warn(
        "PexelsAPI instantiated without an API key — video searches will fail. " +
          "Set the PEXELS_API_KEY environment variable.",
      );
    }
  }

  private async _findVideo(
    searchTerm: string,
    minDurationSeconds: number,
    excludeIds: string[],
    orientation: OrientationEnum,
    timeout: number,
  ): Promise<Video> {
    if (!this.API_KEY) {
      throw new Error("API key not set");
    }
    logger.debug(
      { searchTerm, minDurationSeconds, orientation },
      "Searching for video in Pexels API",
    );
    const headers = new Headers();
    headers.append("Authorization", this.API_KEY);

    let response: { videos?: unknown[] };
    try {
      const res = await fetch(
        `https://api.pexels.com/videos/search?orientation=${orientation}&size=medium&per_page=80&query=${encodeURIComponent(searchTerm)}`,
        {
          method: "GET",
          headers,
          redirect: "follow",
          signal: AbortSignal.timeout(timeout),
        },
      );

      if (!res.ok) {
        if (res.status === 401) {
          throw new Error(
            "Invalid Pexels API key - please make sure you get a valid key from https://www.pexels.com/api and set it in the environment variable PEXELS_API_KEY",
          );
        }
        if (res.status === 429) {
          throw new Error(
            `Pexels API rate limit exceeded (429) — too many requests. ` +
              `Slow down or upgrade your Pexels plan.`,
          );
        }
        throw new Error(
          `Pexels API returned HTTP ${res.status} ${res.statusText} for search term "${searchTerm}"`,
        );
      }

      response = (await res.json()) as { videos?: unknown[] };
    } catch (error: unknown) {
      if (isTimeoutError(error)) {
        logger.warn(
          { searchTerm, timeoutMs: timeout },
          "Pexels API request timed out",
        );
      } else {
        logger.error(
          {
            searchTerm,
            err: error instanceof Error ? error.message : String(error),
          },
          "Error fetching videos from Pexels API",
        );
      }
      throw error;
    }

    if (!response || typeof response !== "object") {
      throw new Error(
        `Pexels API returned an unexpected response format for search term "${searchTerm}"`,
      );
    }

    const videos = response.videos as
      | {
          id: string;
          duration: number;
          video_files: {
            fps: number;
            quality: string;
            width: number;
            height: number;
            id: string;
            link: string;
          }[];
        }[]
      | undefined;

    const { width: requiredVideoWidth, height: requiredVideoHeight } =
      getOrientationConfig(orientation);

    if (!videos || videos.length === 0) {
      logger.debug(
        { searchTerm, orientation },
        "No videos returned by Pexels API for this search term",
      );
      throw new Error("No videos found");
    }

    // find all the videos that fit the criteria, then select one randomly
    const filteredVideos = videos
      .map((video) => {
        if (excludeIds.includes(video.id)) {
          return;
        }
        if (!video.video_files || !video.video_files.length) {
          return;
        }

        // calculate the real duration of the video by converting the FPS to 25
        const fps = video.video_files[0].fps;
        const duration =
          fps < 25 ? video.duration * (fps / 25) : video.duration;

        if (duration >= minDurationSeconds + durationBufferSeconds) {
          for (const file of video.video_files) {
            if (
              file.quality === "hd" &&
              file.width === requiredVideoWidth &&
              file.height === requiredVideoHeight
            ) {
              return {
                id: video.id,
                url: file.link,
                width: file.width,
                height: file.height,
              };
            }
          }
        }
      })
      .filter(Boolean);

    if (!filteredVideos.length) {
      logger.debug(
        { searchTerm, minDurationSeconds, orientation },
        "No videos matched duration/resolution criteria in Pexels API response",
      );
      throw new Error("No videos found");
    }

    const video = filteredVideos[
      Math.floor(Math.random() * filteredVideos.length)
    ] as Video;

    logger.debug(
      { searchTerm, video: video, minDurationSeconds, orientation },
      "Found video from Pexels API",
    );

    return video;
  }

  async findVideo(
    searchTerms: string[],
    minDurationSeconds: number,
    excludeIds: string[] = [],
    orientation: OrientationEnum = OrientationEnum.portrait,
    timeout: number = defaultTimeoutMs,
    retryCounter: number = 0,
  ): Promise<Video> {
    if (!this.API_KEY) {
      throw new Error(
        "PEXELS_API_KEY is not set — cannot search for videos. " +
          "Please set the PEXELS_API_KEY environment variable.",
      );
    }

    // shuffle the search terms to randomize the search order
    const shuffledJokerTerms = jokerTerms.sort(() => Math.random() - 0.5);
    const shuffledSearchTerms = searchTerms.sort(() => Math.random() - 0.5);
    const allTerms = [...shuffledSearchTerms, ...shuffledJokerTerms];

    logger.debug(
      { searchTerms, minDurationSeconds, orientation, retryCounter },
      "Starting Pexels video search",
    );

    for (const searchTerm of allTerms) {
      try {
        return await this._findVideo(
          searchTerm,
          minDurationSeconds,
          excludeIds,
          orientation,
          timeout,
        );
      } catch (error: unknown) {
        // Fatal errors (bad API key, etc.) should propagate immediately — no point
        // trying other search terms.
        if (isFatalError(error)) {
          logger.error(
            { err: error instanceof Error ? error.message : String(error) },
            "Fatal Pexels API error — aborting video search",
          );
          throw error;
        }

        if (isTimeoutError(error)) {
          if (retryCounter < retryTimes) {
            const delayMs = retryBaseDelayMs * Math.pow(2, retryCounter);
            logger.warn(
              { searchTerm, retryCounter, nextRetryDelayMs: delayMs },
              "Pexels API timeout — retrying with exponential back-off",
            );
            await sleep(delayMs);
            return await this.findVideo(
              searchTerms,
              minDurationSeconds,
              excludeIds,
              orientation,
              timeout,
              retryCounter + 1,
            );
          }
          logger.error(
            { searchTerm, retryCounter, retryTimes },
            "Pexels API timeout — retry limit reached",
          );
          throw error;
        }

        // Non-fatal, non-timeout error (e.g. no matching videos for this term):
        // log at debug level and try the next search term.
        logger.debug(
          {
            searchTerm,
            err: error instanceof Error ? error.message : String(error),
          },
          "No suitable video for search term — trying next term",
        );
      }
    }

    logger.error(
      { searchTerms, minDurationSeconds, orientation },
      "Exhausted all search terms — no videos found in Pexels API",
    );
    throw new Error(
      `No videos found in Pexels API for search terms: ${searchTerms.join(", ")}`,
    );
  }
}
