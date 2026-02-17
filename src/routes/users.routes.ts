import express from "express";
import * as usersController from "#src/controllers/users.controller.js";

const router = express.Router();

/**
 * GET /users
 * List all users.
 */
router.get("/", usersController.getUsers);

/**
 * GET /users/:id
 * Get a single user by ID.
 */
router.get("/:id", usersController.getUserById);

export default router;
