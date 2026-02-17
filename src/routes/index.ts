import express from "express";
import type { Request, Response } from "express";
import type { ApiResponse } from "#src/types/index.js";

const router = express.Router();

/**
 * GET /
 * Health check / welcome route.
 */
router.get("/", (req: Request, res: Response) => {
  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Welcome to QAToto API",
  };
  res.status(200).json(response);
});

/**
 * GET /health
 * Health check endpoint for load balancers and monitoring.
 */
router.get("/health", (req: Request, res: Response) => {
  res.status(200).json({
    status: "success",
    statusCode: 200,
    message: "OK",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

export default router;
