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
