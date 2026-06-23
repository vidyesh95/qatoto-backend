/**
 * Explicit success/failure union for predictable domain outcomes (CLAUDE.md §3.3).
 * Both branches must be handled at the call site; `throw` stays reserved for
 * unrecoverable faults.
 */
export type Result<T, E = Error> = { success: true; value: T } | { success: false; error: E };

/**
 * Standard API response envelope.
 */
export interface ApiResponse<T = unknown> {
  status: "success" | "error";
  statusCode: number;
  message: string;
  data?: T;
}

/**
 * Pagination metadata for list endpoints.
 */
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Paginated API response.
 */
export interface PaginatedResponse<T = unknown> extends ApiResponse<T[]> {
  pagination: PaginationMeta;
}
