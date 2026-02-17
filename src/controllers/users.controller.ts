import type { Request, Response } from "express";
import type { ApiResponse } from "#src/types/index.js";
import * as usersService from "#src/services/users.service.js";

/**
 * GET /users
 * List all users.
 */
export async function getUsers(
  req: Request,
  res: Response,
): Promise<void> {
  const users = await usersService.getAllUsers();
  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "Users retrieved successfully",
    data: users,
  };
  res.status(200).json(response);
}

/**
 * GET /users/:id
 * Get a single user by ID.
 */
export async function getUserById(
  req: Request,
  res: Response,
): Promise<void> {
  const id = req.params.id as string;
  const user = await usersService.getUserById(id);

  if (!user) {
    res.status(404).json({
      status: "error",
      statusCode: 404,
      message: `User with id '${id}' not found`,
    });
    return;
  }

  const response: ApiResponse = {
    status: "success",
    statusCode: 200,
    message: "User retrieved successfully",
    data: user,
  };
  res.status(200).json(response);
}
