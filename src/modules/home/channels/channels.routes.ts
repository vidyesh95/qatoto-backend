import express from "express";

import { attachOptionalUser } from "#src/middleware/attach-optional-user.js";
import { feedReadLimiter } from "#src/middleware/rate-limit.js";
import * as channelsController from "#src/modules/home/channels/channels.controller.js";

/**
 * The channel page (HOME_BACKEND_STRUCTURE.md §5.2e).
 *
 * MOUNTED AT `/channels`, a prefix no other router shares. Not on `creatorRouter`, which owns
 * `/creators/:creatorId/subscribe` and takes an ID — hanging a HANDLE off the same prefix would
 * put two identifier types on one path.
 *
 * `attachOptionalUser` BEFORE the limiter, as everywhere in this domain: the limiter's default
 * key prefers `req.user.id` and falls back to the IP, so running it first would drop every
 * signed-in viewer into the shared NAT bucket.
 *
 * `feedReadLimiter` on both, and they are the right shape for it — a public read that runs real
 * joins per call and that nothing caches. It is the same limiter `GET /feed/videos` and
 * `GET /feed/watch/:videoId` carry.
 *
 * ROUTE ORDER IS NOT LOAD-BEARING HERE — `/:handle` and `/:handle/videos` differ in depth, so
 * Express cannot confuse them. Declared shallow-first for readability only.
 */
const channelsRouter = express.Router();

/**
 * `GET /channels` — the opted-in directory the sitemap crawls.
 *
 * DECLARED BEFORE `/:handle` FOR READABILITY, NOT FOR CORRECTNESS: a bare `/` and a one-segment
 * `/:handle` differ in depth, so Express cannot confuse them the way it confuses `/mine` with an
 * id. Shallow-first is the convention this router already states.
 */
channelsRouter.get("/", attachOptionalUser, feedReadLimiter, channelsController.listPublicChannels);

channelsRouter.get("/:handle", attachOptionalUser, feedReadLimiter, channelsController.getChannel);

channelsRouter.get(
  "/:handle/videos",
  attachOptionalUser,
  feedReadLimiter,
  channelsController.listChannelVideos,
);

export default channelsRouter;
